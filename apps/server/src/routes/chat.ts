import {
  ChatErrorCode,
  CreateChannelRequest,
  errorResponses,
  ListChannelMembersResponse,
  ListChannelsResponse,
  ListMessagesQuery,
  ListMessagesResponse,
  MarkReadRequest,
  Message,
  OpenDirectRequest,
  SendMessageRequest,
  UploadAttachmentResponse,
  UpdateChannelMemberMuteRequest,
  UpdateChannelModerationRequest,
  Uuid,
  type ChannelSummary,
} from "@atarimae/api-schema";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import { withTransaction } from "../db.js";
import { ApiError } from "../errors.js";
import { AuditAction, writeAudit } from "../lib/audit.js";
import {
  ALLOWED_TYPES,
  encodeFileName,
  MAX_ATTACHMENT_BYTES,
  parseFileName,
  storageKeyFor,
  validateUpload,
  type UploadRejection,
} from "../lib/attachments.js";
import { requireAuth, requireRole } from "../plugins/auth.js";
import {
  assertCanPost,
  assertCanRead,
  claimAttachments,
  loadChannelAccess,
  openDirectConversation,
  resolveMentions,
} from "../services/chat.js";

interface MessageRow {
  id: string;
  channel_id: string;
  author_id: string;
  author_name: string;
  body: string;
  reply_to_id: string | null;
  reply_to_preview: string | null;
  created_at: string;
  mentions: string[] | null;
  attachments:
    { id: string; name: string; contentType: string; byteSize: number }[] | null;
}

/**
 * Whether a stored type may be shown in the conversation rather than only
 * downloaded.
 *
 * Derived from the same table the upload was validated against, so a format
 * cannot become inline by being stored with a different content type than the
 * one its bytes earned.
 */
function isInlineType(contentType: string): boolean {
  return Object.values(ALLOWED_TYPES).some(
    (kind) => kind.contentType === contentType && kind.inline === true,
  );
}

const SELECT_MESSAGE = `
  SELECT m.id, m.channel_id, m.author_id, u.display_name AS author_name,
         m.body, m.reply_to_id, m.created_at,
         (SELECT left(p.body, 120) FROM messages p WHERE p.id = m.reply_to_id)
           AS reply_to_preview,
         COALESCE(
           (SELECT json_agg(mm.user_id) FROM message_mentions mm
             WHERE mm.message_id = m.id), '[]'::json
         ) AS mentions,
         COALESCE(
           (SELECT json_agg(json_build_object(
                     'id', a.id, 'name', a.original_name,
                     'contentType', a.content_type, 'byteSize', a.byte_size))
              FROM message_attachments a WHERE a.message_id = m.id), '[]'::json
         ) AS attachments
    FROM messages m
    JOIN users u ON u.id = m.author_id
`;

function toMessage(row: MessageRow) {
  return {
    id: row.id,
    channelId: row.channel_id,
    authorId: row.author_id,
    authorName: row.author_name,
    body: row.body,
    replyToId: row.reply_to_id,
    replyToPreview: row.reply_to_preview,
    mentions: row.mentions ?? [],
    attachments: (row.attachments ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      contentType: a.contentType,
      byteSize: Number(a.byteSize),
      url: `/api/v1/attachments/${a.id}`,
      inline: isInlineType(a.contentType),
    })),
    createdAt: row.created_at,
  };
}

/** Each rejection gets its own code, so the client can say which rule was hit. */
function rejectionToError(reason: UploadRejection): [number, string, string] {
  switch (reason) {
    case "EMPTY":
      return [422, ChatErrorCode.ATTACHMENT_EMPTY, "The file is empty."];
    case "TOO_LARGE":
      return [413, ChatErrorCode.ATTACHMENT_TOO_LARGE, "The file is too large."];
    case "EXTENSION_NOT_ALLOWED":
      return [
        422,
        ChatErrorCode.ATTACHMENT_TYPE_NOT_ALLOWED,
        "This kind of file cannot be attached.",
      ];
    case "CONTENT_MISMATCH":
      return [
        422,
        ChatErrorCode.ATTACHMENT_CONTENT_MISMATCH,
        "The file's contents do not match its extension.",
      ];
    case "NAME_INVALID":
      return [400, ChatErrorCode.ATTACHMENT_NAME_INVALID, "The filename is not usable."];
  }
}

