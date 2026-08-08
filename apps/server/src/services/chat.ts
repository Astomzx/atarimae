import { ChatErrorCode } from "@atarimae/api-schema";

import type { DatabaseClient } from "../db.js";
import { ApiError } from "../errors.js";

/**
 * Channel access, in one place.
 *
 * Every chat route calls through here rather than writing its own membership
 * check, because "can this person read this channel" has three different
 * answers depending on kind, and duplicating that logic is how one endpoint
 * eventually leaks a private conversation.
 */

export interface ChannelAccess {
  channelId: string;
  kind: "public" | "private" | "direct" | "group";
  isMember: boolean;
  archived: boolean;
}

export async function loadChannelAccess(
  client: DatabaseClient,
  channelId: string,
  userId: string,
): Promise<ChannelAccess> {
  const { rows } = await client.query<{
    kind: ChannelAccess["kind"];
    archived_at: string | null;
    is_member: boolean;
  }>(
    `SELECT c.kind,
            c.archived_at,
            EXISTS (
              SELECT 1 FROM channel_members m
               WHERE m.channel_id = c.id AND m.user_id = $2 AND m.left_at IS NULL
            ) AS is_member
       FROM channels c
      WHERE c.id = $1`,
    [channelId, userId],
  );

  const row = rows[0];
  if (!row) throw ApiError.notFound("Channel not found.");

  return {
    channelId,
    kind: row.kind,
    isMember: row.is_member,
    archived: row.archived_at !== null,
  };
}

/**
 * A public channel is readable by anyone signed in — that is what makes it
 * public. Everything else requires membership.
 *
 * `notFound` rather than `forbidden` for private channels: confirming that a
 * private channel exists tells an outsider something they should not learn
 * from a 403.
 */
export function assertCanRead(access: ChannelAccess): void {
  if (access.kind === "public" || access.isMember) return;
  throw ApiError.notFound("Channel not found.");
}

/** Posting always requires membership, including in a public channel. */
export function assertCanPost(access: ChannelAccess): void {
  assertCanRead(access);

  if (!access.isMember) {
    throw new ApiError(
      403,
      ChatErrorCode.CHANNEL_FORBIDDEN,
      "Join this channel before posting.",
    );
  }
  if (access.archived) {
    throw new ApiError(
      422,
      ChatErrorCode.CHANNEL_ARCHIVED,
      "This channel has been archived.",
    );
  }
}

/**
 * Finds or creates the one-to-one conversation between two people.
 *
 * The pair is stored ordered, so (A,B) and (B,A) resolve to the same row and
 * two people can never accumulate two conversations holding half the history
 * each. `ON CONFLICT DO NOTHING` closes the race where both open it at once.
 */
export async function openDirectConversation(
  client: DatabaseClient,
  userId: string,
  otherUserId: string,
): Promise<string> {
  if (userId === otherUserId) {
    throw new ApiError(
      422,
      ChatErrorCode.CANNOT_MESSAGE_SELF,
      "You cannot start a conversation with yourself.",
    );
  }

  const { rows: others } = await client.query<{ id: string }>(
    "SELECT id FROM users WHERE id = $1 AND disabled_at IS NULL AND anonymized_at IS NULL",
    [otherUserId],
  );
  if (!others[0]) throw ApiError.notFound("User not found.");

  const [a, b] = userId < otherUserId ? [userId, otherUserId] : [otherUserId, userId];

  const { rows: existing } = await client.query<{ channel_id: string }>(
    "SELECT channel_id FROM direct_conversations WHERE user_a_id = $1 AND user_b_id = $2",
    [a, b],
  );
  if (existing[0]) return existing[0].channel_id;

  const { rows: created } = await client.query<{ id: string }>(
    `INSERT INTO channels (kind, created_by) VALUES ('direct', $1) RETURNING id`,
    [userId],
  );
  const channelId = created[0]!.id;

  const { rows: linked } = await client.query<{ channel_id: string }>(
    `INSERT INTO direct_conversations (channel_id, user_a_id, user_b_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_a_id, user_b_id) DO NOTHING
     RETURNING channel_id`,
    [channelId, a, b],
  );

  // Somebody else created it between the check and the insert. Use theirs and
  // abandon the empty channel row we just made.
  if (!linked[0]) {
    await client.query("DELETE FROM channels WHERE id = $1", [channelId]);
    const { rows } = await client.query<{ channel_id: string }>(
      "SELECT channel_id FROM direct_conversations WHERE user_a_id = $1 AND user_b_id = $2",
      [a, b],
    );
    return rows[0]!.channel_id;
  }

  await client.query(
    `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2), ($1, $3)`,
    [channelId, a, b],
  );

  return channelId;
}

/**
 * Attaches uploaded files to the message that carries them.
 *
 * Every id must pass all four conditions in one statement: it exists, this
 * person uploaded it, it was uploaded to this channel, and nothing has claimed
 * it yet. Whatever does not match is not silently skipped — the count is
 * compared and the whole send fails.
 *
 * Dropping an attachment and delivering the message anyway is the exact
 * failure this product argues against: a report of success, with the thing
 * anybody cared about missing.
 */
export async function claimAttachments(
  client: DatabaseClient,
  messageId: string,
  channelId: string,
  userId: string,
  attachmentIds: readonly string[],
): Promise<void> {
  if (attachmentIds.length === 0) return;

  const unique = [...new Set(attachmentIds)];

  const { rows } = await client.query<{ id: string }>(
    `UPDATE message_attachments
        SET message_id = $1
      WHERE id = ANY($2::uuid[])
        AND message_id IS NULL
        AND channel_id = $3
        AND uploaded_by = $4
      RETURNING id`,
    [messageId, unique, channelId, userId],
  );

  if (rows.length !== unique.length) {
    const claimed = new Set(rows.map((row) => row.id));

    throw new ApiError(
      422,
      ChatErrorCode.ATTACHMENT_NOT_CLAIMABLE,
      "One or more attachments could not be attached to this message.",
      { attachmentIds: unique.filter((id) => !claimed.has(id)) },
    );
  }
}

/**
 * Extracts @mentions from a message body.
 *
 * Resolved at write time so "what mentions me" is an index lookup rather than
 * a scan of every message ever sent. Only members of the channel can be
 * mentioned — an @ in a private channel must not notify somebody who cannot
 * read it.
 */
export async function resolveMentions(
  client: DatabaseClient,
  channelId: string,
  body: string,
): Promise<string[]> {
  // Display names may contain spaces, so matching on the name is ambiguous.
  // The client sends @<uuid> and renders it as a name.
  const ids = [
    ...new Set(
      [
        ...body.matchAll(
          /@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi,
        ),
      ].map((match) => match[1]!.toLowerCase()),
    ),
  ];
  if (ids.length === 0) return [];

  const { rows } = await client.query<{ user_id: string }>(
    `SELECT m.user_id
       FROM channel_members m
      WHERE m.channel_id = $1 AND m.left_at IS NULL AND m.user_id = ANY($2::uuid[])`,
    [channelId, ids],
  );

  return rows.map((r) => r.user_id);
}
