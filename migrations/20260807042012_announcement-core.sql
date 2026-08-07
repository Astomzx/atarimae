-- announcement-core
--
-- Implements docs/architecture/announcement-model.md, which is frozen. Field
-- names, state semantics and constraints here are the ones that document
-- settled on; changing them means rewriting foreign keys and indexes.
--
-- The model exists to make acknowledgement statistics trustworthy. Six things
-- must be impossible, and each is prevented by something below:
--
--   1. a completed acknowledgement disappearing from history
--   2. one person counting twice in a denominator
--   3. the denominator moving because somebody changed department
--   4. an administrator seeing "success" while nobody was affected
--   5. a published announcement notifying nobody
--   6. a statistic nobody can explain

-- Up Migration

-- ---------------------------------------------------------------------------
-- announcements
-- ---------------------------------------------------------------------------

CREATE TABLE announcements (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),

  -- Whether publishing should create acknowledgement obligations. An
  -- announcement that needs no acknowledgement creates none at all, which is
  -- why obligations carry no `required` flag of their own.
  requires_acknowledgement boolean NOT NULL DEFAULT false,

  -- Default deadline. Per-person overrides live in
  -- announcement_user_due_overrides; the value actually enforced is frozen
  -- onto each obligation at creation.
  acknowledgement_due_at   timestamptz,

  -- Set on publish. NULL means the announcement has never been published, and
  -- assign_obligations must refuse rather than bind a draft.
  current_published_content_revision_id uuid,
  current_target_version_id             uuid,

  visible_until timestamptz,
  archived_at   timestamptz,

  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_announcements_updated_at
  BEFORE UPDATE ON announcements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Status is derived, never stored: draft when nothing is published, archived
-- when archived_at is set, published otherwise. A stored status drifts from
-- the columns that actually define it.
COMMENT ON TABLE announcements IS
  'Status is derived: archived_at IS NOT NULL -> archived; current_published_content_revision_id IS NULL -> draft; otherwise published.';

-- ---------------------------------------------------------------------------
-- content revisions
-- ---------------------------------------------------------------------------

CREATE TABLE announcement_content_revisions (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  announcement_id uuid NOT NULL REFERENCES announcements(id),
  version_no      integer NOT NULL,
  title           text NOT NULL,
  body            text NOT NULL,

  -- content_minor never creates obligations. Only content_major may, and only
  -- when the publisher explicitly asks. Target changes are NOT content
  -- revisions -- they get their own versioning below.
  change_kind     text NOT NULL,
  requires_reacknowledgement boolean NOT NULL DEFAULT false,

  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_content_revision_change_kind
    CHECK (change_kind IN ('initial', 'content_minor', 'content_major')),
  CONSTRAINT ck_content_revision_title CHECK (length(trim(title)) > 0),

  -- Only a major change can demand re-acknowledgement. Allowing it on a typo
  -- fix would let an accidental click re-ask hundreds of people.
  CONSTRAINT ck_content_revision_reack_requires_major
    CHECK (NOT requires_reacknowledgement OR change_kind = 'content_major')
);

CREATE UNIQUE INDEX uq_content_revision_version
  ON announcement_content_revisions (announcement_id, version_no);

CREATE INDEX ix_content_revisions_announcement
  ON announcement_content_revisions (announcement_id, version_no DESC);

ALTER TABLE announcements
  ADD CONSTRAINT fk_announcements_published_revision
  FOREIGN KEY (current_published_content_revision_id)
  REFERENCES announcement_content_revisions(id);

-- ---------------------------------------------------------------------------
-- target versions and targets
-- ---------------------------------------------------------------------------

