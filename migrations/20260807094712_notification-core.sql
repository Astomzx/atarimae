-- notification-core
--
-- Notifications are generated per obligation, never per announcement. That one
-- decision makes the hard cases correct without special-casing:
--
--   add a department to a published announcement -> only the new people hear
--   edit one person's paragraph and require re-ack -> only that person hears
--   major body edit -> everyone holding a live obligation, and nobody else
--   announcement needs no acknowledgement -> no obligations, so silence
--
-- The outbox is written inside the publish transaction. An announcement that
-- is published but notifies nobody is the failure this system must never
-- produce; SMTP being unreachable must delay mail, never lose it.

-- Up Migration

-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------

CREATE TABLE notifications (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id       uuid NOT NULL REFERENCES users(id),

  -- Present for acknowledgement-related notifications, absent for mentions.
  obligation_id uuid REFERENCES announcement_ack_obligations(id),

  event_type    text NOT NULL,
  title         text NOT NULL,
  body          text NOT NULL,
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_notification_event_type CHECK (
    event_type IN (
      'obligation.assigned',
      'obligation.reassigned',
      'obligation.deadline_reminder_24h',
      'mention'
    )
  ),

  -- Everything except a mention is about a specific obligation.
  CONSTRAINT ck_notification_obligation_present CHECK (
    (event_type = 'mention' AND obligation_id IS NULL)
    OR (event_type <> 'mention' AND obligation_id IS NOT NULL)
  )
);

-- Idempotency. The event type is part of the key, so first assignment,
-- re-acknowledgement and the deadline reminder never collide -- and a retrying
-- worker cannot produce a duplicate email.
--
-- v1.0 sends exactly one reminder. Adding more later needs a reminder instance
-- id, not a change to this index.
CREATE UNIQUE INDEX uq_obligation_notification
  ON notifications (obligation_id, event_type)
  WHERE obligation_id IS NOT NULL;

CREATE INDEX ix_notifications_unread
  ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;

-- ---------------------------------------------------------------------------
-- per-user preferences
-- ---------------------------------------------------------------------------

CREATE TABLE notification_preferences (
  user_id       uuid NOT NULL REFERENCES users(id),
  event_type    text NOT NULL,
  in_app_enabled boolean NOT NULL DEFAULT true,
  email_enabled  boolean NOT NULL DEFAULT true,
  push_enabled   boolean NOT NULL DEFAULT true,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_type)
);

COMMENT ON TABLE notification_preferences IS
  'Absent row means every channel is enabled. Only stores deviations from the default.';

-- ---------------------------------------------------------------------------
-- delivery attempts
-- ---------------------------------------------------------------------------

CREATE TABLE notification_deliveries (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  notification_id uuid NOT NULL REFERENCES notifications(id),
  channel         text NOT NULL,
  destination     text,
  status          text NOT NULL DEFAULT 'pending',
  attempt_count   integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  delivered_at    timestamptz,
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_delivery_channel CHECK (channel IN ('email', 'push')),
  CONSTRAINT ck_delivery_status
    CHECK (status IN ('pending', 'sent', 'failed', 'abandoned')),
  CONSTRAINT ck_delivery_error_on_failure
    CHECK (status <> 'failed' OR error_message IS NOT NULL)
);

-- One delivery task per channel per notification. Without this a retrying
-- worker sends the same email twice.
CREATE UNIQUE INDEX uq_notification_delivery_channel
  ON notification_deliveries (notification_id, channel);

CREATE INDEX ix_deliveries_pending
  ON notification_deliveries (created_at)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- transactional outbox
-- ---------------------------------------------------------------------------

-- Written in the same transaction as the change it describes. The worker picks
-- rows up afterwards, so a publish either records both the obligations and the
-- intent to notify, or neither.
CREATE TABLE notification_outbox (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  event_type    text NOT NULL,
  payload       jsonb NOT NULL,

  available_at  timestamptz NOT NULL DEFAULT now(),
  locked_at     timestamptz,
  locked_by     text,
  processed_at  timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_outbox_event_type CHECK (
    event_type IN (
      'obligation.assigned',
      'obligation.reassigned',
      'obligation.deadline_reminder_24h',
      'mention'
    )
  )
);

-- Drives the worker's claim query: unprocessed, unlocked, due.
CREATE INDEX ix_outbox_claimable
  ON notification_outbox (available_at)
  WHERE processed_at IS NULL AND locked_at IS NULL;

-- ---------------------------------------------------------------------------
-- web push subscriptions
-- ---------------------------------------------------------------------------

-- Attached to a device, not a session. Signing out disables a subscription;
-- it does not delete it, so signing back in on the same device reuses the row
-- instead of accumulating orphans.
CREATE TABLE push_subscriptions (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  user_device_id    uuid NOT NULL REFERENCES user_devices(id),
  endpoint          text NOT NULL,
  p256dh_key        text NOT NULL,
  auth_key          text NOT NULL,
  enabled           boolean NOT NULL DEFAULT true,
  last_confirmed_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz
);

CREATE UNIQUE INDEX uq_push_subscription_endpoint
  ON push_subscriptions (endpoint)
  WHERE revoked_at IS NULL;

CREATE INDEX ix_push_subscriptions_device ON push_subscriptions (user_device_id);

-- Down Migration

DROP TABLE IF EXISTS push_subscriptions;
DROP TABLE IF EXISTS notification_outbox;
DROP TABLE IF EXISTS notification_deliveries;
DROP TABLE IF EXISTS notification_preferences;
DROP TABLE IF EXISTS notifications;
