-- department-channels
--
-- Every organisation unit owns one private channel whose membership follows
-- the unit. Posting can be restricted without making the history disappear:
-- the channel-level policy and the per-member mute are separate facts.

-- Up Migration

ALTER TABLE channels
  ADD COLUMN org_unit_id uuid REFERENCES org_units(id),
  ADD COLUMN posting_policy text NOT NULL DEFAULT 'everyone';

ALTER TABLE channels
  ADD CONSTRAINT ck_channels_posting_policy
    CHECK (posting_policy IN ('everyone', 'admins_only')),
  ADD CONSTRAINT ck_direct_channels_posting_policy
    CHECK (kind <> 'direct' OR posting_policy = 'everyone');

-- A managed department channel has no independent name. The API joins the
-- current unit name, so renaming a department cannot leave the chat behind.
ALTER TABLE channels DROP CONSTRAINT ck_channel_name;
ALTER TABLE channels
  ADD CONSTRAINT ck_channel_name CHECK (
    (org_unit_id IS NOT NULL AND kind = 'private' AND name IS NULL)
    OR
    (org_unit_id IS NULL AND kind IN ('public', 'private')
      AND name IS NOT NULL AND length(trim(name)) > 0)
    OR
    (org_unit_id IS NULL AND kind IN ('direct', 'group') AND name IS NULL)
  );

CREATE UNIQUE INDEX uq_channels_org_unit ON channels (org_unit_id)
  WHERE org_unit_id IS NOT NULL;

ALTER TABLE channel_members
  ADD COLUMN muted_by_admin boolean NOT NULL DEFAULT false;

-- Existing units receive their channel during the migration. created_by is a
-- required historical fact, so the oldest Owner is used consistently.
INSERT INTO channels (kind, name, description, created_by, org_unit_id, archived_at)
SELECT 'private', NULL, o.description, owner.id, o.id, o.disabled_at
  FROM org_units o
 CROSS JOIN LATERAL (
   SELECT id FROM users
    WHERE role = 'owner' AND kind = 'person'
    ORDER BY created_at, id
    LIMIT 1
 ) owner
ON CONFLICT (org_unit_id) WHERE org_unit_id IS NOT NULL DO NOTHING;

INSERT INTO channel_members (channel_id, user_id, joined_at)
SELECT c.id, m.user_id, m.joined_at
  FROM channels c
  JOIN user_org_units m ON m.org_unit_id = c.org_unit_id
 WHERE c.org_unit_id IS NOT NULL AND m.left_at IS NULL
ON CONFLICT (channel_id, user_id) WHERE left_at IS NULL DO NOTHING;

-- Membership is an invariant, not a route convention. Invitations, restores
-- and future import paths all write user_org_units and therefore get the same
-- department chat result.
CREATE FUNCTION sync_org_unit_channel_member() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  managed_channel_id uuid;
BEGIN
  SELECT id INTO managed_channel_id
    FROM channels
   WHERE org_unit_id = NEW.org_unit_id;

  IF managed_channel_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.left_at IS NULL THEN
    INSERT INTO channel_members (channel_id, user_id, joined_at)
    VALUES (managed_channel_id, NEW.user_id, NEW.joined_at)
    ON CONFLICT (channel_id, user_id) WHERE left_at IS NULL DO NOTHING;
  ELSIF TG_OP = 'UPDATE' AND OLD.left_at IS NULL THEN
    UPDATE channel_members
       SET left_at = NEW.left_at
     WHERE channel_id = managed_channel_id
       AND user_id = NEW.user_id
       AND left_at IS NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_user_org_units_channel_member
  AFTER INSERT OR UPDATE OF left_at ON user_org_units
  FOR EACH ROW EXECUTE FUNCTION sync_org_unit_channel_member();

-- Disabling a unit makes its chat read-only and removes it from normal lists;
-- restoring the unit restores the same history instead of creating a new room.
CREATE FUNCTION sync_org_unit_channel_archive() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE channels
     SET archived_at = NEW.disabled_at
   WHERE org_unit_id = NEW.id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_org_units_channel_archive
  AFTER UPDATE OF disabled_at ON org_units
  FOR EACH ROW EXECUTE FUNCTION sync_org_unit_channel_archive();

-- Down Migration

DROP TRIGGER IF EXISTS trg_org_units_channel_archive ON org_units;
DROP FUNCTION IF EXISTS sync_org_unit_channel_archive();
DROP TRIGGER IF EXISTS trg_user_org_units_channel_member ON user_org_units;
DROP FUNCTION IF EXISTS sync_org_unit_channel_member();

DELETE FROM channels WHERE org_unit_id IS NOT NULL;

ALTER TABLE channel_members DROP COLUMN IF EXISTS muted_by_admin;
DROP INDEX IF EXISTS uq_channels_org_unit;

ALTER TABLE channels DROP CONSTRAINT IF EXISTS ck_channel_name;
ALTER TABLE channels DROP CONSTRAINT IF EXISTS ck_channels_posting_policy;
ALTER TABLE channels DROP CONSTRAINT IF EXISTS ck_direct_channels_posting_policy;
ALTER TABLE channels
  DROP COLUMN IF EXISTS posting_policy,
  DROP COLUMN IF EXISTS org_unit_id;

ALTER TABLE channels
  ADD CONSTRAINT ck_channel_name CHECK (
    (kind IN ('public', 'private') AND name IS NOT NULL AND length(trim(name)) > 0)
    OR (kind IN ('direct', 'group') AND name IS NULL)
  );
