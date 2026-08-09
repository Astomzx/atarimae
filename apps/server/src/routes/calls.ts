import {
  CallErrorCode,
  CallProvider,
  CreateCallProviderRequest,
  errorResponses,
  JoinCallResponse,
  ListCallProvidersResponse,
  ListCallsResponse,
  Uuid,
} from "@atarimae/api-schema";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import { withTransaction, type DatabaseClient } from "../db.js";
import { ApiError } from "../errors.js";
import { AuditAction, writeAudit } from "../lib/audit.js";
import { checkProviderUrl } from "../lib/outbound-url.js";
import { requireAuth, requirePersonRole } from "../plugins/auth.js";
import {
  CallProviderError,
  generateRoomName,
  resolveJoinUrl,
  type CallProviderConfig,
} from "../services/call-providers.js";
import { assertCanPost, assertCanRead, loadChannelAccess } from "../services/chat.js";

/**
 * 通話 — calls over the network, inside a conversation.
 *
 * Everything about who and when lives here. The audio does not: it is held by
 * a provider an administrator configured, which is what lets an office point
 * this at its own Jitsi instead of at somebody's cloud.
 */

interface CallRow {
  id: string;
  channel_id: string;
  started_by: string;
  started_by_name: string;
  started_at: string;
  ended_at: string | null;
  participants:
    | { userId: string; displayName: string; joinedAt: string; leftAt: string | null }[]
    | null;
}

const SELECT_CALL = `
  SELECT c.id, c.channel_id, c.started_by, u.display_name AS started_by_name,
         c.started_at, c.ended_at,
         COALESCE(
           (SELECT json_agg(json_build_object(
                     'userId', p.user_id,
                     'displayName', pu.display_name,
                     'joinedAt', p.joined_at,
                     'leftAt', p.left_at) ORDER BY p.joined_at)
              FROM call_participants p
              JOIN users pu ON pu.id = p.user_id
             WHERE p.call_id = c.id), '[]'::json
         ) AS participants
    FROM calls c
    JOIN users u ON u.id = c.started_by
`;

function toCall(row: CallRow) {
  return {
    id: row.id,
    channelId: row.channel_id,
    startedBy: row.started_by,
    startedByName: row.started_by_name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    participants: row.participants ?? [],
  };
}

interface ProviderRow {
  id: string;
  name: string;
  kind: "url" | "http";
  url_template: string | null;
  request_url: string | null;
  request_headers: Record<string, string>;
  request_body_template: string | null;
  response_url_path: string | null;
  secret_encrypted: string | null;
  is_default: boolean;
  disabled_at: string | null;
  created_at: string;
}

function toProvider(row: ProviderRow) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    urlTemplate: row.url_template,
    requestUrl: row.request_url,
    responseUrlPath: row.response_url_path,
    // Whether one is configured, never the value. There is no endpoint that
    // returns it: it exists to be sent to the provider, not to be read back.
    hasSecret: row.secret_encrypted !== null,
    isDefault: row.is_default,
    disabledAt: row.disabled_at,
    createdAt: row.created_at,
  };
}

function toConfig(row: ProviderRow): CallProviderConfig {
  return {
    id: row.id,
    kind: row.kind,
    urlTemplate: row.url_template,
    requestUrl: row.request_url,
    requestHeaders: row.request_headers,
    requestBodyTemplate: row.request_body_template,
    responseUrlPath: row.response_url_path,
    secretEncrypted: row.secret_encrypted,
  };
}

const SELECT_PROVIDER = `
  SELECT id, name, kind, url_template, request_url, request_headers,
         request_body_template, response_url_path, secret_encrypted,
         is_default, disabled_at, created_at
    FROM call_providers
`;

