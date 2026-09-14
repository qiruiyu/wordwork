export type Role = 'teacher' | 'student';
export type HunkStatus = 'pending' | 'accepted' | 'rejected';
export type RoundStatus = 'draft' | 'open' | 'reviewing' | 'published';
/** `reviewed` / `skipped` / `rejected` are the states that let a round be published. */
export type SubmissionStatus =
  | 'ready_for_review'
  | 'reviewed'
  | 'skipped'
  | 'rejected'
  | 'manual_required'
  | 'diff_failed';

export interface Member {
  id: number;
  username: string;
  role: Role;
  must_change_password?: boolean;
}

export interface ProjectSummary {
  id: number;
  name: string;
  documents: number;
  members: number;
  is_owner: boolean;
  active_round_id: number | null;
  active_round_number: number | null;
  created_at: string | null;
}

export interface DocumentSummary {
  id: number;
  name: string;
  current_version_id: number | null;
}

export interface ProjectDetail {
  id: number;
  name: string;
  owner_id: number;
  is_owner: boolean;
  created_at: string | null;
  members: Member[];
  documents: DocumentSummary[];
}

export interface RoundSummary {
  id: number;
  document_id: number;
  number: number;
  base_version_id: number;
  status: RoundStatus;
  submission_count: number;
  created_at: string | null;
}

export interface RoundDetail {
  id: number;
  number: number;
  status: RoundStatus;
  document_id: number;
  document_name: string;
  project_id: number;
  project_name: string;
  base_version_id: number;
  base_version_name: string | null;
  created_at: string | null;
}

/** A submission the server refuses to publish over, with who it belongs to. */
export interface OutstandingSubmission {
  id: number;
  author: string | null;
  status: string;
}

/** An accepted change the engine would not apply on its own. */
export interface ApplyConflictView {
  match_key: string;
  part: string;
  anchor: string;
  kind: string;
  reason: string;
  detail?: string;
  hunk_ids?: string[];
}

export interface Hunk {
  id: number;
  anchor: string;
  risk: string;
  decision: HunkStatus;
  operation: string;
  before: string;
  after: string;
  context_before: string;
  context_after: string;
  author: string;
  part: string;
}

export interface Submission {
  id: number;
  author: string;
  author_id: number;
  created_at: string | null;
  note: string;
  status: SubmissionStatus | string;
  version_id: number;
  redline_version_id: number | null;
  resolved_version_id: number | null;
  redline_warnings: string[];
}

export interface DiffPayload {
  submission_id: number;
  status: string;
  note: string;
  redline_version_id: number | null;
  resolved_version_id: number | null;
  redline_warnings: string[];
  engine_available: boolean;
  hunks: Hunk[];
}

export interface MergeConflictView {
  id: number;
  anchor: string;
  status: string;
  resolution: string | null;
  conflict_id?: string;
  part?: string;
  base_text?: string;
  current_text?: string;
  incoming_text?: string;
  current_author?: string;
  incoming_author?: string;
  reason?: string;
}

export interface VersionSummary {
  id: number;
  parent_id: number | null;
  sha256: string;
  display_name: string;
  kind: string;
  author: string | null;
  created_at: string | null;
  current: boolean;
  size_bytes: number | null;
}

export interface CommentView {
  id: number;
  author: string;
  body: string;
  created_at: string | null;
}

export interface Session {
  token: string;
  member: Member;
}

export interface WorkingCopy {
  projectId: number;
  projectName: string;
  roundId: number;
  roundNumber: number;
  documentId: number;
  baseVersionId: number;
  baseVersionName: string;
  localPath: string;
  sha256: string;
  updatedAt: string;
}

export interface QueuedSubmission {
  id: string;
  /**
   * The account bucket this entry belongs to.
   *
   * Kept on the entry as well as in the bucket key so the upload loop can re-check
   * it against the live session: if the two disagree the bytes must not be
   * uploaded, because they would be attributed to the wrong member.
   */
  owner: string;
  roundId: number;
  baseVersionId: number;
  note: string;
  /** Immutable copy of the submitted bytes, stored under the app data dir. */
  snapshotPath: string;
  /** The file the user edited; kept for display only, never read back on retry. */
  localPath: string;
  sha256: string;
  /** Failed attempts so far. The queue stops retrying a doomed upload eventually. */
  attempts: number;
  createdAt: string;
}
