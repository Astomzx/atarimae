import {
  CreateApiTokenRequest,
  CreateApiTokenResponse,
  CreateServiceAccountRequest,
  errorResponses,
  ListApiTokensResponse,
  ListServiceAccountsResponse,
  ServiceAccount,
  ServiceAccountErrorCode,
  Uuid,
} from "@atarimae/api-schema";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import { withTransaction } from "../db.js";
import { ApiError } from "../errors.js";
import { generateApiToken } from "../lib/api-token.js";
import { AuditAction, writeAudit } from "../lib/audit.js";
import { requirePersonRole } from "../plugins/auth.js";

/**
 * Service accounts and their tokens.
 *
 * Every route here refuses API-token authentication. A token that can issue
 * tokens or create service accounts turns one leak into a permanent foothold —
 * revoking the leaked row would leave behind whatever it created. These are
 * decisions a person makes, so they require a person's session.
 */

interface ServiceAccountRow {
  id: string;
  display_name: string;
  role: "member" | "admin";
  description: string | null;
  active_token_count: string;
  last_used_at: string | null;
  disabled_at: string | null;
  created_at: string;
}

/**
 * `users.email` is NOT NULL and uniquely indexed, and a service account has no
 * mailbox. It gets a generated address in a domain RFC 2606 reserves precisely
 * so that nothing will ever try to deliver to it.
 */
const SERVICE_EMAIL_DOMAIN = "service.invalid";

function toServiceAccount(row: ServiceAccountRow) {
  return {
    id: row.id,
    displayName: row.display_name,
    role: row.role,
    description: row.description,
    activeTokenCount: Number(row.active_token_count),
    lastUsedAt: row.last_used_at,
    disabledAt: row.disabled_at,
    createdAt: row.created_at,
  };
}

const SELECT_SERVICE_ACCOUNT = `
  SELECT u.id, u.display_name, u.role, u.service_description AS description,
         u.disabled_at, u.created_at,
         (SELECT count(*) FROM api_tokens t
           WHERE t.user_id = u.id
             AND t.revoked_at IS NULL
             AND (t.expires_at IS NULL OR t.expires_at > now())) AS active_token_count,
         (SELECT max(t.last_used_at) FROM api_tokens t WHERE t.user_id = u.id)
           AS last_used_at
    FROM users u
   WHERE u.kind = 'service'
`;

