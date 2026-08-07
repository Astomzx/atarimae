import type { CommandSummary } from "@atarimae/api-schema";

import type { DatabaseClient } from "../db.js";

/**
 * The single path through which obligations are created.
 *
 * Every route that hands out acknowledgement work — publishing, opening
 * acknowledgement on an existing announcement, expanding targets, requesting
 * re-acknowledgement — goes through here, so the rules cannot be bypassed by
 * adding one more endpoint later.
 */

export type OperationKind =
  | "initial_assignment"
  | "target_expansion"
  | "manual_assignment"
  | "content_reacknowledgement"
  | "personal_reacknowledgement";

/** `assigned` for a first obligation, `reassigned` for a successor. */
function outboxEventFor(operation: OperationKind): string {
  return operation === "content_reacknowledgement" ||
    operation === "personal_reacknowledgement"
    ? "obligation.reassigned"
    : "obligation.assigned";
}

export function emptySummary(): CommandSummary {
  return {
    eligibleCount: 0,
    createdCount: 0,
    skippedDisabledCount: 0,
    skippedExistingActiveCount: 0,
    skippedNoActiveObligationCount: 0,
    skippedAlreadyAcknowledgedCount: 0,
  };
}

interface Candidate {
  recipient_id: string;
  user_id: string;
  live_obligation_id: string | null;
  personalization_id: string | null;
  override_due_at: string | null;
}

/**
 * Recipients of an announcement, each with what an obligation would need:
 * their live obligation if any, their live personalization if any, and their
 * per-user deadline override if any.
 *
 * Disabled users are filtered out here rather than in each caller — nobody who
 * cannot sign in should ever appear in a denominator.
 */
async function candidates(
  client: DatabaseClient,
  announcementId: string,
): Promise<Candidate[]> {
  const { rows } = await client.query<Candidate>(
    `SELECT r.id   AS recipient_id,
            r.user_id,
            (SELECT o.id
               FROM announcement_ack_obligations o
              WHERE o.recipient_id = r.id
                AND o.waived_at IS NULL
                AND o.superseded_at IS NULL
              LIMIT 1) AS live_obligation_id,
            (SELECT p.id
               FROM announcement_personalizations p
              WHERE p.announcement_id = r.announcement_id
                AND p.user_id = r.user_id
                AND p.superseded_at IS NULL
              LIMIT 1) AS personalization_id,
            (SELECT d.due_at
               FROM announcement_user_due_overrides d
              WHERE d.announcement_id = r.announcement_id
                AND d.user_id = r.user_id) AS override_due_at
       FROM announcement_recipients r
       JOIN users u ON u.id = r.user_id
      WHERE r.announcement_id = $1
        AND u.disabled_at IS NULL
      ORDER BY r.id
      FOR UPDATE OF r`,
    [announcementId],
  );
  return rows;
}

