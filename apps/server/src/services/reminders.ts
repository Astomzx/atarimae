import type { Database } from "../db.js";

/**
 * Deadline reminders.
 *
 * v1.0 sends exactly one, 24 hours before an obligation is due. Deliberately
 * not a configurable reminder workflow: a board that quietly mails people four
 * times about the same notice trains them to ignore it, which defeats the
 * point of asking for acknowledgement at all.
 *
 * The reminder is queued through the same outbox as everything else, so it
 * inherits the same retry and idempotency guarantees.
 */

const REMINDER_EVENT = "obligation.deadline_reminder_24h";

/**
 * Queues reminders for obligations falling due within the window.
 *
 * Idempotent by construction: the notifications table has a unique index on
 * (obligation_id, event_type), and this query skips anything already queued or
 * already notified. Running it every minute produces one reminder, not sixty.
 */
export async function queueDueReminders(db: Database, windowHours = 24): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO notification_outbox (event_type, payload)
     SELECT $1,
            jsonb_build_object(
              'obligationId', o.id,
              'userId', r.user_id,
              'announcementId', r.announcement_id,
              'reason', 'deadline_reminder'
            )
       FROM announcement_ack_obligations o
       JOIN announcement_recipients r ON r.id = o.recipient_id
       JOIN users u ON u.id = r.user_id
      WHERE o.waived_at IS NULL
        AND o.superseded_at IS NULL
        AND o.due_at IS NOT NULL
        -- Inside the window, and not already past: reminding somebody about a
        -- deadline that has gone is not a reminder, it is a reprimand.
        AND o.due_at > now()
        AND o.due_at <= now() + make_interval(hours => $2)
        AND u.disabled_at IS NULL
        -- Already done: nothing to remind them about.
        AND NOT EXISTS (
          SELECT 1 FROM announcement_acknowledgements a
           WHERE a.obligation_id = o.id
        )
        -- Already reminded, or already queued to be.
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
           WHERE n.obligation_id = o.id AND n.event_type = $1
        )
        AND NOT EXISTS (
          SELECT 1 FROM notification_outbox ob
           WHERE ob.event_type = $1
             AND ob.payload ->> 'obligationId' = o.id::text
             AND ob.processed_at IS NULL
        )
     RETURNING id`,
    [REMINDER_EVENT, windowHours],
  );

  return rows.length;
}