export const serviceAccountRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/service-accounts",
    {
      preHandler: requirePersonRole("admin"),
      schema: {
        tags: ["service-accounts"],
        summary: "Service accounts",
        response: { 200: ListServiceAccountsResponse, ...errorResponses },
      },
    },
    async () => {
      const { rows } = await app.db.query<ServiceAccountRow>(
        `${SELECT_SERVICE_ACCOUNT} ORDER BY u.created_at DESC`,
      );

      return { items: rows.map(toServiceAccount) };
    },
  );

  app.post(
    "/service-accounts",
    {
      preHandler: requirePersonRole("admin"),
      schema: {
        tags: ["service-accounts"],
        summary: "Create a service account",
        description:
          "An identity for an integration, so a token does not have to belong " +
          "to a person who might leave. It has no password and can never sign " +
          "in interactively.",
        body: CreateServiceAccountRequest,
        response: { 201: ServiceAccount, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = request.user!;
      const { displayName, role, description } = request.body;

      const account = await withTransaction(app.db, async (client) => {
        /**
         * A generated, unroutable address. `users.email` is NOT NULL and
         * uniquely indexed, and a service account has no mailbox — .invalid is
         * reserved by RFC 2606 precisely so that nothing will ever try to
         * deliver to it.
         */
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO users (email, display_name, role, kind, service_description)
           VALUES (
             concat('svc-', replace(gen_random_uuid()::text, '-', ''), '@', $4::text),
             $1, $2, 'service', $3
           )
           RETURNING id`,
          [displayName, role, description ?? null, SERVICE_EMAIL_DOMAIN],
        );
        const id = rows[0]!.id;

        await writeAudit(client, request, {
          action: AuditAction.SERVICE_ACCOUNT_CREATED,
          actorUserId: actor.id,
          resourceType: "user",
          resourceId: id,
          metadata: { displayName, role },
        });

        const { rows: created } = await client.query<ServiceAccountRow>(
          `${SELECT_SERVICE_ACCOUNT} AND u.id = $1`,
          [id],
        );
        return toServiceAccount(created[0]!);
      });

      return reply.status(201).send(account);
    },
  );

  /**
   * Disabling one stops every token it holds on the next request — the token
   * lookup joins users and filters disabled accounts, so there is no window
   * and no cache to wait out.
   */
  app.post(
    "/service-accounts/:serviceAccountId/disable",
    {
      preHandler: requirePersonRole("admin"),
      schema: {
        tags: ["service-accounts"],
        summary: "Disable a service account",
        params: Type.Object({ serviceAccountId: Uuid }),
        response: { 200: ServiceAccount, ...errorResponses },
      },
    },
    async (request) => {
      const actor = request.user!;
      const { serviceAccountId } = request.params;

      return withTransaction(app.db, async (client) => {
        const { rowCount } = await client.query(
          `UPDATE users SET disabled_at = now()
            WHERE id = $1 AND kind = 'service' AND disabled_at IS NULL`,
          [serviceAccountId],
        );

        if (rowCount === 0) await assertServiceAccountExists(client, serviceAccountId);

        await writeAudit(client, request, {
          action: AuditAction.SERVICE_ACCOUNT_DISABLED,
          actorUserId: actor.id,
          resourceType: "user",
          resourceId: serviceAccountId,
        });

        const { rows } = await client.query<ServiceAccountRow>(
          `${SELECT_SERVICE_ACCOUNT} AND u.id = $1`,
          [serviceAccountId],
        );
        return toServiceAccount(rows[0]!);
      });
    },
  );

  app.post(
    "/service-accounts/:serviceAccountId/restore",
    {
      preHandler: requirePersonRole("admin"),
      schema: {
        tags: ["service-accounts"],
        summary: "Restore a disabled service account",
        params: Type.Object({ serviceAccountId: Uuid }),
        response: { 200: ServiceAccount, ...errorResponses },
      },
    },
    async (request) => {
      const actor = request.user!;
      const { serviceAccountId } = request.params;

      return withTransaction(app.db, async (client) => {
        await assertServiceAccountExists(client, serviceAccountId);

        await client.query(
          `UPDATE users SET disabled_at = NULL WHERE id = $1 AND kind = 'service'`,
          [serviceAccountId],
        );

        await writeAudit(client, request, {
          action: AuditAction.SERVICE_ACCOUNT_RESTORED,
          actorUserId: actor.id,
          resourceType: "user",
          resourceId: serviceAccountId,
        });

        const { rows } = await client.query<ServiceAccountRow>(
          `${SELECT_SERVICE_ACCOUNT} AND u.id = $1`,
          [serviceAccountId],
        );
        return toServiceAccount(rows[0]!);
      });
    },
  );

  app.get(
    "/service-accounts/:serviceAccountId/tokens",
    {
      preHandler: requirePersonRole("admin"),
      schema: {
        tags: ["service-accounts"],
        summary: "Tokens issued to a service account",
        description:
          "The tokens themselves are not here and cannot be: the server keeps " +
          "a hash. The prefix is enough to tell them apart for revocation.",
        params: Type.Object({ serviceAccountId: Uuid }),
        response: { 200: ListApiTokensResponse, ...errorResponses },
      },
    },
    async (request) => {
      const { serviceAccountId } = request.params;

      return withTransaction(app.db, async (client) => {
        await assertServiceAccountExists(client, serviceAccountId);

        const { rows } = await client.query<{
          id: string;
          user_id: string;
          name: string;
          token_prefix: string;
          expires_at: string | null;
          last_used_at: string | null;
          revoked_at: string | null;
          created_at: string;
        }>(
          `SELECT id, user_id, name, token_prefix, expires_at, last_used_at,
                  revoked_at, created_at
             FROM api_tokens
            WHERE user_id = $1
            ORDER BY created_at DESC`,
          [serviceAccountId],
        );

        return {
          items: rows.map((row) => ({
            id: row.id,
            serviceAccountId: row.user_id,
            name: row.name,
            tokenPrefix: row.token_prefix,
            expiresAt: row.expires_at,
            lastUsedAt: row.last_used_at,
            revokedAt: row.revoked_at,
            createdAt: row.created_at,
          })),
        };
      });
    },
  );

  /**
   * Issuing a token. The only moment its plaintext exists on this side.
   */
  app.post(
    "/service-accounts/:serviceAccountId/tokens",
    {
      preHandler: requirePersonRole("admin"),
      schema: {
        tags: ["service-accounts"],
        summary: "Issue an API token",
        description:
          "The token is in the response and nowhere else, ever again. It is " +
          "stored as a SHA-256 hash, so it cannot be shown a second time — " +
          "losing it means issuing another and revoking this one.",
        params: Type.Object({ serviceAccountId: Uuid }),
        body: CreateApiTokenRequest,
        response: { 201: CreateApiTokenResponse, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = request.user!;
      const { serviceAccountId } = request.params;
      const { name, expiresInDays } = request.body;

      const generated = generateApiToken();

      const result = await withTransaction(app.db, async (client) => {
        const account = await assertServiceAccountExists(client, serviceAccountId);

        // Issuing a token to an account that cannot use it looks like success
        // and produces a credential that fails on first use.
        if (account.disabled) {
          throw ApiError.unprocessable(
            ServiceAccountErrorCode.TOKEN_INVALID,
            "This service account is disabled. Restore it before issuing a token.",
          );
        }

        const { rows } = await client.query<{
          id: string;
          expires_at: string | null;
          created_at: string;
        }>(
          `INSERT INTO api_tokens
             (user_id, name, token_hash, token_prefix, created_by, expires_at)
           VALUES ($1, $2, $3, $4, $5,
                   CASE WHEN $6::int IS NULL THEN NULL
                        ELSE now() + ($6::int * interval '1 day') END)
           RETURNING id, expires_at, created_at`,
          [
            serviceAccountId,
            name,
            generated.hash,
            generated.prefix,
            actor.id,
            expiresInDays ?? null,
          ],
        );
        const row = rows[0]!;

        // The prefix, never the token. An audit trail that records credentials
        // is a second place to steal them from.
        await writeAudit(client, request, {
          action: AuditAction.API_TOKEN_ISSUED,
          actorUserId: actor.id,
          resourceType: "api_token",
          resourceId: row.id,
          metadata: {
            serviceAccountId,
            name,
            tokenPrefix: generated.prefix,
            expiresAt: row.expires_at,
          },
        });

        return {
          id: row.id,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
        };
      });

      return reply.status(201).send({
        token: {
          id: result.id,
          serviceAccountId,
          name,
          tokenPrefix: generated.prefix,
          expiresAt: result.expiresAt,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: result.createdAt,
        },
        plaintext: generated.plaintext,
      });
    },
  );

  app.delete(
    "/service-accounts/:serviceAccountId/tokens/:tokenId",
    {
      preHandler: requirePersonRole("admin"),
      schema: {
        tags: ["service-accounts"],
        summary: "Revoke a token",
        description:
          "Takes effect on the next request: authentication looks the token " +
          "up every time and never caches the result.",
        params: Type.Object({ serviceAccountId: Uuid, tokenId: Uuid }),
        response: { 204: Type.Null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = request.user!;
      const { serviceAccountId, tokenId } = request.params;

      await withTransaction(app.db, async (client) => {
        const { rowCount } = await client.query(
          `UPDATE api_tokens
              SET revoked_at = now(), revoked_reason = 'revoked by administrator'
            WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
          [tokenId, serviceAccountId],
        );

        // Already revoked is success — the caller wanted it gone and it is.
        // A token that never existed is not.
        if (rowCount === 0) {
          const { rows } = await client.query<{ id: string }>(
            "SELECT id FROM api_tokens WHERE id = $1 AND user_id = $2",
            [tokenId, serviceAccountId],
          );
          if (!rows[0]) throw ApiError.notFound("Token not found.");
          return;
        }

        await writeAudit(client, request, {
          action: AuditAction.API_TOKEN_REVOKED,
          actorUserId: actor.id,
          resourceType: "api_token",
          resourceId: tokenId,
          metadata: { serviceAccountId },
        });
      });

      return reply.status(204).send(null);
    },
  );
};

/**
 * Refuses to act on an ordinary user through these endpoints.
 *
 * Without the `kind` check, `POST /service-accounts/<a real person>/tokens`
 * would issue a working credential for a member of staff, from an endpoint
 * nobody thinks of as touching people.
 */
async function assertServiceAccountExists(
  client: Parameters<Parameters<typeof withTransaction>[1]>[0],
  id: string,
): Promise<{ disabled: boolean }> {
  const { rows } = await client.query<{ kind: string; disabled_at: string | null }>(
    "SELECT kind, disabled_at FROM users WHERE id = $1",
    [id],
  );

  const row = rows[0];
  if (!row) throw ApiError.notFound("Service account not found.");

  if (row.kind !== "service") {
    throw new ApiError(
      422,
      ServiceAccountErrorCode.NOT_A_SERVICE_ACCOUNT,
      "That account is a person, not a service account.",
    );
  }

  return { disabled: row.disabled_at !== null };
}
