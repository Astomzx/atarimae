import type { Database } from "../db.js";

/**
 * Ends calls that nobody ever left.
 *
 * Leaving is an explicit action, and a browser tab closing is not one. Without
 * this, one closed laptop leaves a call marked live forever — and because a
 * channel may hold only one live call, that conversation can never start
 * another. The interface would show 通話中 with nobody in it, and the only fix
 * would be a database edit.
 *
 * Twelve hours is a backstop, not a timeout. It is far longer than any real
 * call, so it never cuts one short; the normal end is the last participant
 * leaving.
 */
export const ABANDONED_CALL_AFTER = "12 hours";

export async function endAbandonedCalls(db: Database): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE calls
        SET ended_at = now(), ended_reason = 'abandoned'
      WHERE ended_at IS NULL
        AND started_at < now() - $1::interval`,
    [ABANDONED_CALL_AFTER],
  );

  return rowCount ?? 0;
}
