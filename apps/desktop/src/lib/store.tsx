import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  accountKey,
  bucketOf,
  emptyState,
  migrateState,
  queueFor,
  totalOrphaned,
  withBucket,
  workingCopiesFor,
  type BucketedState,
} from './accounts';
import { ApiClient, ApiError, engineMismatchWarning, sha256Hex, validateServerUrl } from './api';
import { EventStream } from './events';
import { basename } from './format';
import * as native from './native';
import type { Member, QueuedSubmission, Session, WorkingCopy } from '../types';

type PersistedState = BucketedState;

/** Give up on a queued upload after this many consecutive failures. */
const MAX_QUEUE_ATTEMPTS = 8;

export interface EnqueueInput {
  roundId: number;
  baseVersionId: number;
  note: string;
  localPath: string;
  bytes: Uint8Array;
}

export interface Toast {
  id: number;
  tone: 'info' | 'success' | 'error';
  text: string;
  detail?: string[];
}

interface AppContextValue {
  ready: boolean;
  serverUrl: string;
  session: Session | null;
  member: Member | null;
  api: ApiClient;
  /** Only ever the signed-in member's own copies; never another account's. */
  workingCopies: WorkingCopy[];
  queue: QueuedSubmission[];
  toasts: Toast[];
  online: boolean;
  /**
   * Set when the server's DOCX engine does not match what the API requires, so the
   * UI can say so up front instead of failing at "完成审阅".
   */
  engineWarning: string | null;
  /** Legacy entries from a pre-v2 state file, held back until the user clears them. */
  orphanedCount: number;
  clearOrphaned: () => void;
  /** Bumped whenever the server reports something new; screens reload off this. */
  revision: number;
  setServerUrl: (url: string) => Promise<void>;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  changePassword: (current: string, next: string) => Promise<void>;
  upsertWorkingCopy: (copy: WorkingCopy) => void;
  removeWorkingCopy: (roundId: number, baseVersionId: number) => void;
  enqueueSubmission: (input: EnqueueInput) => Promise<void>;
  flushQueue: () => Promise<number>;
  pushToast: (tone: Toast['tone'], text: string, detail?: string[]) => void;
  dismissToast: (id: number) => void;
  describeError: (error: unknown) => string;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <AppProvider>');
  return value;
}

export function describeApiError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '发生未知错误';
}