export const chatRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /**
   * Everything the caller can see: their conversations and channels, plus
   * public channels they have not joined.
   *
   * Unread counts come from the read position rather than a per-message read
   * table — a boolean per message per member is millions of rows for one
   * office and answers a question nobody asks.
   */
  app.get(
    "/channels",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["chat"],
        summary: "Channels and conversations visible to me",
        response: { 200: ListChannelsResponse, ...errorResponses },
      },
    },
    async (request) => {
      const user = request.user!;

      const { rows } = await app.db.query<{
        id: string;
        kind: ChannelSummary["kind"];
        name: string | null;
        description: string | null;
        created_at: string;
        is_member: boolean;
        member_count: string;
        counterpart_name: string | null;
        unread_count: string;
        has_mention: boolean;
        last_message_at: string | null;
        last_message_preview: string | null;
        org_unit_id: string | null;
        posting_policy: "everyone" | "admins_only";
        can_post: boolean;
        can_moderate: boolean;
      }>(
        `WITH me AS (
           SELECT channel_id, last_read_message_id, muted_by_admin
             FROM channel_members
            WHERE user_id = $1 AND left_at IS NULL
         )
         SELECT c.id, c.kind,
                CASE WHEN c.org_unit_id IS NULL THEN c.name ELSE o.name END AS name,
                CASE WHEN c.org_unit_id IS NULL THEN c.description ELSE o.description END
                  AS description,
                c.created_at, c.org_unit_id, c.posting_policy,
                (me.channel_id IS NOT NULL) AS is_member,
                (SELECT count(*) FROM channel_members m
                  WHERE m.channel_id = c.id AND m.left_at IS NULL) AS member_count,
                (SELECT u.display_name
                   FROM direct_conversations d
                   JOIN users u ON u.id = CASE WHEN d.user_a_id = $1
                                               THEN d.user_b_id ELSE d.user_a_id END
                  WHERE d.channel_id = c.id) AS counterpart_name,
                (SELECT count(*) FROM messages msg
                  WHERE msg.channel_id = c.id
                    AND msg.author_id <> $1
                    AND (me.last_read_message_id IS NULL
                         OR msg.id > me.last_read_message_id)) AS unread_count,
                EXISTS (
                  SELECT 1 FROM messages msg
                    JOIN message_mentions mm ON mm.message_id = msg.id
                   WHERE msg.channel_id = c.id
                     AND mm.user_id = $1
                     AND (me.last_read_message_id IS NULL
                          OR msg.id > me.last_read_message_id)
                ) AS has_mention,
                (SELECT msg.created_at FROM messages msg
                  WHERE msg.channel_id = c.id ORDER BY msg.id DESC LIMIT 1)
                  AS last_message_at,
                (SELECT left(msg.body, 80) FROM messages msg
                  WHERE msg.channel_id = c.id ORDER BY msg.id DESC LIMIT 1)
                  AS last_message_preview,
                (c.archived_at IS NULL
                 AND (me.channel_id IS NOT NULL OR (c.org_unit_id IS NOT NULL AND $2))
                 AND ($2 OR (c.posting_policy = 'everyone'
                             AND COALESCE(me.muted_by_admin, false) = false))) AS can_post,
                ($2 AND c.kind <> 'direct'
                 AND (me.channel_id IS NOT NULL OR c.org_unit_id IS NOT NULL)) AS can_moderate
           FROM channels c
           LEFT JOIN org_units o ON o.id = c.org_unit_id
           LEFT JOIN me ON me.channel_id = c.id
          WHERE c.archived_at IS NULL
            -- Public channels are listed even when not joined; that is what
            -- makes them discoverable. Everything else requires membership.
            AND (c.kind = 'public' OR me.channel_id IS NOT NULL
                 OR (c.org_unit_id IS NOT NULL AND $2))
          ORDER BY last_message_at DESC NULLS LAST, c.created_at DESC`,
        [user.id, user.role === "owner" || user.role === "admin"],
      );

      return {
        items: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          name: row.name,
          description: row.description,
          memberCount: Number(row.member_count),
          counterpartName: row.counterpart_name,
          unreadCount: row.is_member ? Number(row.unread_count) : 0,
          hasMention: row.has_mention,
          lastMessageAt: row.last_message_at,
          lastMessagePreview: row.last_message_preview,
          isMember: row.is_member,
          orgUnitId: row.org_unit_id,
          postingPolicy: row.posting_policy,
          canPost: row.can_post,
          canModerate: row.can_moderate,
          createdAt: row.created_at,
        })),
      };
    },
  );

  app.post(
    "/channels",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["chat"],
        summary: "Create a channel",
        description:
          "Any member may create a channel. Restricting this to administrators " +
          "is how internal tools end up with a support ticket for every new " +
          "project group.",
        body: CreateChannelRequest,
        response: { 201: Type.Object({ id: Uuid }), ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const { name, kind, description, memberIds } = request.body;

      const id = await withTransaction(app.db, async (client) => {
        const { rows } = await client
          .query<{ id: string }>(
            `INSERT INTO channels (kind, name, description, created_by)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [kind, name, description ?? null, user.id],
          )
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : "";
            if (message.includes("uq_channel_name")) {
              throw new ApiError(
                409,
                ChatErrorCode.CHANNEL_NAME_TAKEN,
                "A channel with that name already exists.",
              );
            }
            throw error;
          });

        const channelId = rows[0]!.id;

        // The creator is always a member — a channel you cannot post in is not
        // a channel you meant to create.
        const members = new Set([user.id, ...(memberIds ?? [])]);

        await client.query(
          `INSERT INTO channel_members (channel_id, user_id)
           SELECT $1, u.id FROM users u
            WHERE u.id = ANY($2::uuid[]) AND u.disabled_at IS NULL`,
          [channelId, [...members]],
        );

        return channelId;
      });

      return reply.status(201).send({ id });
    },
  );

  app.post(
    "/channels/direct",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["chat"],
        summary: "Open a one-to-one conversation",
        description:
          "Idempotent: calling it twice returns the same conversation. Two " +
          "people must never end up with two, each holding half the history.",
        body: OpenDirectRequest,
        response: { 200: Type.Object({ id: Uuid }), ...errorResponses },
      },
    },
    async (request) => {
      const user = request.user!;

      const id = await withTransaction(app.db, (client) =>
        openDirectConversation(client, user.id, request.body.userId),
      );

      return { id };
    },
  );

  app.post(
    "/channels/:channelId/join",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["chat"],
        summary: "Join a public channel",
        params: Type.Object({ channelId: Uuid }),
        response: { 204: Type.Null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const { channelId } = request.params;

      await withTransaction(app.db, async (client) => {
        const access = await loadChannelAccess(client, channelId, user.id);

        if (access.kind !== "public") {
          throw new ApiError(
            403,
            ChatErrorCode.CHANNEL_FORBIDDEN,
            "This channel cannot be joined directly.",
          );
        }
        if (access.archived) {
          throw new ApiError(
            422,
            ChatErrorCode.CHANNEL_ARCHIVED,
            "This channel has been archived.",
          );
        }
        if (access.isMember) return;

        await client.query(
          `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
          [channelId, user.id],
        );
      });

      return reply.status(204).send(null);
    },
  );

  app.get(
    "/channels/:channelId/members",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["chat"],
        summary: "Who is in this channel",
        params: Type.Object({ channelId: Uuid }),
        response: { 200: ListChannelMembersResponse, ...errorResponses },
      },
    },
    async (request) => {
      const user = request.user!;
      const { channelId } = request.params;

      return withTransaction(app.db, async (client) => {
        assertCanRead(await loadChannelAccess(client, channelId, user.id));

        const { rows } = await client.query<{
          user_id: string;
          display_name: string;
          role: "owner" | "admin" | "member";
          joined_at: string;
          muted_by_admin: boolean;
        }>(
          `SELECT m.user_id, u.display_name, u.role, m.joined_at, m.muted_by_admin
             FROM channel_members m
             JOIN users u ON u.id = m.user_id
            WHERE m.channel_id = $1 AND m.left_at IS NULL
            ORDER BY u.display_name`,
          [channelId],
        );

        return {
          items: rows.map((r) => ({
            userId: r.user_id,
            displayName: r.display_name,
            role: r.role,
            joinedAt: r.joined_at,
            muted: r.muted_by_admin,
          })),
        };
      });
    },
  );

  app.patch(
    "/channels/:channelId/moderation",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["chat"],
        summary: "Choose who may post in a group channel",
        params: Type.Object({ channelId: Uuid }),
        body: UpdateChannelModerationRequest,
        response: {
          200: Type.Object({
            postingPolicy: UpdateChannelModerationRequest.properties.postingPolicy,
          }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const actor = request.user!;
      const { channelId } = request.params;
      const { postingPolicy } = request.body;

      await withTransaction(app.db, async (client) => {
        const { rows } = await client.query<{ kind: ChannelSummary["kind"] }>(
          "SELECT kind FROM channels WHERE id = $1",
          [channelId],
        );
        const channel = rows[0];
        if (!channel) throw ApiError.notFound("Channel not found.");
        if (channel.kind === "direct") {
          throw new ApiError(
            422,
            ChatErrorCode.CHANNEL_NOT_MODERATABLE,
            "A direct conversation cannot be moderated as a group.",
          );
        }

        await client.query("UPDATE channels SET posting_policy = $2 WHERE id = $1", [
          channelId,
          postingPolicy,
        ]);
        await writeAudit(client, request, {
          action: AuditAction.CHANNEL_MODERATION_CHANGED,
          actorUserId: actor.id,
          resourceType: "channel",
          resourceId: channelId,
          metadata: { postingPolicy },
        });
      });

      return { postingPolicy };
    },
  );

  app.patch(
    "/channels/:channelId/members/:userId/mute",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["chat"],
        summary: "Mute or unmute one member in a group channel",
        params: Type.Object({ channelId: Uuid, userId: Uuid }),
        body: UpdateChannelMemberMuteRequest,
        response: {
          200: Type.Object({ userId: Uuid, muted: Type.Boolean() }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const actor = request.user!;
      const { channelId, userId } = request.params;
      const { muted } = request.body;

      await withTransaction(app.db, async (client) => {
        const { rows } = await client.query<{ kind: ChannelSummary["kind"] }>(
          "SELECT kind FROM channels WHERE id = $1",
          [channelId],
        );
        const channel = rows[0];
        if (!channel) throw ApiError.notFound("Channel not found.");
        if (channel.kind === "direct") {
          throw new ApiError(
            422,
            ChatErrorCode.CHANNEL_NOT_MODERATABLE,
            "A direct conversation cannot be moderated as a group.",
          );
        }

        const { rowCount } = await client.query(
          `UPDATE channel_members SET muted_by_admin = $3
            WHERE channel_id = $1 AND user_id = $2 AND left_at IS NULL`,
          [channelId, userId, muted],
        );
        if ((rowCount ?? 0) === 0) throw ApiError.notFound("Channel member not found.");

        await writeAudit(client, request, {
          action: AuditAction.CHANNEL_MEMBER_MUTE_CHANGED,
          actorUserId: actor.id,
          resourceType: "channel",
          resourceId: channelId,
          metadata: { userId, muted },
        });
      });

      return { userId, muted };
    },
  );

  /**
   * Paginated backwards from newest, because that is what a chat opens to.
   * Ids are uuidv7 and therefore time-ordered, so `before` needs no separate
   * cursor encoding.
   */
  app.get(
    "/channels/:channelId/messages",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["chat"],
        summary: "Messages in a channel",
        params: Type.Object({ channelId: Uuid }),
        querystring: ListMessagesQuery,
        response: { 200: ListMessagesResponse, ...errorResponses },
      },
    },
    async (request) => {
      const user = request.user!;
      const { channelId } = request.params;
      const { before, limit } = request.query;
      const pageSize = limit ?? 50;

      return withTransaction(app.db, async (client) => {
        assertCanRead(await loadChannelAccess(client, channelId, user.id));

        const { rows } = await client.query<MessageRow>(
          `${SELECT_MESSAGE}
            WHERE m.channel_id = $1
              AND ($2::uuid IS NULL OR m.id < $2)
            ORDER BY m.id DESC
            LIMIT $3`,
          [channelId, before ?? null, pageSize + 1],
        );

        const hasMore = rows.length > pageSize;
        const page = hasMore ? rows.slice(0, pageSize) : rows;

        return {
          // Reversed: the query walks backwards, the UI renders forwards.
          items: page.reverse().map(toMessage),
          nextBefore: hasMore ? (page[0]?.id ?? null) : null,
        };
      });
    },
  );

  app.post(
    "/channels/:channelId/messages",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["chat"],
        summary: "Send a message",
        params: Type.Object({ channelId: Uuid }),
        body: SendMessageRequest,
        response: { 201: Message, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const { channelId } = request.params;
      const { body, replyToId, attachmentIds } = request.body;

      const message = await withTransaction(app.db, async (client) => {
        assertCanPost(await loadChannelAccess(client, channelId, user.id));

        if (replyToId) {
          const { rows } = await client.query<{ channel_id: string }>(
            "SELECT channel_id FROM messages WHERE id = $1",
            [replyToId],
          );
          if (!rows[0]) throw ApiError.notFound("Message being replied to not found.");

          // Replying across channels would quote a private conversation into a
          // public one.
          if (rows[0].channel_id !== channelId) {
            throw new ApiError(
              422,
              ChatErrorCode.REPLY_ACROSS_CHANNELS,
              "You can only reply to a message in the same channel.",
            );
          }
        }

        const { rows: inserted } = await client.query<{ id: string }>(
          `INSERT INTO messages (channel_id, author_id, body, reply_to_id)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [channelId, user.id, body, replyToId ?? null],
        );
        const messageId = inserted[0]!.id;

        // Inside the same transaction as the insert: a message whose files
        // could not be attached must not exist at all.
        await claimAttachments(
          client,
          messageId,
          channelId,
          user.id,
          attachmentIds ?? [],
        );

        const mentioned = await resolveMentions(client, channelId, body);
        if (mentioned.length > 0) {
          await client.query(
            `INSERT INTO message_mentions (message_id, user_id)
             SELECT $1, unnest($2::uuid[])`,
            [messageId, mentioned],
          );
        }

        // The author's own read position advances: their own message is not
        // unread to them.
        await client.query(
          `UPDATE channel_members
              SET last_read_message_id = $3, last_read_at = now()
            WHERE channel_id = $1 AND user_id = $2 AND left_at IS NULL`,
          [channelId, user.id, messageId],
        );

        const { rows } = await client.query<MessageRow>(
          `${SELECT_MESSAGE} WHERE m.id = $1`,
          [messageId],
        );
        return toMessage(rows[0]!);
      });

      // After commit, so a subscriber cannot be told about a message a
      // rollback would have removed. Best-effort: a failed push is a missed
      // animation, not a lost message.
      await app.realtime
        .publishToChannel(channelId, { type: "message.created", channelId, message })
        .catch((error: unknown) => {
          request.log.warn({ err: error }, "realtime publish failed");
        });

      return reply.status(201).send(message);
    },
  );

  /**
   * Uploading a file, before the message that will carry it exists.
   *
   * The body is the file itself rather than a multipart form. Two reasons: the
   * filename travels in `Content-Disposition` instead of the URL, so it never
   * reaches a proxy access log — "解雇通知_田中.pdf" is not a thing to write
   * into one — and there is no multipart parser to depend on or to get wrong.
   *
   * Nothing the client says about the type is believed. The extension must be
   * on the allow-list and the bytes must match it.
   */
  app.post(
    "/channels/:channelId/attachments",
    {
      preHandler: requireAuth,
      // The global ceiling is 1 MiB. A body over this is refused by Fastify
      // before it is read into memory, which is what stops a 2 GB upload from
      // being buffered before anybody checks its size.
      bodyLimit: MAX_ATTACHMENT_BYTES + 1024,
      schema: {
        tags: ["chat"],
        summary: "Upload a file to attach to a message",
        description:
          "The body is the raw file. The name travels in Content-Disposition " +
          "(RFC 5987), which is also the only form that carries a Japanese " +
          "filename intact. The upload is attached by passing its id as " +
          "`attachmentIds` when sending a message; one that is never sent is " +
          "removed by a periodic sweep.",
        consumes: ["application/octet-stream"],
        params: Type.Object({ channelId: Uuid }),
        response: { 201: UploadAttachmentResponse, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const { channelId } = request.params;

      const fileName = parseFileName(request.headers["content-disposition"]);
      if (fileName === null) {
        throw new ApiError(
          400,
          ChatErrorCode.ATTACHMENT_NAME_INVALID,
          "A Content-Disposition header with a filename is required.",
        );
      }

      const bytes = request.body as Uint8Array;
      const result = validateUpload(fileName, bytes);

      if (!result.ok) {
        const [status, code, message] = rejectionToError(result.reason);
        throw new ApiError(status, code, message, {
          ...(result.allowed ? { allowedExtensions: result.allowed } : {}),
        });
      }

      // Membership, not just readability: uploading into a channel you cannot
      // post in stores a file that can never be sent.
      const id = await withTransaction(app.db, async (client) => {
        assertCanPost(await loadChannelAccess(client, channelId, user.id));

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO message_attachments
             (channel_id, uploaded_by, original_name, storage_key,
              content_type, byte_size)
           VALUES ($1, $2, $3, '', $4, $5)
           RETURNING id`,
          [channelId, user.id, fileName, result.contentType, bytes.length],
        );
        const attachmentId = rows[0]!.id;

        // The key is generated from the row's own id, so it is decided by the
        // database rather than by anything in the request.
        const storageKey = storageKeyFor(attachmentId);

        // Written before the transaction commits: a committed row pointing at
        // a file that was never written is a broken download forever, while a
        // written file with no row is swept away as an orphan.
        await app.attachments.write(storageKey, bytes);

        await client.query(
          "UPDATE message_attachments SET storage_key = $2 WHERE id = $1",
          [attachmentId, storageKey],
        );

        return attachmentId;
      });

      return reply.status(201).send({
        id,
        name: fileName,
        contentType: result.contentType,
        byteSize: bytes.length,
        url: `/api/v1/attachments/${id}`,
        inline: result.inline,
      });
    },
  );

  /**
   * Downloading one.
   *
   * Permission is re-checked here against the channel the file was uploaded
   * to, every time. A link is not a capability: somebody removed from a private
   * channel must stop being able to fetch its files, including the ones they
   * were sent while they were still a member.
   */
  app.get(
    "/attachments/:attachmentId",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["chat"],
        summary: "Download an attachment",
        params: Type.Object({ attachmentId: Uuid }),
        // No response schema: the body is the file. Declaring one would make
        // Fastify's serializer try to turn a stream into JSON.
        produces: ["application/octet-stream"],
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const { attachmentId } = request.params;

      const attachment = await withTransaction(app.db, async (client) => {
        const { rows } = await client.query<{
          original_name: string;
          storage_key: string;
          content_type: string;
          // int8 arrives as a BigInt — db.ts installs that parser so large
          // counts cannot silently lose precision.
          byte_size: bigint;
          channel_id: string;
          message_id: string | null;
          uploaded_by: string;
        }>(
          `SELECT original_name, storage_key, content_type, byte_size,
                  channel_id, message_id, uploaded_by
             FROM message_attachments WHERE id = $1`,
          [attachmentId],
        );

        const row = rows[0];
        if (!row) throw ApiError.notFound("Attachment not found.");

        assertCanRead(await loadChannelAccess(client, row.channel_id, user.id));

        // An upload nobody has sent yet is visible only to whoever uploaded it.
        // Guessing an id must not reveal a file still being written into a
        // message.
        if (row.message_id === null && row.uploaded_by !== user.id) {
          throw ApiError.notFound("Attachment not found.");
        }

        return row;
      });

      const inline = isInlineType(attachment.content_type);

      return (
        reply
          .header("content-type", attachment.content_type)
          // A BigInt reaches Node's header writer as an object it refuses to
          // convert, and the response fails after the status line is already
          // committed — a 500 with no usable message.
          .header("content-length", String(attachment.byte_size))
          // The stored type is served as-is and sniffing is refused, so a file
          // whose bytes happen to look like HTML cannot be rendered as a page
          // from this origin.
          .header("x-content-type-options", "nosniff")
          .header(
            "content-disposition",
            `${inline ? "inline" : "attachment"}; ${encodeFileName(attachment.original_name)}`,
          )
          .header("cache-control", "private, max-age=300")
          .send(app.attachments.read(attachment.storage_key))
      );
    },
  );

  app.post(
    "/channels/:channelId/read",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["chat"],
        summary: "Move my read position",
        description:
          "Stores a position rather than marking messages individually, and " +
          "never moves backwards — a phone catching up must not undo what was " +
          "already read on a desktop.",
        params: Type.Object({ channelId: Uuid }),
        body: MarkReadRequest,
        response: { 204: Type.Null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const { channelId } = request.params;
      const { messageId } = request.body;

      await withTransaction(app.db, async (client) => {
        assertCanRead(await loadChannelAccess(client, channelId, user.id));

        const { rowCount } = await client.query(
          `UPDATE channel_members
              SET last_read_message_id = $3, last_read_at = now()
            WHERE channel_id = $1
              AND user_id = $2
              AND left_at IS NULL
              AND (last_read_message_id IS NULL OR last_read_message_id < $3)`,
          [channelId, user.id, messageId],
        );

        // Zero rows means it was already at or past this point, which is fine.
        void rowCount;
      });

      return reply.status(204).send(null);
    },
  );
};
