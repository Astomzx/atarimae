-- identity-and-organization
--
-- Identity and organisation data model: users, organisation units, invitations, devices, sessions and
-- the audit log.
--
-- Two rules from docs/architecture/announcement-model.md are enforced here at
-- the database level rather than left to application code:
--
--   1. users and org_units are never physically deleted. Historical targets,
--      recipients, obligations and audit entries reference these ids forever.
--   2. At least one active Owner must always exist.

-- Up Migration

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  email           text NOT NULL,
  display_name    text NOT NULL,
  password_hash   text,
  role            text NOT NULL DEFAULT 'member',

  -- Disabled users keep their history and cannot sign in. Never deleted.
  disabled_at     timestamptz,
  -- Set by anonymize_user when erasure is legally required. Identifying
  -- columns are cleared, the id and every relationship survive.
  anonymized_at   timestamptz,

  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_users_role CHECK (role IN ('owner', 'admin', 'member')),
  CONSTRAINT ck_users_display_name CHECK (length(trim(display_name)) > 0),

  -- An anonymized user can never sign in again, so the two flags travel
  -- together and the state cannot be half-applied.
  CONSTRAINT ck_users_anonymized_implies_disabled
    CHECK (anonymized_at IS NULL OR disabled_at IS NOT NULL)
);

-- The database uses the builtin C.UTF-8 collation, which is case-sensitive.
-- Address uniqueness must be case-insensitive, so it is indexed on lower().
-- Anonymized rows are excluded: they hold a placeholder address that would
-- otherwise collide once a second user is anonymized.
CREATE UNIQUE INDEX uq_users_email
  ON users (lower(email))
  WHERE anonymized_at IS NULL;

CREATE INDEX ix_users_active ON users (id) WHERE disabled_at IS NULL;
CREATE INDEX ix_users_role ON users (role) WHERE disabled_at IS NULL;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN users.password_hash IS
  'Argon2id. NULL for accounts created by invitation that have not been claimed yet.';

-- ---------------------------------------------------------------------------
-- At least one active Owner must always exist
-- ---------------------------------------------------------------------------

-- The whole premise of this product is that an administrator genuinely holds
-- administrative power. An organisation that locks itself out of Owner is
-- exactly the situation it exists to prevent, so this is not left to
-- application logic.
--
-- DEFERRABLE INITIALLY DEFERRED so the check runs at COMMIT. Transferring
-- ownership can therefore demote the old Owner and promote the new one in
-- either order within one transaction; only the final state must be valid.
CREATE FUNCTION assert_active_owner_remains() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM users
     WHERE role = 'owner'
       AND disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'At least one active Owner must remain. Promote another user to Owner first.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_users_owner_remains
  AFTER UPDATE OR DELETE ON users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_active_owner_remains();

-- ---------------------------------------------------------------------------
-- org_units
-- ---------------------------------------------------------------------------

CREATE TABLE org_units (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  name         text NOT NULL,
  kind         text NOT NULL DEFAULT 'department',
  parent_id    uuid REFERENCES org_units(id),
  description  text,

  disabled_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_org_units_kind
    CHECK (kind IN ('department', 'branch', 'team', 'other')),
  CONSTRAINT ck_org_units_name CHECK (length(trim(name)) > 0),
  CONSTRAINT ck_org_units_not_own_parent CHECK (parent_id IS DISTINCT FROM id)
);

-- Two live units may not share a name: an announcement addressed to "営業部"
-- must be unambiguous. Disabled units are excluded so a name can be reused.
CREATE UNIQUE INDEX uq_org_units_name
  ON org_units (lower(name))
  WHERE disabled_at IS NULL;

CREATE INDEX ix_org_units_parent ON org_units (parent_id);

CREATE TRIGGER trg_org_units_updated_at
  BEFORE UPDATE ON org_units
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- user_org_units
-- ---------------------------------------------------------------------------

CREATE TABLE user_org_units (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id      uuid NOT NULL REFERENCES users(id),
  org_unit_id  uuid NOT NULL REFERENCES org_units(id),
  is_primary   boolean NOT NULL DEFAULT false,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  left_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_user_org_units_left_after_joined
    CHECK (left_at IS NULL OR left_at >= joined_at)
);

-- One live membership per user per unit. Rejoining after leaving is allowed
-- because departed rows are excluded.
CREATE UNIQUE INDEX uq_user_org_unit_membership
  ON user_org_units (user_id, org_unit_id)
  WHERE left_at IS NULL;

-- At most one primary unit per user. TargetResolver and the member list both
-- assume "primary department" is singular.
CREATE UNIQUE INDEX uq_user_primary_org_unit
  ON user_org_units (user_id)
  WHERE is_primary AND left_at IS NULL;

