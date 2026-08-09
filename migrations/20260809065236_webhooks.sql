-- webhooks
--
-- M5: telling another system that something happened here.
--
-- The delivery half is a transactional outbox, exactly like notifications and
-- for the same reason: the row is written in the same transaction as the thing
-- it describes, so by the time the worker sees one, that thing definitely
-- happened. Failure is therefore retry, never discard — "the announcement was
-- published but the dispatch system never heard" is precisely the silent
-- failure this product exists to argue against.
--
-- The signing secret is ENCRYPTED, not hashed. Everything else that looks like
-- a credential here is hashed, so the exception needs stating: signing needs
-- the plaintext on every delivery. A hash can be compared and this cannot —
-- the value has to come back. That puts it in the same category as the SMTP
-- password, and it goes through the same secret store.

-- Up Migration

CREATE TABLE webhooks (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),

  url                 text NOT NULL,
  description         text,

  -- enc:v1:<keyid>:... — see packages/secret-store. Never returned by the API
  -- after creation; the receiver keeps its own copy.
  secret_encrypted    text NOT NULL,

  -- Which events to send. Empty would be a webhook that never fires, which is
  -- a configuration mistake that looks like a working one.
  events              text[] NOT NULL,

  created_by          uuid NOT NULL REFERENCES users(id),
  disabled_at         timestamptz,

  -- Health, so a dead endpoint is visible in the interface rather than only in
  -- a log nobody reads.
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_success_at     timestamptz,
  last_failure_at     timestamptz,
  last_error          text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_webhook_url CHECK (url ~ '^https?://'),
  CONSTRAINT ck_webhook_events CHECK (array_length(events, 1) >= 1)
);

CREATE TRIGGER trg_webhooks_updated_at
  BEFORE UPDATE ON webhooks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX ix_webhooks_live ON webhooks (id) WHERE disabled_at IS NULL;

COMMENT ON TABLE webhooks IS
  'Outbound HTTP notifications. secret_encrypted is encrypted rather than hashed because signing requires the plaintext on every delivery.';

-- ---------------------------------------------------------------------------
-- deliveries
-- ---------------------------------------------------------------------------

-- One row per (webhook, event). Two subscribers to the same event get two
-- rows: a single delivery shared between them would mean one slow endpoint
-- delaying the other, and one permanent failure abandoning both.
CREATE TABLE webhook_deliveries (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  webhook_id     uuid NOT NULL REFERENCES webhooks(id),

  event          text NOT NULL,

  -- The body as it will be signed and sent, frozen at enqueue time. Rebuilding
  -- it at delivery time would send a description of the world as it is now,
  -- not as it was when the event happened — so a retry an hour later would
  -- deliver something that never occurred.
  payload        jsonb NOT NULL,

  available_at   timestamptz NOT NULL DEFAULT now(),
  locked_at      timestamptz,
  locked_by      text,
  delivered_at   timestamptz,
  attempt_count  integer NOT NULL DEFAULT 0,

  last_status    integer,
  last_error     text,

  created_at     timestamptz NOT NULL DEFAULT now()
);

-- The worker's claim query: undelivered, unlocked, due.
CREATE INDEX ix_webhook_deliveries_claimable
  ON webhook_deliveries (available_at)
  WHERE delivered_at IS NULL AND locked_at IS NULL;

CREATE INDEX ix_webhook_deliveries_webhook
  ON webhook_deliveries (webhook_id, created_at DESC);

-- Down Migration

DROP TABLE IF EXISTS webhook_deliveries;
DROP TABLE IF EXISTS webhooks;
