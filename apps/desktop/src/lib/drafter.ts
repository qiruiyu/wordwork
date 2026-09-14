/**
 * Decide when a student's in-progress working copy is worth uploading as a draft.
 *
 * A draft is a "here is roughly where I am" snapshot, not a submission, so the goal
 * is to keep the server reasonably current without hammering it while the user is
 * still typing. Two rules do that:
 *
 * - the content must have been stable for `DRAFT_STABILITY_MS`, otherwise a
 *   mid-sentence file would be uploaded on every tick, and
 * - at most one draft per `DRAFT_MAX_INTERVAL_MS`, which bounds the load no matter
 *   how long the editing session runs.
 */

export const DRAFT_STABILITY_MS = 5 * 60 * 1000;
export const DRAFT_MAX_INTERVAL_MS = 10 * 60 * 1000;

export interface DraftInputs {
  /** Hash of the working copy right now, or null when it cannot be read. */
  currentSha: string | null;
  /** Hash of the last draft uploaded this round; null when none yet. */
  uploadedSha: string | null;
  /** Hash of the content we are currently watching, null until first read. */
  watchedSha: string | null;
  /** When `watchedSha` was first observed. */
  watchedAt: number;
  /** When the last draft was uploaded, 0 when never. */
  lastUploadAt: number;
  now: number;
}

export function shouldUploadDraft(inputs: DraftInputs): boolean {
  const { currentSha, uploadedSha, lastUploadAt, now } = inputs;
  // Null means the file is missing or Word has it open exclusively; neither is a
  // reason to upload, and the next tick will try again.
  if (!currentSha) return false;
  if (currentSha === uploadedSha) return false;
  if (now - inputs.watchedAt < DRAFT_STABILITY_MS) return false;
  if (lastUploadAt > 0 && now - lastUploadAt < DRAFT_MAX_INTERVAL_MS) return false;
  return true;
}