export const callRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // -------------------------------------------------------------- providers --

  app.get(
    "/call-providers",
    {
      preHandler: requirePersonRole("admin"),
      schema: {
        tags: ["calls"],
        summary: "Configured call providers",
        response: { 200: ListCallProvidersResponse, ...errorResponses },
      },
    },
    async () => {
      const { rows } = await app.db.query<ProviderRow>(
        `${SELECT_PROVIDER} ORDER BY is_default DESC, created_at DESC`,
      );
      return { items: rows.map(toProvider) };
    },
  );

  app.post(
    "/call-providers",
    {
      preHandler: requirePersonRole("admin"),
      schema: {
        tags: ["calls"],
        summary: "Configure a call provider",
        description:
          "`url` substitutes {room} into a template — enough for a self-hosted " +
          "Jitsi, and it needs no credential. `http` asks an API for a room and " +
          "reads the join URL out of the answer at `responseUrlPath`. The " +
          "secret is stored encrypted and is never returned.",
        body: CreateCallProviderRequest,
        response: { 201: CallProvider, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = request.user!;
      const input = request.body;

      if (input.kind === "url") {
        if (!input.urlTemplate) {
          throw ApiError.unprocessable(
            CallErrorCode.CALL_PROVIDER_INCOMPLETE,
            "A URL provider needs a urlTemplate.",
          );
        }
        /**
         * Without {room} every call in the organisation lands in the same
         * room. Two unrelated conversations would hear each other, and it
         * would look like the product working.
         */
        if (!input.urlTemplate.includes("{room}")) {
          throw ApiError.unprocessable(
            CallErrorCode.CALL_PROVIDER_TEMPLATE_INVALID,
            "The URL template must contain {room}.",
          );
        }
        assertUsableProviderUrl(input.urlTemplate.replace("{room}", "room"));
      } else {
        if (!input.requestUrl || !input.responseUrlPath) {
          throw ApiError.unprocessable(
            CallErrorCode.CALL_PROVIDER_INCOMPLETE,
            "An HTTP provider needs a requestUrl and a responseUrlPath.",
          );
        }
        assertUsableProviderUrl(input.requestUrl);
      }

      const encrypted = input.secret ? await app.secrets.encrypt(input.secret) : null;

      const provider = await withTransaction(app.db, async (client) => {
        // Exactly one default: the unique index refuses two, so the previous
        // one is stood down first rather than the insert failing.
        if (input.isDefault) {
          await client.query(
            "UPDATE call_providers SET is_default = false WHERE is_default",
          );
        }

        const { rows } = await client.query<ProviderRow>(
          `INSERT INTO call_providers
             (name, kind, url_template, request_url, request_headers,
              request_body_template, response_url_path, secret_encrypted,
              is_default, created_by)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
           RETURNING id, name, kind, url_template, request_url, request_headers,
                     request_body_template, response_url_path, secret_encrypted,
                     is_default, disabled_at, created_at`,
          [
            input.name,
            input.kind,
            input.kind === "url" ? input.urlTemplate : null,
            input.kind === "http" ? input.requestUrl : null,
            JSON.stringify(input.requestHeaders ?? {}),
            input.kind === "http" ? (input.requestBodyTemplate ?? null) : null,
            input.kind === "http" ? input.responseUrlPath : null,
            encrypted,
            input.isDefault ?? false,
            actor.id,
          ],
        );

        // The name and kind. Never the secret, and never a rendered URL that
        // might carry one.
        await writeAudit(client, request, {
          action: AuditAction.CALL_PROVIDER_CONFIGURED,
          actorUserId: actor.id,
          resourceType: "call_provider",
          resourceId: rows[0]!.id,
          metadata: { name: input.name, kind: input.kind },
        });

        return toProvider(rows[0]!);
      });

      return reply.status(201).send(provider);
    },
  );

  app.post(
    "/call-providers/:providerId/disable",
    {
      preHandler: requirePersonRole("admin"),
      schema: {
        tags: ["calls"],
        summary: "Disable a call provider",
        params: Type.Object({ providerId: Uuid }),
        response: { 200: CallProvider, ...errorResponses },
      },
    },
    async (request) => {
      const { providerId } = request.params;

      const { rows } = await app.db.query<ProviderRow>(
        `UPDATE call_providers
            SET disabled_at = now(), is_default = false
          WHERE id = $1
          RETURNING id, name, kind, url_template, request_url, request_headers,
                    request_body_template, response_url_path, secret_encrypted,
                    is_default, disabled_at, created_at`,
        [providerId],
      );

      const row = rows[0];
      if (!row) throw ApiError.notFound("Call provider not found.");

      return toProvider(row);
    },
  );

  // ------------------------------------------------------------------ calls --

  /**
   * Starting a call, or joining the one already running.
   *
   * Pressing 通話 twice must not open a second room with half the people in
   * each, so an existing live call is returned instead of a new one. The
   * unique index makes that true even when two people press it at the same
   * moment.
   */
  app.post(
    "/channels/:channelId/calls",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["calls"],
        summary: "Start a call in a channel",
        description:
          "Returns the call already in progress if there is one, so pressing " +
          "this twice joins rather than splitting the room.",
        params: Type.Object({ channelId: Uuid }),
        response: { 201: JoinCallResponse, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const { channelId } = request.params;

      const existing = await withTransaction(app.db, async (client) => {
        assertCanPost(await loadChannelAccess(client, channelId, user.id));

        const { rows } = await client.query<CallRow & { join_url: string }>(
          `${SELECT_CALL} WHERE c.channel_id = $1 AND c.ended_at IS NULL`,
          [channelId],
        );
        return rows[0] ?? null;
      });

      if (existing) {
        const joined = await joinCall(app, request, existing.id, user.id);
        return reply.status(201).send(joined);
      }

      const provider = await loadDefaultProvider(app.db);
      const roomName = generateRoomName();

      /**
       * The provider is asked *before* the transaction opens.
       *
       * An HTTP provider is a network call, and holding a database
       * transaction open across one means a slow vendor holds a row lock on
       * the channel for as long as it takes to time out.
       */
      let joinUrl: string;
      try {
        joinUrl = await resolveJoinUrl(toConfig(provider), roomName, app.secrets);
      } catch (error) {
        if (error instanceof CallProviderError) {
          throw ApiError.unprocessable(CallErrorCode.CALL_PROVIDER_FAILED, error.message);
        }
        throw error;
      }

      const created = await withTransaction(app.db, async (client) => {
        assertCanPost(await loadChannelAccess(client, channelId, user.id));

        const { rows } = await client
          .query<{ id: string }>(
            `INSERT INTO calls (channel_id, provider_id, room_name, join_url, started_by)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [channelId, provider.id, roomName, joinUrl, user.id],
          )
          .catch((error: unknown) => {
            // Somebody else started one between the check and the insert. The
            // index is what makes that impossible rather than unlikely.
            const message = error instanceof Error ? error.message : "";
            if (message.includes("uq_call_live_per_channel")) {
              throw ApiError.conflict("A call is already in progress here.");
            }
            throw error;
          });

        const callId = rows[0]!.id;

        await client.query(
          "INSERT INTO call_participants (call_id, user_id) VALUES ($1, $2)",
          [callId, user.id],
        );

        const { rows: calls } = await client.query<CallRow>(
          `${SELECT_CALL} WHERE c.id = $1`,
          [callId],
        );
        return { call: toCall(calls[0]!), joinUrl };
      });

      // After commit: ringing somebody for a call a rollback removed would be
      // worse than a missed ring.
      await app.realtime
        .publishToChannel(channelId, {
          type: "call.started",
          channelId,
          callId: created.call.id,
          startedBy: user.id,
          startedByName: created.call.startedByName,
        })
        .catch((error: unknown) => {
          request.log.warn({ err: error }, "realtime publish failed");
        });

      return reply.status(201).send(created);
    },
  );

  /**
   * Joining. The URL is handed out here and only here.
   *
   * Membership is checked again on every join, so somebody removed from a
   * private channel cannot walk back into its call with a link they still
   * have — the same rule as attachments.
   */
  app.post(
    "/calls/:callId/join",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["calls"],
        summary: "Join a call",
        params: Type.Object({ callId: Uuid }),
        response: { 200: JoinCallResponse, ...errorResponses },
      },
    },
    async (request) => {
      const user = request.user!;
      return joinCall(app, request, request.params.callId, user.id);
    },
  );

  app.post(
    "/calls/:callId/leave",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["calls"],
        summary: "Leave a call",
        description:
          "The last person out ends it, so a call does not stay 'in progress' " +
          "in the channel list after everybody has gone.",
        params: Type.Object({ callId: Uuid }),
        response: { 204: Type.Null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const { callId } = request.params;

      const ended = await withTransaction(app.db, async (client) => {
        const call = await loadCallForUser(client, callId, user.id);

        await client.query(
          `UPDATE call_participants SET left_at = now()
            WHERE call_id = $1 AND user_id = $2 AND left_at IS NULL`,
          [callId, user.id],
        );

        const { rows } = await client.query<{ remaining: string }>(
          `SELECT count(*) AS remaining FROM call_participants
            WHERE call_id = $1 AND left_at IS NULL`,
          [callId],
        );

        if (Number(rows[0]!.remaining) > 0) return null;

        await client.query(
          `UPDATE calls SET ended_at = now(), ended_reason = 'everybody left'
            WHERE id = $1 AND ended_at IS NULL`,
          [callId],
        );

        return call.channel_id;
      });

      if (ended) {
        await app.realtime
          .publishToChannel(ended, { type: "call.ended", channelId: ended, callId })
          .catch((error: unknown) => {
            request.log.warn({ err: error }, "realtime publish failed");
          });
      }

      return reply.status(204).send(null);
    },
  );

  app.get(
    "/channels/:channelId/calls",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["calls"],
        summary: "Calls in this channel",
        description:
          "Newest first, live one included. Who joined is part of each row — " +
          "the difference between a call that happened and one that rang out.",
        params: Type.Object({ channelId: Uuid }),
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
        }),
        response: { 200: ListCallsResponse, ...errorResponses },
      },
    },
    async (request) => {
      const user = request.user!;
      const { channelId } = request.params;

      return withTransaction(app.db, async (client) => {
        assertCanRead(await loadChannelAccess(client, channelId, user.id));

        const { rows } = await client.query<CallRow>(
          `${SELECT_CALL} WHERE c.channel_id = $1
            ORDER BY c.started_at DESC LIMIT $2`,
          [channelId, request.query.limit ?? 20],
        );

        return { items: rows.map(toCall) };
      });
    },
  );
};

/** Shared by starting and joining, so both re-check membership the same way. */
async function joinCall(
  app: Parameters<FastifyPluginAsyncTypebox>[0],
  request: Parameters<typeof writeAudit>[1],
  callId: string,
  userId: string,
) {
  return withTransaction(app.db, async (client) => {
    const call = await loadCallForUser(client, callId, userId);

    if (call.ended_at !== null) {
      throw ApiError.unprocessable(
        CallErrorCode.CALL_ALREADY_ENDED,
        "This call has already ended.",
      );
    }

    // Rejoining after a dropped connection is the same person, not a second
    // participant.
    await client.query(
      `INSERT INTO call_participants (call_id, user_id) VALUES ($1, $2)
       ON CONFLICT (call_id, user_id) DO UPDATE SET left_at = NULL`,
      [callId, userId],
    );

    const { rows } = await client.query<CallRow>(`${SELECT_CALL} WHERE c.id = $1`, [
      callId,
    ]);

    void request;
    return { call: toCall(rows[0]!), joinUrl: call.join_url };
  });
}

interface CallAccessRow {
  id: string;
  channel_id: string;
  join_url: string;
  ended_at: string | null;
}

/**
 * Loads a call only if this person may be in the channel it belongs to.
 *
 * `assertCanPost` rather than `assertCanRead`: a public channel is readable by
 * anybody signed in, but walking into its call uninvited is not reading.
 */
async function loadCallForUser(
  client: DatabaseClient,
  callId: string,
  userId: string,
): Promise<CallAccessRow> {
  const { rows } = await client.query<CallAccessRow>(
    "SELECT id, channel_id, join_url, ended_at FROM calls WHERE id = $1",
    [callId],
  );

  const call = rows[0];
  if (!call) throw ApiError.notFound("Call not found.");

  assertCanPost(await loadChannelAccess(client, call.channel_id, userId));

  return call;
}

async function loadDefaultProvider(
  db: Parameters<typeof withTransaction>[0],
): Promise<ProviderRow> {
  const { rows } = await db.query<ProviderRow>(
    `${SELECT_PROVIDER}
      WHERE disabled_at IS NULL
      ORDER BY is_default DESC, created_at
      LIMIT 1`,
  );

  const provider = rows[0];
  if (!provider) {
    // Not a 500 and not an empty success: there is nowhere to hold a call, and
    // the administrator is the one who can fix it.
    throw ApiError.unprocessable(
      CallErrorCode.NO_CALL_PROVIDER,
      "No call provider is configured.",
    );
  }

  return provider;
}

function assertUsableProviderUrl(candidate: string): void {
  const checked = checkProviderUrl(candidate);
  if (!checked.ok) {
    throw ApiError.unprocessable(
      CallErrorCode.CALL_PROVIDER_TEMPLATE_INVALID,
      "The address must be an http or https URL without credentials in it.",
    );
  }
}
