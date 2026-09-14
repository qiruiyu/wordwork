/**
 * Thin bridge to the Tauri 2 Rust backend.
 *
 * Every capability has a browser fallback so `vite dev` still works for layout
 * work, but the shipped EXE always takes the native path (real file dialogs,
 * system Word/WPS launch and OS notifications).
 */

export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

interface InvokeFn {
  (command: string, args?: Record<string, unknown>): Promise<unknown>;
}

let invokeRef: InvokeFn | null = null;
let invokeLoading: Promise<InvokeFn | null> | null = null;

async function getInvoke(): Promise<InvokeFn | null> {
  if (!isTauri()) return null;
  if (invokeRef) return invokeRef;
  if (!invokeLoading) {
    invokeLoading = import('@tauri-apps/api/core')
      .then((mod) => {
        invokeRef = mod.invoke as unknown as InvokeFn;
        return invokeRef;
      })
      .catch(() => null);
  }
  return invokeLoading;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  const invoke = await getInvoke();
  if (!invoke) return null;
  return (await invoke(command, args)) as T;
}

/* ------------------------------------------------------------------ */
/* App state (server URL + session + working copies + offline queue)    */
/* ------------------------------------------------------------------ */

export async function loadState<T>(): Promise<T | null> {
  const native = await call<T | null>('load_state');
  if (native !== null) return native;
  try {
    const raw = localStorage.getItem('wordwork.state');
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function saveState(state: unknown): Promise<void> {
  const native = await call<boolean>('save_state', { state });
  if (native) return;
  try {
    localStorage.setItem('wordwork.state', JSON.stringify(state));
  } catch {
    /* storage full or unavailable; the session simply will not persist */
  }
}

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

export interface PickedFile {
  path: string;
  name: string;
  bytes: Uint8Array;
}

/** What `pick_docx` actually puts on the wire: file content base64-encoded. */
interface NativePickedFile {
  path: string;
  name: string;
  bytes: string;
}

export async function pickDocx(): Promise<PickedFile | null> {
  const native = await call<NativePickedFile | null>('pick_docx');
  if (native) {
    // `bytes` crosses the IPC boundary base64-encoded, exactly like `read_file`.
    return { path: native.path, name: native.name, bytes: fromBase64(native.bytes) };
  }
  return pickViaInput();
}

function pickViaInput(): Promise<PickedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.docx';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const bytes = new Uint8Array(await file.arrayBuffer());
      resolve({ path: file.name, name: file.name, bytes });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export async function pickSavePath(defaultName: string): Promise<string | null> {
  const native = await call<string | null>('pick_save_path', { defaultName });
  if (native !== null) return native;
  return defaultName;
}

export async function writeFile(path: string, bytes: Uint8Array): Promise<boolean> {
  const native = await call<boolean>('write_file', { path, bytes: toBase64(bytes) });
  if (native !== null) return native;
  const blob = new Blob([bytes as unknown as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  triggerDownload(blob, path.split(/[\\/]/).pop() || 'download.docx');
  return true;
}

export async function readFile(path: string): Promise<Uint8Array | null> {
  const encoded = await call<string | null>('read_file', { path });
  if (typeof encoded === 'string') return fromBase64(encoded);
  return null;
}

export async function removeFile(path: string): Promise<boolean> {
  const native = await call<boolean>('remove_file', { path });
  return native === true;
}

/**
 * Persist an immutable snapshot of a submission under `sha256`.
 *
 * Returns the path of the stored copy, or a `blob:` URL-style key in the browser
 * fallback (where there is no app data dir and the queue is session-only anyway).
 */
export async function saveSnapshot(namespace: string, sha256: string, bytes: Uint8Array): Promise<string> {
  const native = await call<string>('save_snapshot', { namespace, sha256, bytes: toBase64(bytes) });
  if (typeof native === 'string' && native) return native;
  const key = `memory://${namespace}/${sha256}`;
  memorySnapshots.set(key, bytes.slice());
  return key;
}

/** Browser-only stand-in for the app data directory. */
const memorySnapshots = new Map<string, Uint8Array>();

export async function snapshotBytes(path: string): Promise<Uint8Array | null> {
  if (path.startsWith('memory://')) return memorySnapshots.get(path) ?? null;
  return readFile(path);
}

/** Launch the document in the system default Word/WPS. */
export async function openWithSystem(path: string): Promise<boolean> {
  const native = await call<boolean>('open_with_system', { path });
  return native === true;
}

export async function notify(title: string, body: string): Promise<void> {
  await call('notify', { title, body });
}

export type WriteProbeState = 'writable' | 'locked' | 'missing_parent' | 'is_directory' | 'denied' | 'error';

/** Mirrors the Rust `WriteProbe` enum, including its `state` tag. */
export interface WriteProbe {
  state: WriteProbeState;
  message?: string;
}

/**
 * Wait for Word/WPS to release the target, then say why we stopped.
 *
 * The Rust side answers with a *reason*, not a boolean, so a missing folder or a
 * read-only file is not misreported as "Word has it open" — the failure mode a
 * brand-new download target used to hit, since a file that does not exist yet
 * made the probe return an error that was read as "still locked".
 */
export async function waitForWriteTarget(path: string, timeoutSeconds = 120): Promise<WriteProbe> {
  const native = await call<WriteProbe>('wait_for_write_target', { path, timeoutSeconds });
  return native ?? { state: 'writable' };
}

/** One line the user can act on, or `null` when the path really is writable. */
export function describeWriteProbe(probe: WriteProbe): string | null {
  switch (probe.state) {
    case 'writable':
      return null;
    case 'locked':
      return '文件正被 Word/WPS 占用，请关闭 Word/WPS 后重试。';
    case 'missing_parent':
      return '保存位置所在的文件夹不存在，请重新选择保存位置。';
    case 'is_directory':
      return '这个路径是一个文件夹，不能当作文件名保存。';
    case 'denied':
      return '没有写入权限：文件可能是只读的，或该位置受管理员保护。';
    default:
      return probe.message ? `无法写入该位置：${probe.message}` : '无法写入该位置。';
  }
}

/**
 * The single save path every download uses (工作副本 / 历史版本 / 红线稿).
 *
 * Returns `null` on success, or the reason it could not be written. Centralised
 * because each call site previously re-derived "is it locked?" on its own and
 * they all shared the same wrong answer.
 */
export async function saveDocument(path: string, bytes: Uint8Array): Promise<string | null> {
  const problem = describeWriteProbe(await waitForWriteTarget(path));
  if (problem) return problem;
  try {
    await writeFile(path, bytes);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function fileExists(path: string): Promise<boolean> {
  const native = await call<boolean>('file_exists', { path });
  return native === true;
}

function triggerDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
