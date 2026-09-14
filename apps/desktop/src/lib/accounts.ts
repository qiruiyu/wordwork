/**
 * Per-account bucketing for state that lives on one Windows user profile.
 *
 * The pilot runs several students through a single shared Windows login, so
 * "my working copy" cannot be a property of the machine — it has to be a property
 * of (server, member). Before this, student B saw student A's working copy in
 * "我的工作副本", complete with a "用 Word 打开" button pointing at A's file, and
 * the offline queue would have re-submitted A's bytes under B's name.
 *
 * The bucket key is deliberately derived from the server URL *and* the numeric
 * `member.id` rather than the username: usernames are only unique per server, and
 * a username can be re-created. `member.id` is the row the API authenticates.
 */

import type { QueuedSubmission, Session, WorkingCopy } from '../types';

/** Buckets are keyed by this; empty string means "no account, do not store". */
export type AccountKey = string;

/**
 * Canonicalise a server URL so `http://Host:8000/` and `http://host:8000` share a
 * bucket instead of forking the user's data on a stray slash or capital letter.
 *
 * Lower-casing is safe here: every supported deployment is scheme + host + port
 * (no domain, no case-sensitive path), so the path component carries no meaning.
 */
export function normalizeServerUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '').toLowerCase();
}

/** Filesystem-safe token for the snapshot namespace (no `:`, `/` or `|`). */
function serverToken(raw: string): string {
  const cleaned = normalizeServerUrl(raw)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  // Keep the tail: the distinguishing part of a URL is the host, not the scheme.
  return cleaned.slice(-48) || 'server';
}

/**
 * The bucket for one signed-in member on one server, or `null` when there is no
 * account to attribute anything to — storing under `null` is what let one person's
 * file be offered to the next person who logged in.
 */
export function accountKey(serverUrl: string, memberId: number | null | undefined): AccountKey | null {
  if (!memberId || !Number.isFinite(memberId)) return null;
  const server = normalizeServerUrl(serverUrl);
  if (!server) return null;
  return `${serverToken(server)}-m${memberId}`;
}

export type Buckets<T> = Record<string, T[]>;

export function bucketOf<T>(buckets: Buckets<T> | undefined, key: AccountKey | null): T[] {
  if (!key) return [];
  return buckets?.[key] ?? [];
}

export function withBucket<T>(buckets: Buckets<T> | undefined, key: AccountKey, items: T[]): Buckets<T> {
  return { ...(buckets ?? {}), [key]: items };
}

/** Working copies belonging to `key`, newest first. */
export function workingCopiesFor(state: { workingCopies: Buckets<WorkingCopy> }, key: AccountKey | null): WorkingCopy[] {
  return bucketOf(state.workingCopies, key);
}

/** Queue entries belonging to `key`. */
export function queueFor(state: { queue: Buckets<QueuedSubmission> }, key: AccountKey | null): QueuedSubmission[] {
  return bucketOf(state.queue, key);
}

/**
 * Entries recovered from a pre-v2 state file, which stored one global list with no
 * record of who created it.
 *
 * They must not be handed to whoever logs in next: that is exactly the bug this
 * migration exists to stop. The user is told they exist and can clear them; the
 * underlying files are left on disk until they do.
 */
export interface Orphaned {
  workingCopies: WorkingCopy[];
  queue: QueuedSubmission[];
}

export function totalOrphaned(orphaned: Orphaned | undefined): number {
  if (!orphaned) return 0;
  return orphaned.workingCopies.length + orphaned.queue.length;
}

/* ------------------------------------------------------------------ */
/* Migration                                                           */
/* ------------------------------------------------------------------ */

/** The state shape every client version has written to disk. */
export interface BucketedState {
  version: number;
  serverUrl: string;
  session: Session | null;
  workingCopies: Buckets<WorkingCopy>;
  queue: Buckets<QueuedSubmission>;
  orphaned: Orphaned;
}

export const STATE_VERSION = 2;

export function emptyState(): BucketedState {
  return {
    version: STATE_VERSION,
    serverUrl: '',
    session: null,
    workingCopies: {},
    queue: {},
    orphaned: { workingCopies: [], queue: [] },
  };
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Bring an on-disk state file up to `STATE_VERSION` **without ever guessing who
 * owns a legacy entry**.
 *
 * v1 kept one global `workingCopies` / `queue` list with no account on the entries.
 * The obvious migration — hand them to whoever is signed in — reproduces the exact
 * bug being fixed: the persisted session is the *last* login, not necessarily the
 * author, so student B would inherit A's file. Instead they land in `orphaned`,
 * which nothing reads, opens, monitors or uploads, and the UI asks the user to
 * re-download and re-submit. Working copies are cheap to recreate; mis-attributing
 * a submission is not.
 *
 * Anything unrecognised (no version, a future version, a corrupt file) yields a
 * clean empty state rather than a half-populated one.
 */
export function migrateState(raw: unknown): BucketedState {
  if (!raw || typeof raw !== 'object') return emptyState();
  const stored = raw as Record<string, unknown>;
  if (stored.version !== 1 && stored.version !== STATE_VERSION) return emptyState();

  const base = emptyState();
  const session = (stored.session ?? null) as Session | null;
  const serverUrl = typeof stored.serverUrl === 'string' ? stored.serverUrl : '';

  if (stored.version === STATE_VERSION) {
    return {
      version: STATE_VERSION,
      serverUrl,
      session,
      workingCopies: (stored.workingCopies ?? {}) as Buckets<WorkingCopy>,
      queue: (stored.queue ?? {}) as Buckets<QueuedSubmission>,
      orphaned: (stored.orphaned ?? base.orphaned) as Orphaned,
    };
  }

  return {
    ...base,
    serverUrl,
    session,
    orphaned: {
      workingCopies: asArray<WorkingCopy>(stored.workingCopies),
      queue: asArray<QueuedSubmission>(stored.queue),
    },
  };
}