/** Turn a server event into the one line a teammate needs to see, or nothing. */
export function describeEvent(event: { kind: string; payload?: unknown }): string | null {
  const payload = (event.payload ?? null) as { author?: string; actor?: string } | null;
  const who = payload?.actor ?? payload?.author;
  switch (event.kind) {
    case 'submission.created':
      return `${who ?? '有成员'}提交了修改`;
    case 'round.published':
      return '老师发布了新一轮协作';
    case 'round.published_result':
      return '本轮结果已发布';
    case 'round.published_manual_result':
      return '老师上传了人工合并结果';
    case 'review.needs_manual_merge':
      return '有一份提交含无法自动套用的改动，需要人工合并';
    case 'review.finalized':
      return '一份提交已完成审阅';
    case 'document.uploaded':
      return '项目里新增了文档';
    case 'document.replaced':
      return '项目主文档已替换为新版本';
    case 'comment.created':
      return '有新的评论';
    case 'member.added':
      return '项目新增了成员';
    default:
      return null;
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PersistedState>(emptyState);
  const [ready, setReady] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [online, setOnline] = useState(true);
  const [revision, setRevision] = useState(0);
  const [engineWarning, setEngineWarning] = useState<string | null>(null);
  const toastId = useRef(0);

  /**
   * The bucket every stored entry is filed under. `null` while nobody is signed in,
   * which is deliberate: with no account there is nothing to attribute state to, so
   * nothing is read, written or uploaded.
   */
  const memberKey = useMemo(
    () => accountKey(state.serverUrl, state.session?.member?.id),
    [state.serverUrl, state.session?.member?.id],
  );

  const pushToast = useCallback((tone: Toast['tone'], text: string, detail?: string[]) => {
    const id = ++toastId.current;
    setToasts((current) => [...current, { id, tone, text, detail }]);
    if (tone === 'success' || tone === 'info') {
      setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 6000);
    }
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const persist = useCallback((next: PersistedState) => {
    setState(next);
    void native.saveState(next);
  }, []);

  /* Load persisted state and revalidate the session against the server. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const loaded = await native.loadState<unknown>();
      if (cancelled) return;
      // A v1 file's copies and queue have no owner recorded, so they are held back
      // as orphaned rather than handed to whoever signs in next.
      const base = migrateState(loaded);
      setState(base);
      if (totalOrphaned(base.orphaned) > 0) {
        pushToast('info', '检测到旧版本留下的本地数据', [
          '升级前的「工作副本」和「待补传提交」没有记录属于哪个账号，为避免误当成别人的文件，已隔离并且不会自动上传。',
          '请重新下载工作副本并重新提交；确认不需要后可在顶部提示里清除。',
        ]);
      }
      setReady(true);
      if (base.serverUrl && base.session) {
        const client = new ApiClient(base.serverUrl, base.session.token);
        try {
          const member = await client.me();
          if (cancelled) return;
          setState((current) => {
            const next = { ...current, session: { token: current.session!.token, member } };
            void native.saveState(next);
            return next;
          });
          setOnline(true);
        } catch (error) {
          if (cancelled) return;
          if (error instanceof ApiError && error.kind === 'auth') {
            setState((current) => {
              const next = { ...current, session: null };
              void native.saveState(next);
              return next;
            });
            pushToast('error', '登录状态已失效，请重新登录');
          } else if (error instanceof ApiError && error.kind === 'network') {
            setOnline(false);
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pushToast]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  const api = useMemo(
    () => new ApiClient(state.serverUrl, state.session?.token ?? ''),
    [state.serverUrl, state.session?.token],
  );

  /**
   * Ask the server up front whether its DOCX engine matches what the API needs.
   *
   * Without this the mismatch only shows up as a 503 at "完成审阅", long after the
   * teacher has done the work. `status: degraded` on its own is not an error — the
   * old server does not report the field at all, and treating that as a mismatch
   * would block a perfectly healthy deployment.
   */
  useEffect(() => {
    if (!state.serverUrl) {
      setEngineWarning(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const health = await new ApiClient(state.serverUrl).health();
        if (!cancelled) setEngineWarning(engineMismatchWarning(health));
      } catch {
        /* unreachable servers are surfaced by the screens that need them */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.serverUrl, state.session?.token]);

  /**
   * Follow the server's event feed while signed in.
   *
   * The sequence number is kept in memory rather than persisted: replaying days-old
   * events as fresh notifications after a restart would be worse than missing them,
   * since every screen reloads its own data on mount anyway. The stream stops on a
   * 4401 close, which the server sends when the token is gone or a password change
   * is still pending — carrying on would just fail every request.
   */
  useEffect(() => {
    if (!state.serverUrl || !state.session) return;
    const stream = new EventStream({
      baseUrl: state.serverUrl,
      token: state.session.token,
      onChange: (events) => {
        setRevision((current) => current + 1);
        for (const event of events) {
          const text = describeEvent(event);
          if (text) pushToast('info', text);
        }
      },
      onAuthExpired: () => {
        setState((current) => {
          if (!current.session) return current;
          const next = { ...current, session: null };
          void native.saveState(next);
          return next;
        });
        pushToast('error', '登录状态已失效，请重新登录');
      },
    });
    stream.start();
    return () => stream.stop();
  }, [pushToast, state.serverUrl, state.session]);

  const setServerUrl = useCallback(
    async (url: string) => {
      const problem = validateServerUrl(url);
      if (problem) throw new Error(problem);
      const clean = url.trim().replace(/\/+$/, '');
      const probe = new ApiClient(clean);
      const health = await probe.health();
      // `degraded` still means "this is a wordwork server" — an engine mismatch must
      // be shown, not turned into a dead end that stops the user signing in at all.
      if (health.status !== 'ok' && health.status !== 'degraded') {
        throw new Error('该地址不是可用的 wordwork 服务器');
      }
      if (health.engine_available === false) {
        pushToast('error', '服务器已连接，但缺少 DOCX 处理组件，请联系管理员');
      }
      // Switching servers must also drop the in-memory session: the token belongs to
      // the old host, and the buckets keyed on it are not this account's.
      persist({ ...state, serverUrl: clean, session: null });
    },
    [persist, pushToast, state],
  );

  const signIn = useCallback(
    async (username: string, password: string) => {
      const result = await api.login(username, password);
      const next: PersistedState = {
        ...state,
        session: { token: result.access_token, member: result.member },
      };
      persist(next);
      setOnline(true);
      pushToast('success', `欢迎回来，${result.member.username}`);
    },
    [api, persist, pushToast, state],
  );

  const signOut = useCallback(async () => {
    try {
      if (state.session) await api.logout();
    } catch {
      /* the local session is cleared regardless of server reachability */
    }
    persist({ ...state, session: null });
  }, [api, persist, state]);

  const changePassword = useCallback(
    async (current: string, next: string) => {
      const member = await api.changePassword(current, next);
      persist({ ...state, session: state.session ? { token: state.session.token, member } : null });
      pushToast('success', '密码已修改');
    },
    [api, persist, pushToast, state],
  );

  /**
   * Record a working copy under the *current* account's bucket.
   *
   * Nothing is stored when no account is signed in: an unowned copy is what let the
   * next person to log in see — and open — someone else's document.
   */
  const upsertWorkingCopy = useCallback(
    (copy: WorkingCopy) => {
      if (!memberKey) return;
      setState((current) => {
        const mine = bucketOf(current.workingCopies, memberKey);
        const others = mine.filter((c) => !(c.roundId === copy.roundId && c.baseVersionId === copy.baseVersionId));
        const next = { ...current, workingCopies: withBucket(current.workingCopies, memberKey, [copy, ...others]) };
        void native.saveState(next);
        return next;
      });
    },
    [memberKey],
  );

  const removeWorkingCopy = useCallback(
    (roundId: number, baseVersionId: number) => {
      if (!memberKey) return;
      setState((current) => {
        const mine = bucketOf(current.workingCopies, memberKey);
        const next = {
          ...current,
          workingCopies: withBucket(
            current.workingCopies,
            memberKey,
            mine.filter((c) => !(c.roundId === roundId && c.baseVersionId === baseVersionId)),
          ),
        };
        void native.saveState(next);
        return next;
      });
    },
    [memberKey],
  );

  /**
   * Drop the legacy entries held back by the v1→v2 migration, along with any
   * snapshot files they still own. Only ever touches `orphaned`, so no live
   * account's queue can be destroyed by this.
   */
  const clearOrphaned = useCallback(() => {
    setState((current) => {
      const paths = current.orphaned.queue.map((item) => item.snapshotPath);
      const next = { ...current, orphaned: { workingCopies: [], queue: [] } };
      void native.saveState(next);
      void Promise.all(paths.map((path) => native.removeFile(path)));
      return next;
    });
    pushToast('success', '旧的本地数据已清除');
  }, [pushToast]);

  /**
   * Queue a submission that could not be uploaded.
   *
   * The bytes are copied into an immutable snapshot before the entry is persisted,
   * so the queued content cannot change if the user re-downloads the base version or
   * edits the working copy again. The hash is re-read and re-checked immediately so a
   * truncated snapshot is rejected here rather than silently uploaded later.
   */
  const enqueueSubmission = useCallback(
    async (input: EnqueueInput) => {
      if (!memberKey) {
        pushToast('error', '无法保存离线提交', ['请先登录后再提交。']);
        return;
      }
      const digest = await sha256Hex(input.bytes);
      const name = basename(input.localPath);
      try {
        // The snapshot is filed under the account bucket, so a different student
        // signing in on this machine cannot open, submit or delete it.
        const snapshotPath = await native.saveSnapshot(memberKey, digest, input.bytes);
        const stored = await native.snapshotBytes(snapshotPath);
        if (!stored || (await sha256Hex(stored)) !== digest) {
          pushToast('error', '无法保存离线提交快照', ['请保持网络后重新提交一次。']);
          return;
        }
        const item: QueuedSubmission = {
          id: `${Date.now()}-${digest.slice(0, 8)}`,
          owner: memberKey,
          roundId: input.roundId,
          baseVersionId: input.baseVersionId,
          note: input.note,
          snapshotPath,
          localPath: input.localPath,
          sha256: digest,
          attempts: 0,
          createdAt: new Date().toISOString(),
        };
        setState((current) => {
          const next = { ...current, queue: withBucket(current.queue, memberKey, [...bucketOf(current.queue, memberKey), item]) };
          void native.saveState(next);
          return next;
        });
        pushToast('info', '当前离线，已加入待补传队列', [`${name} 已安全保存，网络恢复后会自动上传。`]);
      } catch (error) {
        pushToast('error', '无法保存离线提交快照', [describeApiError(error)]);
      }
    },
    [memberKey, pushToast],
  );

  const flushing = useRef(false);

  const flushQueue = useCallback(async () => {
    // Single-flight: the "network is back" listener and the sign-in path can both
    // fire, and two passes over the same entry would upload it twice.
    if (flushing.current || !state.session || !memberKey) return 0;
    const mine = queueFor(state, memberKey);
    if (mine.length === 0) return 0;
    flushing.current = true;
    const client = new ApiClient(state.serverUrl, state.session.token);
    const remaining: QueuedSubmission[] = [];
    const obsolete: string[] = [];
    const dropped: Array<{ name: string; reason: string }> = [];
    let sent = 0;
    try {
      for (const item of mine) {
        const name = basename(item.localPath);
        if (item.owner !== memberKey) {
          // The bucket key and the recorded owner disagree, so these bytes belong to
          // somebody else. Uploading them now would file another member's work under
          // this account, which is worse than losing the queue entry.
          remaining.push(item);
          dropped.push({ name, reason: '这份待补传提交属于其他账号，已保留在原账号下' });
          continue;
        }
        const bytes = await native.snapshotBytes(item.snapshotPath);
        if (!bytes) {
          dropped.push({ name, reason: '本地快照已丢失' });
          continue;
        }
        if ((await sha256Hex(bytes)) !== item.sha256) {
          // The snapshot was altered or truncated. Uploading it would either be
          // rejected by the server's own hash check or, worse, succeed with the
          // wrong content — so drop it and tell the user.
          dropped.push({ name, reason: '快照内容与校验值不一致' });
          obsolete.push(item.snapshotPath);
          continue;
        }
        try {
          await client.submit(item.roundId, item.baseVersionId, name, bytes, item.note);
          sent += 1;
          obsolete.push(item.snapshotPath);
          pushToast('success', `离线提交已补传：${name}`);
        } catch (error) {
          if (error instanceof ApiError && error.kind === 'network') {
            const attempts = item.attempts + 1;
            if (attempts >= MAX_QUEUE_ATTEMPTS) {
              obsolete.push(item.snapshotPath);
              dropped.push({ name, reason: `连续 ${attempts} 次上传失败，已停止重试` });
            } else {
              remaining.push({ ...item, attempts });
            }
          } else {
            // 409 "already submitted" / "round closed" and validation errors are
            // terminal: retrying forever would just keep failing.
            obsolete.push(item.snapshotPath);
            dropped.push({ name, reason: describeApiError(error) });
          }
        }
      }
    } finally {
      flushing.current = false;
    }
    setState((current) => {
      const next = { ...current, queue: withBucket(current.queue, memberKey, remaining) };
      void native.saveState(next);
      return next;
    });
    for (const path of obsolete) await native.removeFile(path);
    for (const { name, reason } of dropped) pushToast('error', `离线提交补传失败：${name}`, [reason]);
    if (sent > 0) await native.notify('wordwork', `${sent} 份离线提交已补传`);
    return sent;
  }, [memberKey, pushToast, state, state.serverUrl, state.session]);

  /* Auto-retry the current account's queue when the network returns. */
  const myQueueLength = queueFor(state, memberKey).length;
  useEffect(() => {
    if (online && myQueueLength > 0 && state.session) void flushQueue();
  }, [online, myQueueLength, state.session, flushQueue]);

  const value: AppContextValue = {
    ready,
    serverUrl: state.serverUrl,
    session: state.session,
    member: state.session?.member ?? null,
    api,
    // Only the signed-in member's own bucket reaches the UI. Swapping accounts
    // therefore cannot show, open, monitor, submit or delete another account's work.
    workingCopies: workingCopiesFor(state, memberKey),
    queue: queueFor(state, memberKey),
    toasts,
    online,
    engineWarning,
    orphanedCount: totalOrphaned(state.orphaned),
    clearOrphaned,
    revision,
    setServerUrl,
    signIn,
    signOut,
    changePassword,
    upsertWorkingCopy,
    removeWorkingCopy,
    enqueueSubmission,
    flushQueue,
    pushToast,
    dismissToast,
    describeError: describeApiError,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
