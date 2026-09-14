import type {
  ApplyConflictView,
  CommentView,
  DiffPayload,
  DocumentSummary,
  HunkStatus,
  Member,
  MergeConflictView,
  OutstandingSubmission,
  ProjectDetail,
  ProjectSummary,
  Role,
  RoundDetail,
  RoundSummary,
  Submission,
  VersionSummary,
} from '../types';

export type ErrorKind =
  | 'network'
  | 'auth'
  | 'forbidden'
  | 'conflict'
  | 'validation'
  | 'password_change_required'
  | 'server';

/** The server refuses to call an accepted change "done" until a human resolves it. */
export const MANUAL_REVIEW_STATUS = 'manual_required';

/** A submission the teacher has dealt with; anything else blocks publishing the round. */
export const TERMINAL_SUBMISSION_STATUSES = ['reviewed', 'skipped', 'rejected'] as const;

export function isTerminalSubmission(status: string): boolean {
  return (TERMINAL_SUBMISSION_STATUSES as readonly string[]).includes(status);
}

/**
 * The submissions that still block publishing this round.
 *
 * Mirrors the server's own gate, so the button can be disabled before the teacher
 * clicks it — the 409 is the authority, this is just the affordance.
 */
export function outstandingOf(
  submissions: Array<{ id: number; author: string; status: string }>,
): OutstandingSubmission[] {
  return submissions
    .filter((s) => !isTerminalSubmission(s.status))
    .map((s) => ({ id: s.id, author: s.author, status: s.status }));
}

export class ApiError extends Error {
  kind: ErrorKind;
  status: number;
  detail: unknown;

  constructor(kind: ErrorKind, status: number, message: string, detail: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }

  /** Human readable extra lines for conflicts / validation payloads. */
  get detailLines(): string[] {
    const d = this.detail;
    if (!d || typeof d !== 'object') return [];
    const record = d as Record<string, unknown>;
    if (Array.isArray(record.errors)) return record.errors.map(String);
    if (Array.isArray((record as { detail?: unknown }).detail)) {
      return ((record as { detail: unknown[] }).detail).map((x) =>
        typeof x === 'object' && x ? String((x as { msg?: string }).msg ?? JSON.stringify(x)) : String(x),
      );
    }
    return [];
  }
}

export interface HealthInfo {
  status: string;
  name?: string;
  version?: string;
  engine_available?: boolean;
  /** The engine satisfies the contract the API is written against. */
  engine_compatible?: boolean;
  engine_version?: string | null;
  engine_contract?: number | null;
  engine_contract_required?: number;
  engine_file?: string | null;
  engine_problem?: string | null;
}

/**
 * The warning the client must show when the server's DOCX engine does not match
 * what the API expects, or `null` when everything lines up.
 *
 * The server refuses review endpoints with 503 in this state, so it has to be
 * visible before the teacher starts reviewing rather than as a mystery failure at
 * "完成审阅". `status` alone is not enough: an older server reports `ok` and says
 * nothing about the engine at all, which must not be treated as a mismatch.
 */
export function engineMismatchWarning(health: HealthInfo): string | null {
  if (health.engine_compatible === false) {
    const detail = [
      health.engine_version ? `引擎 ${health.engine_version}` : null,
      health.engine_contract != null ? `契约 ${health.engine_contract}` : null,
      health.engine_contract_required != null ? `需要 ${health.engine_contract_required}` : null,
    ].filter(Boolean).join(' / ');
    return `服务器上的 DOCX 引擎与 API 版本不匹配（${detail || '未知版本'}），审阅和发布都会失败，请联系管理员重新部署。`;
  }
  return null;
}

function normaliseBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export function validateServerUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return '请填写服务器地址';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return '地址格式不正确，请填写完整地址，例如 https://192.168.1.10:8443';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '只支持 https:// 开头的地址（本机调试可用 http://）';
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol === 'http:' && !local) return '正式服务器必须使用 https:// 加密连接';
  return null;
}

async function toError(response: Response): Promise<ApiError> {
  let detail: unknown = null;
  let text = '';
  try {
    text = await response.text();
    detail = text ? JSON.parse(text) : null;
  } catch {
    detail = text || null;
  }
  const message =
    detail && typeof detail === 'object' && typeof (detail as { detail?: unknown }).detail === 'string'
      ? String((detail as { detail: string }).detail)
      : detail && typeof detail === 'object' && (detail as { detail?: unknown }).detail
        ? conflictMessage((detail as { detail: unknown }).detail)
        : `服务器返回 ${response.status}`;

  const kind: ErrorKind =
    response.status === 401
      ? 'auth'
      : response.status === 403
        ? 'forbidden'
        : response.status === 409
          ? 'conflict'
          : response.status === 422
            ? 'validation'
            : response.status === 428
              ? 'password_change_required'
              : 'server';
  return new ApiError(kind, response.status, message, detail);
}

