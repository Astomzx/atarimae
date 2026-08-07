import { randomUUID } from "node:crypto";

import type { Database } from "../db.js";
import { withTransaction } from "../db.js";
import type { Mailer } from "./mailer.js";

/**
 * Drains the transactional outbox.
 *
 * Publishing writes outbox rows in the same transaction as the obligations
 * they describe, so by the time this worker sees one, the thing it announces
 * definitely happened. Its job is to make delivery eventually happen too —
 * never to decide whether it should.
 *
 * Failure handling is therefore retry, not discard. SMTP being unreachable
 * delays mail; it must not lose it. An announcement published but never
 * notified is the failure the whole design exists to prevent, and dropping a
 * message here would reintroduce it at the last step.
 */

const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

/** Exponential backoff, capped. Attempt 1 waits a minute, attempt 6+ an hour. */
function backoffSeconds(attempt: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempt - 1), 3600);
}

/** Beyond this many failures a row stops being retried and is left for review. */
const MAX_ATTEMPTS = 10;

interface OutboxRow {
  id: string;
  event_type: string;
  payload: { obligationId?: string; userId?: string; announcementId?: string };
  attempt_count: number;
}

interface ObligationContext {
  user_email: string;
  user_display_name: string;
  title: string;
  due_at: string | null;
  email_enabled: boolean;
}

export interface DrainResult {
  claimed: number;
  delivered: number;
  failed: number;
  skipped: number;
}

/**
 * Claims a batch with SKIP LOCKED so several workers — or one worker and a
 * restarted copy of itself — never process the same row twice.
 */
async function claim(db: Database, batchSize: number): Promise<OutboxRow[]> {
  const { rows } = await db.query<OutboxRow>(
    `UPDATE notification_outbox
        SET locked_at = now(), locked_by = $1, attempt_count = attempt_count + 1
      WHERE id IN (
        SELECT id FROM notification_outbox
         WHERE processed_at IS NULL
           AND locked_at IS NULL
           AND available_at <= now()
           AND attempt_count < $3
         ORDER BY available_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, event_type, payload, attempt_count`,
    [WORKER_ID, batchSize, MAX_ATTEMPTS],
  );
  return rows;
}

async function releaseForRetry(
  db: Database,
  row: OutboxRow,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db.query(
    `UPDATE notification_outbox
        SET locked_at = NULL,
            locked_by = NULL,
            available_at = now() + make_interval(secs => $2),
            last_error = $3
      WHERE id = $1`,
    [row.id, backoffSeconds(row.attempt_count), message.slice(0, 500)],
  );
}

const SUBJECTS: Record<string, string> = {
  "obligation.assigned": "確認が必要なお知らせがあります",
  "obligation.reassigned": "お知らせが更新されました。再確認をお願いします",
  "obligation.deadline_reminder_24h": "確認期限が近づいています",
};

function bodyFor(eventType: string, context: ObligationContext, origin: string): string {
  const deadline = context.due_at
    ? `\n期限: ${new Date(context.due_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`
    : "";

  const lead =
    eventType === "obligation.reassigned"
      ? "内容が変更されたため、あらためて確認が必要です。"
      : eventType === "obligation.deadline_reminder_24h"
        ? "まだ確認が完了していません。"
        : "確認が必要なお知らせが届いています。";

  return (
    `${context.user_display_name} さん\n\n` +
    `${lead}\n\n` +
    `件名: ${context.title}${deadline}\n\n` +
    `内容の確認はこちら:\n${origin}\n\n` +
    `---\nこのメールは Atarimae から自動送信されています。`
  );
}

/**
 * Processes one batch. Returns what happened, so a caller can log it or decide
 * whether to loop again immediately.
 */
