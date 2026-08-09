import type { DatabaseClient } from "../db.js";

/**
 * Expands a target version into the people it currently reaches.
 *
 * This is the *only* way to answer "who is in scope". The obvious shortcut —
 * reading announcement_recipient_sources — gives the wrong answer, because the
 * target rows it points at belong to whichever version was live at the time.
 * After a department is removed, those rows still describe the old scope.
 *
 * Disabled and anonymized accounts are excluded: an announcement addressed to
 * a department means its current active members, and a disabled person can
 * neither read nor acknowledge anything.
 *
 * Service accounts are excluded for the same reason, and it matters more than
 * it looks. An announcement to 全員 creates an acknowledgement obligation per
 * recipient; a robot that cannot acknowledge would sit in the denominator
 * forever, and "12 / 13 confirmed" would never reach 100% with nobody able to
 * say why.
 */

export interface ResolvedRecipient {
  userId: string;
  /** Every target that brought this person in — one person may match several. */
  targetIds: string[];
}

const RESOLVE_SQL = `
  SELECT u.id AS user_id, t.id AS target_id
    FROM announcement_targets t
    JOIN users u
      ON (
           t.target_kind = 'all'
        OR (t.target_kind = 'org_unit' AND EXISTS (
              SELECT 1
                FROM user_org_units m
               WHERE m.user_id = u.id
                 AND m.org_unit_id = t.org_unit_id
                 AND m.left_at IS NULL))
        OR (t.target_kind = 'user' AND u.id = t.user_id)
         )
   WHERE t.target_version_id = $1
     AND u.disabled_at IS NULL
     AND u.anonymized_at IS NULL
     AND u.kind = 'person'
   ORDER BY u.id
`;

/**
 * Returns one entry per person, deduplicated, each carrying every target that
 * matched them.
 *
 * Being covered by both 営業部 and an individual designation must produce one
 * recipient with two sources — not two recipients, which would count them
 * twice in the denominator.
 */
export async function resolveTargetUsers(
  client: DatabaseClient,
  targetVersionId: string,
): Promise<ResolvedRecipient[]> {
  const { rows } = await client.query<{ user_id: string; target_id: string }>(
    RESOLVE_SQL,
    [targetVersionId],
  );

  const byUser = new Map<string, string[]>();
  for (const row of rows) {
    const existing = byUser.get(row.user_id);
    if (existing) existing.push(row.target_id);
    else byUser.set(row.user_id, [row.target_id]);
  }

  return [...byUser].map(([userId, targetIds]) => ({ userId, targetIds }));
}

/** Convenience for "how many people would this reach", used by the editor. */
export async function countTargetUsers(
  client: DatabaseClient,
  targetVersionId: string | null,
): Promise<number> {
  if (!targetVersionId) return 0;
  const resolved = await resolveTargetUsers(client, targetVersionId);
  return resolved.length;
}
