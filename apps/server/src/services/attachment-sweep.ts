import type { Database } from "../db.js";
import type { AttachmentStore } from "./attachment-store.js";

/**
 * Removes uploads nobody ever sent.
 *
 * Picking a file and then changing your mind is normal, and every one of those
 * leaves a row and a file behind. Without this they accumulate for the life of
 * the deployment — the kind of slow leak that is discovered when a disk fills
 * up on a Sunday.
 *
 * An hour is long enough that no plausible "upload, then keep typing" is cut
 * short, and short enough that a mistake is not stored for a day.
 */
export const UNCLAIMED_ATTACHMENT_TTL = "1 hour";

export interface SweepResult {
  removed: number;
  /** Rows deleted whose file could not be removed. Logged, never fatal. */
  failed: number;
}

export async function sweepUnclaimedAttachments(
  db: Database,
  store: AttachmentStore,
): Promise<SweepResult> {
  /**
   * The row is deleted first and the file second.
   *
   * That order can leave a file with no row, which the next sweep will not
   * find — a wasted block on disk. The other order can leave a row pointing at
   * a deleted file, which is a download that fails forever. Given a choice
   * between wasting space and breaking a link, waste the space.
   */
  const { rows } = await db.query<{ storage_key: string }>(
    `DELETE FROM message_attachments
      WHERE message_id IS NULL
        AND created_at < now() - $1::interval
      RETURNING storage_key`,
    [UNCLAIMED_ATTACHMENT_TTL],
  );

  let removed = 0;
  let failed = 0;

  for (const row of rows) {
    if (row.storage_key === "") continue;
    try {
      await store.remove(row.storage_key);
      removed += 1;
    } catch {
      failed += 1;
    }
  }

  return { removed, failed };
}