export async function drainOutbox(
  db: Database,
  mailer: Mailer,
  options: { batchSize?: number; publicOrigin: string },
): Promise<DrainResult> {
  const result: DrainResult = { claimed: 0, delivered: 0, failed: 0, skipped: 0 };

  const batch = await claim(db, options.batchSize ?? 20);
  result.claimed = batch.length;

  for (const row of batch) {
    try {
      const obligationId = row.payload.obligationId;
      if (!obligationId) {
        // Nothing actionable; mark done rather than retrying forever.
        await db.query(
          "UPDATE notification_outbox SET processed_at = now(), locked_at = NULL WHERE id = $1",
          [row.id],
        );
        result.skipped += 1;
        continue;
      }

      const { rows: contexts } = await db.query<ObligationContext>(
        `SELECT u.email          AS user_email,
                u.display_name   AS user_display_name,
                cr.title,
                o.due_at,
                COALESCE(np.email_enabled, true) AS email_enabled
           FROM announcement_ack_obligations o
           JOIN announcement_recipients r ON r.id = o.recipient_id
           JOIN users u ON u.id = r.user_id
           JOIN announcement_content_revisions cr ON cr.id = o.content_revision_id
           LEFT JOIN notification_preferences np
             ON np.user_id = u.id AND np.event_type = $2
          WHERE o.id = $1`,
        [obligationId, row.event_type],
      );

      const context = contexts[0];

      // The obligation may have been superseded or its owner disabled between
      // publish and delivery. Sending anyway would ask somebody to confirm
      // something no longer asked of them.
      if (!context) {
        await db.query(
          "UPDATE notification_outbox SET processed_at = now(), locked_at = NULL WHERE id = $1",
          [row.id],
        );
        result.skipped += 1;
        continue;
      }

      // The in-app notification is recorded regardless of email preference —
      // it is the record that the person was asked.
      const notificationId = await withTransaction(db, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO notifications (user_id, obligation_id, event_type, title, body)
           SELECT r.user_id, $1, $2, $3, $4
             FROM announcement_ack_obligations o
             JOIN announcement_recipients r ON r.id = o.recipient_id
            WHERE o.id = $1
           ON CONFLICT (obligation_id, event_type) WHERE obligation_id IS NOT NULL
           DO NOTHING
           RETURNING id`,
          [
            obligationId,
            row.event_type,
            SUBJECTS[row.event_type] ?? "お知らせ",
            context.title,
          ],
        );

        if (rows[0]) return rows[0].id;

        // Already created by an earlier attempt. Reuse it rather than
        // producing a second copy — this is what makes retries safe.
        const { rows: existing } = await client.query<{ id: string }>(
          `SELECT id FROM notifications
            WHERE obligation_id = $1 AND event_type = $2`,
          [obligationId, row.event_type],
        );
        return existing[0]?.id ?? null;
      });

      if (!notificationId) {
        await db.query(
          "UPDATE notification_outbox SET processed_at = now(), locked_at = NULL WHERE id = $1",
          [row.id],
        );
        result.skipped += 1;
        continue;
      }

      if (!context.email_enabled) {
        await db.query(
          "UPDATE notification_outbox SET processed_at = now(), locked_at = NULL WHERE id = $1",
          [row.id],
        );
        result.skipped += 1;
        continue;
      }

      // One delivery row per channel per notification, so a retry updates the
      // existing attempt instead of queueing a second email.
      await db.query(
        `INSERT INTO notification_deliveries (notification_id, channel, destination)
         VALUES ($1, 'email', $2)
         ON CONFLICT (notification_id, channel) DO NOTHING`,
        [notificationId, context.user_email],
      );

      await mailer.send({
        to: context.user_email,
        subject: SUBJECTS[row.event_type] ?? "お知らせ",
        text: bodyFor(row.event_type, context, options.publicOrigin),
      });

      await withTransaction(db, async (client) => {
        await client.query(
          `UPDATE notification_deliveries
              SET status = 'sent', delivered_at = now(),
                  attempt_count = attempt_count + 1, last_attempt_at = now()
            WHERE notification_id = $1 AND channel = 'email'`,
          [notificationId],
        );
        await client.query(
          "UPDATE notification_outbox SET processed_at = now(), locked_at = NULL WHERE id = $1",
          [row.id],
        );
      });

      result.delivered += 1;
    } catch (error) {
      await releaseForRetry(db, row, error);
      result.failed += 1;
    }
  }

  return result;
}

/**
 * Releases rows whose worker died mid-batch.
 *
 * Without this a crash leaves them locked forever, and the notification is
 * owed but never sent — exactly the outcome the outbox exists to prevent.
 */
export async function reclaimStaleLocks(
  db: Database,
  olderThanSeconds = 300,
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE notification_outbox
        SET locked_at = NULL, locked_by = NULL
      WHERE processed_at IS NULL
        AND locked_at IS NOT NULL
        AND locked_at < now() - make_interval(secs => $1)`,
    [olderThanSeconds],
  );
  return rowCount ?? 0;
}