/** `409 {message, outstanding:[...]}` — publishing was refused because someone is unreviewed. */
export function outstandingFrom(error: unknown): OutstandingSubmission[] {
  if (!(error instanceof ApiError)) return [];
  const detail = error.detail as { detail?: { outstanding?: OutstandingSubmission[] } } | null;
  return detail?.detail?.outstanding ?? [];
}

/** `409 {message, conflicts:[...]}` — accepted changes that need a human merge. */
export function applyConflictsFrom(error: unknown): ApplyConflictView[] {
  if (!(error instanceof ApiError)) return [];
  const detail = error.detail as { detail?: { conflicts?: ApplyConflictView[] } } | null;
  return detail?.detail?.conflicts ?? [];
}

function conflictMessage(detail: unknown): string {
  if (detail && typeof detail === 'object' && typeof (detail as { message?: string }).message === 'string') {
    return (detail as { message: string }).message;
  }
  return '请求与服务器当前状态冲突';
}

export class ApiClient {
  baseUrl: string;
  token: string;

  constructor(baseUrl: string, token = '') {
    this.baseUrl = normaliseBaseUrl(baseUrl);
    this.token = token;
  }

  get downloadBase(): string {
    return this.baseUrl;
  }

  async health(): Promise<HealthInfo> {
    return this.raw<HealthInfo>('/healthz', { auth: false });
  }

