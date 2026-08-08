-- chat-attachments
--
-- M6a, brought forward: chat-core created message_attachments with a NOT NULL
-- message_id, which assumed a file could only exist once its message did. That
-- is the wrong order. Somebody picks a file, waits for it to upload, and only
-- then finishes typing — so the row has to exist before the message does.
--
-- What that costs is a row with no message yet, and the two questions it
-- raises: who may download it, and what removes the ones nobody ever sent.
-- Both are answered by columns here rather than by convention.

-- Up Migration

-- The channel is fixed at upload time, not inherited from the message later.
--
-- Two failures this makes impossible: a file uploaded to a private channel
-- being attached to a public message, and a download whose permission cannot
-- be decided until the file has been sent somewhere.
ALTER TABLE message_attachments
  ADD COLUMN channel_id uuid REFERENCES channels(id);

ALTER TABLE message_attachments
  ADD COLUMN uploaded_by uuid REFERENCES users(id);

-- Existing rows: there are none in any deployment (chat has never had an
-- upload endpoint), but the backfill makes the NOT NULL below safe rather than
-- conditional on that being true.
UPDATE message_attachments a
   SET channel_id = m.channel_id,
       uploaded_by = m.author_id
  FROM messages m
 WHERE m.id = a.message_id
   AND a.channel_id IS NULL;

ALTER TABLE message_attachments
  ALTER COLUMN channel_id SET NOT NULL,
  ALTER COLUMN uploaded_by SET NOT NULL;

-- Null until the message that carries it is created, in the same transaction.
ALTER TABLE message_attachments
  ALTER COLUMN message_id DROP NOT NULL;

-- The sweep for uploads that were never sent. Partial, because the rows that
-- matter are a vanishing fraction of the table and a full index on created_at
-- would be paid for on every upload forever.
CREATE INDEX ix_attachments_unclaimed
  ON message_attachments (created_at)
  WHERE message_id IS NULL;

CREATE INDEX ix_attachments_channel ON message_attachments (channel_id);

-- Down Migration

DROP INDEX IF EXISTS ix_attachments_channel;
DROP INDEX IF EXISTS ix_attachments_unclaimed;

-- Restoring NOT NULL means the unattached rows cannot stay: they are files
-- nobody sent, and there is no message for them to point at. Deleting them is
-- the only way this migration reverses at all — the alternative is a Down that
-- fails on any database where somebody once picked a file and changed their
-- mind. The files themselves are removed by the same sweep that removes
-- expired uploads.
DELETE FROM message_attachments WHERE message_id IS NULL;

ALTER TABLE message_attachments
  ALTER COLUMN message_id SET NOT NULL;

ALTER TABLE message_attachments
  DROP COLUMN IF EXISTS uploaded_by,
  DROP COLUMN IF EXISTS channel_id;