/** Counts recipients skipped purely because their account is disabled. */
async function countDisabledRecipients(
  client: DatabaseClient,
  announcementId: string,
): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*) FROM announcement_recipients r
       JOIN users u ON u.id = r.user_id
      WHERE r.announcement_id = $1 AND u.disabled_at IS NOT NULL`,
    [announcementId],
  );
  return Number(rows[0]?.count ?? 0);
}

async function insertObligation(
  client: DatabaseClient,
  params: {
    recipientId: string;
    contentRevisionId: string;
    personalizationId: string | null;
    dueAt: string | null;
    previousObligationId: string | null;
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO announcement_ack_obligations
       (recipient_id, content_revision_id, personalization_revision_id,
        due_at, previous_obligation_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      params.recipientId,
      params.contentRevisionId,
      params.personalizationId,
      params.dueAt,
      params.previousObligationId,
    ],
  );
  return rows[0]!.id;
}

async function queueNotification(
  client: DatabaseClient,
  obligationId: string,
  userId: string,
  announcementId: string,
  operation: OperationKind,
): Promise<void> {
  await client.query(
    `INSERT INTO notification_outbox (event_type, payload)
     VALUES ($1, $2::jsonb)`,
    [
      outboxEventFor(operation),
      JSON.stringify({ obligationId, userId, announcementId, reason: operation }),
    ],
  );
}

export interface AssignInput {
  announcementId: string;
  /** Must be the *published* revision. Callers verify this before arriving. */
  contentRevisionId: string;
  announcementDueAt: string | null;
  operation: OperationKind;
}

/**
 * Gives a first obligation to recipients who currently hold none.
 *
 * Complementary to requestReacknowledgement: this one targets people *without*
 * a live obligation, that one targets people *with* one. Confusing the two
 * produces the silent failure the whole model exists to prevent — an
 * administrator clicks, the UI says success, and nobody is asked.
 */
export async function assignObligations(
  client: DatabaseClient,
  input: AssignInput,
): Promise<CommandSummary> {
  const summary = emptySummary();
  summary.skippedDisabledCount = await countDisabledRecipients(
    client,
    input.announcementId,
  );

  for (const candidate of await candidates(client, input.announcementId)) {
    if (candidate.live_obligation_id) {
      summary.skippedExistingActiveCount += 1;
      continue;
    }

    summary.eligibleCount += 1;

    // Per-user override wins over the announcement default. Resolved once and
    // frozen onto the obligation: deriving it later would let an edit move
    // every historical deadline with no record.
    const dueAt = candidate.override_due_at ?? input.announcementDueAt;

    const obligationId = await insertObligation(client, {
      recipientId: candidate.recipient_id,
      contentRevisionId: input.contentRevisionId,
      personalizationId: candidate.personalization_id,
      dueAt,
      previousObligationId: null,
    });

    await queueNotification(
      client,
      obligationId,
      candidate.user_id,
      input.announcementId,
      input.operation,
    );

    summary.createdCount += 1;
  }

  return summary;
}

export interface ReacknowledgeInput {
  announcementId: string;
  contentRevisionId: string;
  announcementDueAt: string | null;
  operation: "content_reacknowledgement" | "personal_reacknowledgement";
  /** Restricts to one person, for a personal-content change. */
  onlyUserId?: string;
}

/**
 * Replaces live obligations with successors bound to newer content.
 *
 * Deliberately unreachable for anyone whose obligation was waived, whose
 * account is disabled, or who never had an obligation — those people can only
 * be reached through assignObligations, as an explicit, separately audited
 * decision. Otherwise a re-acknowledgement would quietly drag a disabled
 * former employee back into the denominator, where they would sit forever
 * because they cannot sign in to acknowledge.
 */
export async function requestReacknowledgement(
  client: DatabaseClient,
  input: ReacknowledgeInput,
): Promise<CommandSummary> {
  const summary = emptySummary();
  summary.skippedDisabledCount = await countDisabledRecipients(
    client,
    input.announcementId,
  );

  for (const candidate of await candidates(client, input.announcementId)) {
    if (input.onlyUserId && candidate.user_id !== input.onlyUserId) continue;

    if (!candidate.live_obligation_id) {
      summary.skippedNoActiveObligationCount += 1;
      continue;
    }

    summary.eligibleCount += 1;

    // The old row must leave the live set before the successor is inserted:
    // the partial unique index allows only one live obligation per recipient.
    await client.query(
      "UPDATE announcement_ack_obligations SET superseded_at = now() WHERE id = $1",
      [candidate.live_obligation_id],
    );

    const dueAt = candidate.override_due_at ?? input.announcementDueAt;

    const obligationId = await insertObligation(client, {
      recipientId: candidate.recipient_id,
      contentRevisionId: input.contentRevisionId,
      // Carries the person's current personal content forward. Setting it to
      // NULL would make their own instructions vanish from what they are being
      // asked to confirm.
      personalizationId: candidate.personalization_id,
      dueAt,
      previousObligationId: candidate.live_obligation_id,
    });

    await queueNotification(
      client,
      obligationId,
      candidate.user_id,
      input.announcementId,
      input.operation,
    );

    summary.createdCount += 1;
  }

  return summary;
}

/**
 * Releases people from an outstanding obligation.
 *
 * Never touches an acknowledged one. Acknowledgement is a fact that already
 * happened; letting a later administrative action erase it would make every
 * reported figure unfalsifiable.
 */
export async function waiveObligations(
  client: DatabaseClient,
  input: { announcementId: string; reason: string; onlyUserId?: string },
): Promise<CommandSummary> {
  const summary = emptySummary();

  const { rows } = await client.query<{
    id: string;
    user_id: string;
    acknowledged: boolean;
  }>(
    `SELECT o.id,
            r.user_id,
            EXISTS (
              SELECT 1 FROM announcement_acknowledgements a
               WHERE a.obligation_id = o.id
            ) AS acknowledged
       FROM announcement_ack_obligations o
       JOIN announcement_recipients r ON r.id = o.recipient_id
      WHERE r.announcement_id = $1
        AND o.waived_at IS NULL
        AND o.superseded_at IS NULL
        AND ($2::uuid IS NULL OR r.user_id = $2)
      FOR UPDATE OF o`,
    [input.announcementId, input.onlyUserId ?? null],
  );

  for (const row of rows) {
    if (row.acknowledged) {
      summary.skippedAlreadyAcknowledgedCount += 1;
      continue;
    }

    summary.eligibleCount += 1;
    await client.query(
      `UPDATE announcement_ack_obligations
          SET waived_at = now(), waived_reason = $2
        WHERE id = $1`,
      [row.id, input.reason],
    );
    summary.createdCount += 1;
  }

  return summary;
}