  private async raw<T>(path: string, options: RequestInit & { auth?: boolean } = {}): Promise<T> {
    const { auth = true, ...init } = options;
    const headers = new Headers(init.headers);
    if (!(init.body instanceof FormData) && init.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (auth && this.token) headers.set('Authorization', `Bearer ${this.token}`);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    } catch (error) {
      throw new ApiError(
        'network',
        0,
        '无法连接服务器，请检查网络或服务器地址是否正确',
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    if (!response.ok) throw await toError(response);
    if (response.status === 204) return undefined as T;
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('application/json')) return (await response.text()) as unknown as T;
    return (await response.json()) as T;
  }

  /* ----------------------------- auth ----------------------------- */

  login(username: string, password: string) {
    return this.raw<{ access_token: string; token_type: string; member: Member }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
      auth: false,
    });
  }

  logout() {
    return this.raw<{ status: string }>('/auth/logout', { method: 'POST' });
  }

  me() {
    return this.raw<Member>('/me');
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<Member> {
    const result = await this.raw<{ status: string; member: Member }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
    return result.member;
  }

  /* --------------------------- projects --------------------------- */

  listProjects() {
    return this.raw<ProjectSummary[]>('/projects');
  }

  createProject(name: string) {
    return this.raw<{ id: number; name: string }>('/projects', { method: 'POST', body: JSON.stringify({ name }) });
  }

  getProject(projectId: number) {
    return this.raw<ProjectDetail>(`/projects/${projectId}`);
  }

  listMembers(projectId: number) {
    return this.raw<Member[]>(`/projects/${projectId}/members`);
  }

  addMember(projectId: number, username: string, password: string, role: Role) {
    return this.raw<Member>(`/projects/${projectId}/members`, {
      method: 'POST',
      body: JSON.stringify({ username, password, role }),
    });
  }

  /* -------------------------- documents --------------------------- */

  listDocuments(projectId: number) {
    return this.raw<DocumentSummary[]>(`/projects/${projectId}/documents`);
  }

  uploadDocument(projectId: number, filename: string, bytes: Uint8Array) {
    const body = new FormData();
    body.append('file', new Blob([bytes as unknown as BlobPart]), filename);
    return this.raw<{ id: number; version_id: number; sha256: string }>(`/projects/${projectId}/documents`, {
      method: 'POST',
      body,
    });
  }

  /**
   * Replace an existing document's file with a new immutable version.
   *
   * Uploading through `uploadDocument` instead would create a *second* Document, and every
   * round and version already hangs off the first one — so "替换主文档" would look like it
   * worked while the project quietly kept using the old file.
   */
  replaceDocumentVersion(documentId: number, filename: string, bytes: Uint8Array) {
    const body = new FormData();
    body.append('file', new Blob([bytes as unknown as BlobPart]), filename);
    return this.raw<{ document_id: number; version_id: number; sha256: string; current_version_id: number }>(
      `/documents/${documentId}/versions`,
      { method: 'POST', body },
    );
  }

  /* ---------------------------- rounds ---------------------------- */

  listRounds(projectId: number) {
    return this.raw<RoundSummary[]>(`/projects/${projectId}/rounds`);
  }

  createRound(projectId: number, documentId: number) {
    return this.raw<{ id: number; number: number; base_version_id: number; status: string }>(
      `/projects/${projectId}/rounds`,
      { method: 'POST', body: JSON.stringify({ document_id: documentId }) },
    );
  }

  publishRound(roundId: number) {
    return this.raw<{ id: number; status: string }>(`/rounds/${roundId}/publish`, { method: 'POST' });
  }

  getRound(roundId: number) {
    return this.raw<RoundDetail>(`/rounds/${roundId}`);
  }

  /* ------------------------- submissions -------------------------- */

  listSubmissions(roundId: number) {
    return this.raw<Submission[]>(`/rounds/${roundId}/submissions`);
  }

  async submit(roundId: number, baseVersionId: number, filename: string, bytes: Uint8Array, note: string) {
    const sha256 = await sha256Hex(bytes);
    const body = new FormData();
    body.append('base_version_id', String(baseVersionId));
    body.append('sha256', sha256);
    body.append('note', note);
    body.append('file', new Blob([bytes as unknown as BlobPart]), filename);
    return this.raw<{
      id: number;
      version_id: number;
      redline_version_id: number | null;
      status: string;
      job_id: number;
    }>(`/rounds/${roundId}/submissions`, { method: 'POST', body });
  }

  async uploadDraft(roundId: number, baseVersionId: number, filename: string, bytes: Uint8Array) {
    const sha256 = await sha256Hex(bytes);
    const body = new FormData();
    body.append('base_version_id', String(baseVersionId));
    body.append('sha256', sha256);
    body.append('file', new Blob([bytes as unknown as BlobPart]), filename);
    return this.raw<{ version_id: number; sha256: string }>(`/rounds/${roundId}/drafts`, { method: 'POST', body });
  }

  getDiff(submissionId: number) {
    return this.raw<DiffPayload>(`/submissions/${submissionId}/diff`);
  }

  decideHunk(submissionId: number, hunkId: number, decision: HunkStatus) {
    return this.raw<{ hunk_id: number; decision: HunkStatus }>(`/reviews/${submissionId}/hunks/${hunkId}`, {
      method: 'PATCH',
      body: JSON.stringify({ decision }),
    });
  }

  finalizeReview(submissionId: number) {
    return this.raw<{
      submission_id: number;
      status: string;
      resolved_version_id: number;
      warnings?: string[];
    }>(`/reviews/${submissionId}/finalize`, { method: 'POST' });
  }

  /** Mark a submission terminal without reviewing it, so the round can be published. */
  skipSubmission(submissionId: number, reason = '') {
    return this.raw<{ submission_id: number; status: string; note: string }>(
      `/submissions/${submissionId}/skip`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    );
  }

  listConflicts(roundId: number) {
    return this.raw<MergeConflictView[]>(`/rounds/${roundId}/conflicts`);
  }

  publishResult(roundId: number, conflictChoices: Record<string, string> = {}) {
    return this.raw<{
      round_id: number;
      status: string;
      version_id: number;
      summary_redline_version_id: number;
      resolution?: string;
      redline_warnings?: string[];
    }>(`/rounds/${roundId}/publish-result`, {
      method: 'POST',
      body: JSON.stringify({ conflict_choices: conflictChoices }),
    });
  }

  publishManualResult(roundId: number, filename: string, bytes: Uint8Array) {
    const body = new FormData();
    body.append('file', new Blob([bytes as unknown as BlobPart]), filename);
    return this.raw<{
      round_id: number;
      status: string;
      version_id: number;
      resolution?: string;
      redline_warnings?: string[];
    }>(`/rounds/${roundId}/manual-result`, {
      method: 'POST',
      body,
    });
  }

  /* --------------------------- versions --------------------------- */

  listVersions(documentId: number) {
    return this.raw<VersionSummary[]>(`/documents/${documentId}/versions`);
  }

  getVersion(versionId: number) {
    return this.raw<VersionSummary & { document_id: number; document_name: string; project_id: number; project_name: string }>(
      `/versions/${versionId}`,
    );
  }

  restoreVersion(versionId: number, documentId: number) {
    return this.raw<{ document_id: number; current_version_id: number }>(`/versions/${versionId}/restore`, {
      method: 'POST',
      body: JSON.stringify({ document_id: documentId }),
    });
  }

  async downloadVersion(versionId: number): Promise<{ bytes: Uint8Array; filename: string }> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/versions/${versionId}/download`, {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      });
    } catch (error) {
      throw new ApiError('network', 0, '下载失败，无法连接服务器', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (!response.ok) throw await toError(response);
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    const filename = match ? decodeURIComponent(match[1]) : `version-${versionId}.docx`;
    return { bytes: new Uint8Array(await response.arrayBuffer()), filename };
  }

  /* --------------------------- comments --------------------------- */

  listComments(submissionId: number) {
    return this.raw<CommentView[]>(`/submissions/${submissionId}/comments`);
  }

  addComment(submissionId: number, body: string) {
    return this.raw<CommentView>(`/submissions/${submissionId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  listEvents(after = 0) {
    return this.raw<Array<{ id: number; project_id: number | null; kind: string; payload: unknown; created_at: string }>>(
      `/events?after=${after}`,
    );
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
  const digest = await crypto.subtle.digest('SHA-256', view as ArrayBuffer);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
