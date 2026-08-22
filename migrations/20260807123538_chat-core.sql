-- chat-core
--
-- Chat core: channels, direct messages, text, attachments, mentions, unread state.
--
-- Deliberately NOT here (after v1.0): editing, deletion, reactions, link
-- previews, full-text search, threads, presence, typing indicators. Chat is the
-- least differentiated part of this product — every competitor has it — so the
-- v1.0 scope is what makes it usable, not what makes it complete.
--
-- The product rule that shapes this: phone and PC are not two different
-- products. Nothing below can be available on one and missing on the other.

-- Up Migration

-- ---------------------------------------------------------------------------
-- channels
-- ---------------------------------------------------------------------------

CREATE TABLE channels (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  kind        text NOT NULL,

  -- Null for direct and group conversations, which are named after their
  -- participants rather than carrying a title.
  name        text,
  description text,

  created_by  uuid NOT NULL REFERENCES users(id),
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_channel_kind CHECK (kind IN ('public', 'private', 'direct', 'group')),

  -- Named channels must have a name; conversations must not.
  CONSTRAINT ck_channel_name CHECK (
    (kind IN ('public', 'private') AND name IS NOT NULL AND length(trim(name)) > 0)
    OR (kind IN ('direct', 'group') AND name IS NULL)
  )
);

CREATE TRIGGER trg_channels_updated_at
  BEFORE UPDATE ON channels
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Two live channels may not share a name, for the same reason as org units:
-- "#営業" has to be unambiguous.
CREATE UNIQUE INDEX uq_channel_name
  ON channels (lower(name))
  WHERE name IS NOT NULL AND archived_at IS NULL;

CREATE INDEX ix_channels_kind ON channels (kind) WHERE archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- membership
-- ---------------------------------------------------------------------------

CREATE TABLE channel_members (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  channel_id           uuid NOT NULL REFERENCES channels(id),
  user_id              uuid NOT NULL REFERENCES users(id),

  -- Read position rather than a per-message read table: a boolean per message
  -- per member is millions of rows for one office, and answers a question
  -- nobody asks. "Where had I got to" is the useful one.
  last_read_message_id uuid,
  last_read_at         timestamptz,

  muted                boolean NOT NULL DEFAULT false,
  joined_at            timestamptz NOT NULL DEFAULT now(),
  left_at              timestamptz
);

CREATE UNIQUE INDEX uq_channel_member
  ON channel_members (channel_id, user_id)
  WHERE left_at IS NULL;

CREATE INDEX ix_channel_members_user
  ON channel_members (user_id)
  WHERE left_at IS NULL;

-- ---------------------------------------------------------------------------
-- direct conversation identity
-- ---------------------------------------------------------------------------

-- Two people must never end up with two separate one-to-one conversations —
-- half the history in each is worse than none.
--
-- The pair is stored with the lower id first so (A,B) and (B,A) are the same
-- row, which a unique index over channel_members could not express.
CREATE TABLE direct_conversations (
  channel_id  uuid PRIMARY KEY REFERENCES channels(id),
  user_a_id   uuid NOT NULL REFERENCES users(id),
  user_b_id   uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_direct_ordered CHECK (user_a_id < user_b_id)
);

CREATE UNIQUE INDEX uq_direct_pair ON direct_conversations (user_a_id, user_b_id);

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------

CREATE TABLE messages (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  channel_id  uuid NOT NULL REFERENCES channels(id),
  author_id   uuid NOT NULL REFERENCES users(id),

  body        text NOT NULL,

  -- Reply-to is in the chat core because a thread of two is how questions actually get
  -- answered; full threading is not.
  reply_to_id uuid REFERENCES messages(id),

  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_message_body CHECK (length(body) > 0 AND length(body) <= 10000),
  CONSTRAINT ck_message_not_own_reply CHECK (reply_to_id IS DISTINCT FROM id)
);

-- The pagination index. uuidv7 is time-ordered, so id DESC is chronological
-- and no separate created_at index is needed for the common query.
CREATE INDEX ix_messages_channel ON messages (channel_id, id DESC);

CREATE INDEX ix_messages_author ON messages (author_id);

ALTER TABLE channel_members
  ADD CONSTRAINT fk_channel_members_last_read
  FOREIGN KEY (last_read_message_id) REFERENCES messages(id);

-- ---------------------------------------------------------------------------
-- attachments
-- ---------------------------------------------------------------------------

CREATE TABLE message_attachments (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  message_id    uuid NOT NULL REFERENCES messages(id),

  -- What the uploader called it. Shown to people, never used as a path.
  original_name text NOT NULL,

  -- Where it actually lives, generated server-side. Keeping these separate is
  -- what makes path traversal through a crafted filename impossible.
  storage_key   text NOT NULL,

  -- Determined by inspecting the file, not taken from the upload's
  -- Content-Type header, which the browser lets anybody set.
  content_type  text NOT NULL,
  byte_size     bigint NOT NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_attachment_size CHECK (byte_size > 0 AND byte_size <= 26214400),
  CONSTRAINT ck_attachment_name CHECK (length(trim(original_name)) > 0)
);

CREATE UNIQUE INDEX uq_attachment_storage_key ON message_attachments (storage_key);
CREATE INDEX ix_attachments_message ON message_attachments (message_id);

-- ---------------------------------------------------------------------------
-- mentions
-- ---------------------------------------------------------------------------

-- Extracted at write time rather than scanned at read time, so "what mentions
-- me" is an index lookup instead of a scan of every message ever sent.
CREATE TABLE message_mentions (
  message_id uuid NOT NULL REFERENCES messages(id),
  user_id    uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX ix_mentions_user ON message_mentions (user_id, message_id DESC);

-- Down Migration

DROP TABLE IF EXISTS message_mentions;
DROP TABLE IF EXISTS message_attachments;

ALTER TABLE channel_members DROP CONSTRAINT IF EXISTS fk_channel_members_last_read;

DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS direct_conversations;
DROP TABLE IF EXISTS channel_members;
DROP TABLE IF EXISTS channels;
