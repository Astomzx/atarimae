-- service-accounts-and-api-tokens
--
-- M5: something other than a person can use the API.
--
-- The alternative was a personal access token — a token that acts as whoever
-- created it. That fails the day they leave: the account is disabled, and the
-- dispatch system that has been posting the morning roster for a year stops,
-- with nothing to point at but "somebody left". An integration must not be
-- anybody's personal property.
--
-- Service accounts are rows in `users` rather than a table of their own. They
-- author announcements and messages, they appear in audit_logs, they are
-- referenced by created_by — every one of those is a foreign key to users(id),
-- and a parallel identity table would mean making each of them nullable and
-- checking two columns everywhere forever.
--
-- The cost is the opposite risk: a query that means "people" and says "users"
-- now silently includes robots. Each of those is fixed here or in the service
-- layer, and each has a test — an announcement addressed to 全員 must not
-- create an acknowledgement obligation for a dispatch system that cannot
-- acknowledge anything.

-- Up Migration

ALTER TABLE users
  ADD COLUMN kind text NOT NULL DEFAULT 'person';

ALTER TABLE users
  ADD CONSTRAINT ck_users_kind CHECK (kind IN ('person', 'service'));

-- A service account has no password and can never sign in interactively. The
-- constraint is what makes that a fact rather than an intention: there is no
-- code path that could set one by accident.
ALTER TABLE users
  ADD CONSTRAINT ck_service_accounts_have_no_password
  CHECK (kind = 'person' OR password_hash IS NULL);

-- Owner is the role that can grant Owner. A token that can promote itself is
-- one leaked token away from being the whole organisation, so the highest a
-- service account can hold is admin.
ALTER TABLE users
  ADD CONSTRAINT ck_service_accounts_are_not_owners
  CHECK (kind = 'person' OR role <> 'owner');

-- What the integration is for, in words. A row that says only
-- "roster-sync" tells the next administrator nothing about whether it is safe
-- to revoke.
ALTER TABLE users
  ADD COLUMN service_description text;

ALTER TABLE users
  ADD CONSTRAINT ck_service_description_is_for_services
  CHECK (kind = 'service' OR service_description IS NULL);

CREATE INDEX ix_users_kind ON users (kind) WHERE disabled_at IS NULL;

-- ---------------------------------------------------------------------------
-- api_tokens
-- ---------------------------------------------------------------------------

-- Hashed, never encrypted. The plaintext is shown once at creation and is not
-- recoverable afterwards, because the server has no reason to know it again —
-- it only ever compares. Encryption here would be a decryptable copy of every
-- live credential, stored for no purpose.
--
-- SHA-256 rather than Argon2: a token is 256 bits from a CSPRNG, so there is
-- nothing to brute force, and a slow hash on every API request would be a
-- self-inflicted rate limit.
CREATE TABLE api_tokens (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),

  -- Always a service account. Enforced in the application, which is the only
  -- place that can read users.kind for the row being inserted.
  user_id         uuid NOT NULL REFERENCES users(id),

  -- What this token is for. "Nightly roster import", not "token 3".
  name            text NOT NULL,

  token_hash      text NOT NULL,

  -- The visible head of the token, e.g. 'atk_7Fh2Kq'. Shown in the list so a
  -- token can be identified for revocation without the plaintext existing
  -- anywhere. Not a secret, and not enough to authenticate.
  token_prefix    text NOT NULL,

  -- Who issued it. A person, always: a token cannot mint another token.
  created_by      uuid NOT NULL REFERENCES users(id),

  expires_at      timestamptz,
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  revoked_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_api_token_name CHECK (length(trim(name)) > 0),
  -- An already-expired token is a configuration mistake that would look like a
  -- working integration until the first request.
  CONSTRAINT ck_api_token_expiry CHECK (expires_at IS NULL OR expires_at > created_at)
);

-- The authentication lookup: one indexed equality on the hash. No scan, and no
-- comparison in application code that could be made non-constant-time.
CREATE UNIQUE INDEX uq_api_tokens_hash ON api_tokens (token_hash);

CREATE INDEX ix_api_tokens_user ON api_tokens (user_id, created_at DESC);

CREATE INDEX ix_api_tokens_live
  ON api_tokens (user_id)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE api_tokens IS
  'API tokens for service accounts. Stored as a SHA-256 hash: only ever compared, never replayed, and therefore never encrypted.';

-- Down Migration

DROP TABLE IF EXISTS api_tokens;

DROP INDEX IF EXISTS ix_users_kind;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS ck_service_description_is_for_services,
  DROP CONSTRAINT IF EXISTS ck_service_accounts_are_not_owners,
  DROP CONSTRAINT IF EXISTS ck_service_accounts_have_no_password,
  DROP CONSTRAINT IF EXISTS ck_users_kind;

ALTER TABLE users DROP COLUMN IF EXISTS service_description;

-- Service accounts are NOT deleted here, and cannot be: they author
-- announcements and messages and appear in audit_logs, all of which are
-- foreign keys to users(id). A Down migration that fails on any database where
-- somebody used the feature is not a Down migration.
--
-- What they become is inert. Every token is gone with the table above, and the
-- account has no password_hash, so there is no way to authenticate as one —
-- sign-in requires a password to compare against. They remain in the member
-- list as passwordless rows, which is visible and harmless, rather than
-- vanishing and taking their history with them.
ALTER TABLE users DROP COLUMN IF EXISTS kind;
