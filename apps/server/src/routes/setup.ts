import {
  CreateOwnerRequest,
  errorResponses,
  LoginResponse,
  SetupStatusResponse,
  UserErrorCode,
} from "@atarimae/api-schema";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

import { withTransaction } from "../db.js";
import { ApiError } from "../errors.js";
import { AuditAction, writeAudit } from "../lib/audit.js";
import { hashPassword } from "../lib/password.js";
import {
  createSession,
  sessionCookieOptions,
  SESSION_COOKIE,
  upsertDevice,
} from "../lib/session.js";

/**
 * First-run setup.
 *
 * Creating the first Owner is the only privileged action that cannot require
 * authentication — there is nobody to authenticate as yet. It is therefore
 * gated on the organisation being genuinely empty, and that check has to be
 * race-free.
 */
export const setupRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/setup/status",
    {
      schema: {
        tags: ["setup"],
        summary: "Whether the organisation has been initialised",
        description:
          "Unauthenticated. Reveals only whether an Owner exists, which the " +
          "first-run screen needs in order to decide what to show.",
        response: { 200: SetupStatusResponse, ...errorResponses },
      },
    },
    async () => {
      const { rows } = await app.db.query<{ initialized: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM users WHERE role = 'owner') AS initialized",
      );
      return { initialized: rows[0]?.initialized ?? false };
    },
  );

  app.post(
    "/setup/owner",
    {
      config: {
        // Brute-forcing this endpoint is pointless once initialised, but an
        // unauthenticated endpoint doing Argon2 work is a cheap way to burn
        // server CPU.
        rateLimit: { max: 5, timeWindow: "15 minutes" },
      },
      schema: {
        tags: ["setup"],
        summary: "Create the first Owner",
        description:
          "Only succeeds while no Owner exists. Signs the new Owner in " +
          "immediately, because requiring a separate login here would be one " +
          "more step with no security value.",
        body: CreateOwnerRequest,
        response: { 201: LoginResponse, ...errorResponses },
      },
    },
    async (request, reply) => {
      const { email, displayName, password } = request.body;

      const result = await withTransaction(app.db, async (client) => {
        /**
         * Serialises concurrent setup attempts.
         *
         * Without it, two requests arriving together both read "no Owner
         * exists" and both insert one. The lock is transaction-scoped and
         * released on commit or rollback.
         */
        await client.query("SELECT pg_advisory_xact_lock(hashtext('atarimae:setup'))");

        const { rows: existing } = await client.query<{ exists: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM users WHERE role = 'owner') AS exists",
        );

        if (existing[0]?.exists) {
          throw new ApiError(
            409,
            UserErrorCode.ALREADY_INITIALIZED,
            "This organisation already has an Owner. Sign in instead.",
          );
        }

        const passwordHash = await hashPassword(password);

        const { rows: created } = await client.query<{
          id: string;
          email: string;
          display_name: string;
          role: "owner";
          created_at: string;
        }>(
          `INSERT INTO users (email, display_name, password_hash, role, last_login_at)
           VALUES ($1, $2, $3, 'owner', now())
           RETURNING id, email, display_name, role, created_at`,
          [email, displayName, passwordHash],
        );

        const owner = created[0]!;

        const deviceId = await upsertDevice(client, owner.id, {
          deviceToken: undefined,
          deviceName: undefined,
        });

        const session = await createSession(client, {
          userId: owner.id,
          deviceId,
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"],
        });

        await writeAudit(client, request, {
          action: AuditAction.SETUP_OWNER_CREATED,
          actorUserId: owner.id,
          resourceType: "user",
          resourceId: owner.id,
          metadata: { email: owner.email },
        });

        return { owner, session };
      });

      reply.setCookie(
        SESSION_COOKIE,
        result.session.token,
        sessionCookieOptions(app.config.NODE_ENV === "production"),
      );

      return reply.status(201).send({
        user: {
          id: result.owner.id,
          email: result.owner.email,
          displayName: result.owner.display_name,
          role: result.owner.role,
          createdAt: result.owner.created_at,
          lastLoginAt: null,
        },
      });
    },
  );
};