CREATE INDEX ix_user_org_units_unit
  ON user_org_units (org_unit_id)
  WHERE left_at IS NULL;

-- ---------------------------------------------------------------------------
-- invitations
-- ---------------------------------------------------------------------------

CREATE TABLE invitations (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  email            text NOT NULL,
  role             text NOT NULL DEFAULT 'member',
  org_unit_id      uuid REFERENCES org_units(id),

  -- Only the hash is stored. The raw token appears once, in the invite link.
  token_hash       text NOT NULL,

  invited_by       uuid NOT NULL REFERENCES users(id),
  expires_at       timestamptz NOT NULL,
  accepted_at      timestamptz,
  accepted_user_id uuid REFERENCES users(id),
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_invitations_role CHECK (role IN ('owner', 'admin', 'member')),
  CONSTRAINT ck_invitations_accepted_pair CHECK (
    (accepted_at IS NULL AND accepted_user_id IS NULL)
    OR (accepted_at IS NOT NULL AND accepted_user_id IS NOT NULL)
  ),
  CONSTRAINT ck_invitations_not_accepted_and_revoked
    CHECK (NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX uq_invitations_token ON invitations (token_hash);

-- One outstanding invitation per address. Without this, resending produces
-- several live links and revoking one leaves the others working.
CREATE UNIQUE INDEX uq_invitations_pending_email
  ON invitations (lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- user_devices
-- ---------------------------------------------------------------------------

-- A device outlives any individual session. Sessions reference devices, never
-- the reverse: signing out must not orphan a push subscription, and revoking a
-- session must not silently disable notifications on that device.
CREATE TABLE user_devices (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id        uuid NOT NULL REFERENCES users(id),

  -- Random, generated once by the client and persisted locally (localStorage
  -- in the browser, app storage under Tauri). Clearing browser data yields a
  -- new device, which is acceptable.
  device_token   text NOT NULL,

  device_name    text,
  platform       text,
  browser        text,

  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_user_device_token ON user_devices (user_id, device_token);

CREATE INDEX ix_user_devices_user
  ON user_devices (user_id)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id            uuid NOT NULL REFERENCES users(id),
  user_device_id     uuid REFERENCES user_devices(id),

  -- SHA-256 of the session token. The raw value only ever exists in the
  -- cookie, so a database leak does not hand over live sessions.
  session_token_hash text NOT NULL,

  ip_address         inet,
  user_agent         text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  revoked_reason     text,

  CONSTRAINT ck_sessions_expires_after_created CHECK (expires_at > created_at),
  CONSTRAINT ck_sessions_revoked_reason CHECK (
    (revoked_at IS NULL AND revoked_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_sessions_token ON sessions (session_token_hash);

-- Drives the "your active sessions" list, which a user must be able to see and
-- revoke themselves.
CREATE INDEX ix_sessions_user_live
  ON sessions (user_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX ix_sessions_device ON sessions (user_device_id);

-- ---------------------------------------------------------------------------
-- audit_logs
-- ---------------------------------------------------------------------------

-- Append-only, system-wide, and deliberately separate from the per-announcement
-- business timeline. No foreign key cascades ever remove rows from here.
CREATE TABLE audit_logs (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),

  -- NULL for anonymous events such as a failed sign-in with an unknown address.
  actor_user_id  uuid REFERENCES users(id),

  action         text NOT NULL,
  resource_type  text,
  resource_id    uuid,
  outcome        text NOT NULL DEFAULT 'success',

  ip_address     inet,
  user_agent     text,
  request_id     text,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_audit_logs_outcome CHECK (outcome IN ('success', 'failure', 'denied')),
  CONSTRAINT ck_audit_logs_action CHECK (length(trim(action)) > 0)
);

CREATE INDEX ix_audit_logs_created ON audit_logs (created_at DESC);
CREATE INDEX ix_audit_logs_actor ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX ix_audit_logs_resource ON audit_logs (resource_type, resource_id, created_at DESC);
CREATE INDEX ix_audit_logs_action ON audit_logs (action, created_at DESC);

COMMENT ON TABLE audit_logs IS
  'Append-only security audit trail. Not modifiable through the application by any role, including Owner. Distinct from announcement_events, which is the administrator-facing business timeline.';

-- Down Migration

DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS user_devices;
DROP TABLE IF EXISTS invitations;
DROP TABLE IF EXISTS user_org_units;
DROP TABLE IF EXISTS org_units;

DROP TRIGGER IF EXISTS trg_users_owner_remains ON users;
DROP FUNCTION IF EXISTS assert_active_owner_remains();
DROP TABLE IF EXISTS users;