-- Changing who an announcement is aimed at is versioned separately from
-- changing what it says. Conflating them means every historical query has to
-- ask "was this revision a content change or a scope change?", and the
-- re-acknowledgement rules become impossible to state.
CREATE TABLE announcement_target_versions (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  announcement_id uuid NOT NULL REFERENCES announcements(id),
  version_no      integer NOT NULL,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_target_version_version
  ON announcement_target_versions (announcement_id, version_no);

ALTER TABLE announcements
  ADD CONSTRAINT fk_announcements_target_version
  FOREIGN KEY (current_target_version_id)
  REFERENCES announcement_target_versions(id);

-- Real foreign keys rather than a polymorphic target_id, which the database
-- could not validate. This is only possible because users and org_units are
-- never physically deleted.
CREATE TABLE announcement_targets (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  target_version_id uuid NOT NULL REFERENCES announcement_target_versions(id),
  target_kind       text NOT NULL,
  org_unit_id       uuid REFERENCES org_units(id),
  user_id           uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_target_reference CHECK (
    (target_kind = 'all'      AND org_unit_id IS NULL     AND user_id IS NULL)
    OR (target_kind = 'org_unit' AND org_unit_id IS NOT NULL AND user_id IS NULL)
    OR (target_kind = 'user'     AND org_unit_id IS NULL     AND user_id IS NOT NULL)
  )
);

CREATE INDEX ix_targets_version ON announcement_targets (target_version_id);

-- The same unit or person listed twice in one version would double-count
-- during expansion.
CREATE UNIQUE INDEX uq_target_org_unit
  ON announcement_targets (target_version_id, org_unit_id)
  WHERE org_unit_id IS NOT NULL;

CREATE UNIQUE INDEX uq_target_user
  ON announcement_targets (target_version_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX uq_target_all
  ON announcement_targets (target_version_id)
  WHERE target_kind = 'all';

-- ---------------------------------------------------------------------------
-- recipients
-- ---------------------------------------------------------------------------

-- The materialised fact: these people, at publish time. Statistics are
-- computed from this snapshot, never from current department membership --
-- otherwise a transfer would silently move a historical acknowledgement rate.
CREATE TABLE announcement_recipients (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  announcement_id uuid NOT NULL REFERENCES announcements(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  assigned_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_announcement_recipient
  ON announcement_recipients (announcement_id, user_id);

CREATE INDEX ix_recipients_user ON announcement_recipients (user_id);

-- Why this person was included. History only: it must never be used to decide
-- whether they are *currently* in scope, because the target rows it points at
-- belong to whichever version was live at the time.
CREATE TABLE announcement_recipient_sources (
  recipient_id uuid NOT NULL REFERENCES announcement_recipients(id),
  target_id    uuid NOT NULL REFERENCES announcement_targets(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recipient_id, target_id)
);

COMMENT ON TABLE announcement_recipient_sources IS
  'History only. Never use to determine current target coverage -- re-resolve the current target version instead.';

-- ---------------------------------------------------------------------------
-- personalizations
-- ---------------------------------------------------------------------------

-- Keyed by (announcement_id, user_id), never by recipient: the editor writes
-- per-person content while the announcement is still a draft, and recipients
-- do not exist until publish.
CREATE TABLE announcement_personalizations (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  announcement_id uuid NOT NULL REFERENCES announcements(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  version_no      integer NOT NULL,
  personal_body   text NOT NULL,
  change_kind     text NOT NULL,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  superseded_at   timestamptz,

  CONSTRAINT ck_personalization_change_kind
    CHECK (change_kind IN ('initial', 'personal_minor', 'personal_major'))
);

CREATE UNIQUE INDEX uq_active_personalization
  ON announcement_personalizations (announcement_id, user_id)
  WHERE superseded_at IS NULL;

CREATE UNIQUE INDEX uq_personalization_version
  ON announcement_personalizations (announcement_id, user_id, version_no);

-- ---------------------------------------------------------------------------
-- per-user due date overrides
-- ---------------------------------------------------------------------------

-- Also keyed by user rather than recipient, for the same reason: CSV import
-- happens before publish.
CREATE TABLE announcement_user_due_overrides (
  announcement_id uuid NOT NULL REFERENCES announcements(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  due_at          timestamptz,
  updated_by      uuid NOT NULL REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);

-- ---------------------------------------------------------------------------
-- acknowledgement obligations
-- ---------------------------------------------------------------------------

CREATE TABLE announcement_ack_obligations (
  id                          uuid PRIMARY KEY DEFAULT uuidv7(),
  recipient_id                uuid NOT NULL REFERENCES announcement_recipients(id),
  content_revision_id         uuid NOT NULL REFERENCES announcement_content_revisions(id),

  -- Nullable: most people on a plain announcement have no personal content.
  personalization_revision_id uuid REFERENCES announcement_personalizations(id),

  previous_obligation_id      uuid REFERENCES announcement_ack_obligations(id),

  assigned_at                 timestamptz NOT NULL DEFAULT now(),

  -- Resolved once, at creation: per-user override, else the announcement
  -- default, else none. The reminder worker reads only this column -- deriving
  -- it at send time would let an edit retroactively move every deadline with
  -- no record of the change.
  due_at                      timestamptz,

  waived_at                   timestamptz,
  waived_reason               text,
  superseded_at               timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_obligation_not_waived_and_superseded
    CHECK (NOT (waived_at IS NOT NULL AND superseded_at IS NOT NULL)),

  -- An unexplained waive is useless when someone later asks why the
  -- denominator changed.
  CONSTRAINT ck_obligation_waive_reason CHECK (
    (waived_at IS NULL AND waived_reason IS NULL)
    OR (waived_at IS NOT NULL AND waived_reason IS NOT NULL)
  ),

  CONSTRAINT ck_obligation_not_own_successor
    CHECK (previous_obligation_id IS DISTINCT FROM id)
);

-- The single most important constraint in the schema.
--
-- One recipient may hold at most one live obligation. Without it, any logic
-- bug counts somebody twice in the denominator, and the error is undetectable
-- after the fact -- the number simply looks slightly wrong forever.
--
-- Re-acknowledgement must therefore mark the old row superseded *before*
-- inserting the successor, inside one transaction.
CREATE UNIQUE INDEX uq_active_obligation_per_recipient
  ON announcement_ack_obligations (recipient_id)
  WHERE waived_at IS NULL AND superseded_at IS NULL;

CREATE INDEX ix_obligations_recipient ON announcement_ack_obligations (recipient_id);

-- Drives the reminder worker.
CREATE INDEX ix_obligations_due
  ON announcement_ack_obligations (due_at)
  WHERE waived_at IS NULL AND superseded_at IS NULL AND due_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- acknowledgements
-- ---------------------------------------------------------------------------

-- Immutable evidence. Re-acknowledgement creates a new obligation; it never
-- overwrites or deletes one of these rows.
CREATE TABLE announcement_acknowledgements (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  obligation_id   uuid NOT NULL REFERENCES announcement_ack_obligations(id),
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  client_type     text NOT NULL,
  device_id       uuid REFERENCES user_devices(id),
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_acknowledgement_client_type
    CHECK (client_type IN ('web', 'pwa', 'desktop', 'api'))
);

CREATE UNIQUE INDEX uq_acknowledgement_once
  ON announcement_acknowledgements (obligation_id);

-- ---------------------------------------------------------------------------
-- business timeline
-- ---------------------------------------------------------------------------

-- Administrator-facing narrative, distinct from audit_logs. Both are written
-- for the same action; they must never be merged. This one answers "what
-- happened to this announcement", audit_logs answers "who did what, from
-- where, with what outcome".
CREATE TABLE announcement_events (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  announcement_id uuid NOT NULL REFERENCES announcements(id),
  event_type      text NOT NULL,
  actor_user_id   uuid REFERENCES users(id),
  subject_user_id uuid REFERENCES users(id),
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id      text,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_announcement_event_type CHECK (
    event_type IN (
      'created',
      'content_revised',
      'published',
      'targets_changed',
      'recipients_added',
      'obligations_assigned',
      'reacknowledgement_requested',
      'obligations_waived',
      'personalization_changed',
      'due_at_changed',
      'archived'
    )
  )
);

CREATE INDEX ix_announcement_events_announcement
  ON announcement_events (announcement_id, created_at DESC);

-- Down Migration

DROP TABLE IF EXISTS announcement_events;
DROP TABLE IF EXISTS announcement_acknowledgements;
DROP TABLE IF EXISTS announcement_ack_obligations;
DROP TABLE IF EXISTS announcement_user_due_overrides;
DROP TABLE IF EXISTS announcement_personalizations;
DROP TABLE IF EXISTS announcement_recipient_sources;
DROP TABLE IF EXISTS announcement_recipients;

ALTER TABLE announcements DROP CONSTRAINT IF EXISTS fk_announcements_target_version;
ALTER TABLE announcements DROP CONSTRAINT IF EXISTS fk_announcements_published_revision;

DROP TABLE IF EXISTS announcement_targets;
DROP TABLE IF EXISTS announcement_target_versions;
DROP TABLE IF EXISTS announcement_content_revisions;
DROP TABLE IF EXISTS announcements;
