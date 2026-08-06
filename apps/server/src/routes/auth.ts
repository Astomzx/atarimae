import {
  AuthenticatedUser,
  errorResponses,
  LoginRequest,
  LoginResponse,
  SessionSummary,
  UserErrorCode,
  Uuid,
} from "@atarimae/api-schema";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import { withTransaction } from "../db.js";
import { ApiError } from "../errors.js";
import { AuditAction, writeAuditBestEffort } from "../lib/audit.js";
import { burnVerificationTime, verifyPassword } from "../lib/password.js";
import {
  createSession,
  revokeSession,
  sessionCookieOptions,
  SESSION_COOKIE,
  upsertDevice,
} from "../lib/session.js";
import { requireAuth } from "../plugins/auth.js";

interface LoginCandidate {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  role: "owner" | "admin" | "member";
  created_at: string;
  last_login_at: string | null;
  disabled_at: string | null;
}

export const authRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const isProduction = app.config.NODE_ENV === "production";

  app.post(
    "/auth/login",
    {
      config: {
        rateLimit: { max: 10, timeWindow: "15 minutes" },
      },
      schema: {
        tags: ["auth"],
        summary: "Sign in",
        description:
          "An account may be signed in on any number of devices at once. " +
          "Signing in on a second device never invalidates the first.",
        body: LoginRequest,
        response: { 200: LoginResponse, ...errorResponses },
      },
    },
    async (request, reply) => {
      const { email, password, deviceToken, deviceName } = request.body;

      const { rows } = await app.db.query<LoginCandidate>(
        `SELECT id, email, display_name, password_hash, role,
                created_at, last_login_at, disabled_at
           FROM users
          WHERE lower(email) = lower($1)
            AND anonymized_at IS NULL`,
        [email],
      );

      const candidate = rows[0];

      /**
       * An unknown address must cost the same as a known one. Skipping the
       * hash here would let an attacker enumerate valid accounts purely from
       * response timing.
       */
      if (!candidate?.password_hash) {
        await burnVerificationTime(password);
        await writeAuditBestEffort(app.db, request, {
          action: AuditAction.LOGIN_FAILED,
          outcome: "failure",
          metadata: { email, reason: candidate ? "no_password_set" : "unknown_email" },
        });
        throw new ApiError(
          401,
          UserErrorCode.INVALID_CREDENTIALS,
          "Email or password is incorrect.",
        );
      }

      const valid = await verifyPassword(candidate.password_hash, password);

      if (!valid) {
        await writeAuditBestEffort(app.db, request, {
          action: AuditAction.LOGIN_FAILED,
          actorUserId: candidate.id,
          outcome: "failure",
          metadata: { email, reason: "wrong_password" },
        });
        // Same message and status as an unknown address.
        throw new ApiError(
          401,
          UserErrorCode.INVALID_CREDENTIALS,
          "Email or password is incorrect.",
        );
      }

      /**
       * Checked after the password, on purpose. Reporting "account disabled"
       * before verifying credentials would confirm the address exists to
       * anyone who guesses it.
       */
      if (candidate.disabled_at) {
        await writeAuditBestEffort(app.db, request, {
          action: AuditAction.LOGIN_FAILED,
          actorUserId: candidate.id,
          outcome: "denied",
          metadata: { email, reason: "account_disabled" },
        });
        throw new ApiError(
          403,
          UserErrorCode.ACCOUNT_DISABLED,
          "This account has been disabled. Contact an administrator.",
        );
      }

      const session = await withTransaction(app.db, async (client) => {
        const deviceId = await upsertDevice(client, candidate.id, {
          deviceToken,
          deviceName,
          browser: request.headers["user-agent"],
        });

        const created = await createSession(client, {
          userId: candidate.id,
          deviceId,
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"],
        });

        await client.query("UPDATE users SET last_login_at = now() WHERE id = $1", [
          candidate.id,
        ]);

        return created;
      });

      await writeAuditBestEffort(app.db, request, {
        action: AuditAction.LOGIN_SUCCEEDED,
        actorUserId: candidate.id,
        resourceType: "session",
        resourceId: session.id,
      });

      reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions(isProduction));

      return {
        user: {
          id: candidate.id,
          email: candidate.email,
          displayName: candidate.display_name,
          role: candidate.role,
          createdAt: candidate.created_at,
          lastLoginAt: candidate.last_login_at,
        },
      };
    },
  );

  app.post(
    "/auth/logout",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["auth"],
        summary: "Sign out of the current session",
        description:
          "Revokes this session only. Other devices stay signed in, and the " +
          "device record and its push subscription are left untouched.",
        response: { 204: Type.Null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = request.user!;

      await revokeSession(app.db, user.sessionId, "user_signed_out");
      await writeAuditBestEffort(app.db, request, {
        action: AuditAction.LOGOUT,
        actorUserId: user.id,
        resourceType: "session",
        resourceId: user.sessionId,
      });

      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return reply.status(204).send(null);
    },
  );

  app.get(
    "/auth/me",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["auth"],
        summary: "The signed-in user",
        response: { 200: AuthenticatedUser, ...errorResponses },
      },
    },
    (request) => {
      const user = request.user!;
      return {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      };
    },
  );

  app.get(
    "/auth/sessions",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["auth"],
        summary: "My active sessions",
        description:
          "A user can see and revoke their own sessions without involving an " +
          "administrator.",
        response: {
          200: Type.Object({ items: Type.Array(SessionSummary) }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const user = request.user!;

      const { rows } = await app.db.query<{
        id: string;
        device_name: string | null;
        platform: string | null;
        browser: string | null;
        ip_address: string | null;
        created_at: string;
        last_seen_at: string;
        expires_at: string;
      }>(
        `SELECT s.id, d.device_name, d.platform, d.browser,
                host(s.ip_address) AS ip_address,
                s.created_at, s.last_seen_at, s.expires_at
           FROM sessions s
           LEFT JOIN user_devices d ON d.id = s.user_device_id
          WHERE s.user_id = $1
            AND s.revoked_at IS NULL
            AND s.expires_at > now()
          ORDER BY s.last_seen_at DESC`,
        [user.id],
      );

      return {
        items: rows.map((row) => ({
          id: row.id,
          deviceName: row.device_name,
          platform: row.platform,
          browser: row.browser,
          ipAddress: row.ip_address,
          createdAt: row.created_at,
          lastSeenAt: row.last_seen_at,
          expiresAt: row.expires_at,
          current: row.id === user.sessionId,
        })),
      };
    },
  );

  app.delete(
    "/auth/sessions/:sessionId",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["auth"],
        summary: "Revoke one of my sessions",
        params: Type.Object({ sessionId: Uuid }),
        response: { 204: Type.Null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const { sessionId } = request.params;

      // Scoped to the caller's own sessions: the id alone must not let one
      // user revoke another's session.
      const { rowCount } = await app.db.query(
        `UPDATE sessions
            SET revoked_at = now(), revoked_reason = 'user_revoked'
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [sessionId, user.id],
      );

      if ((rowCount ?? 0) === 0) throw ApiError.notFound("Session not found.");

      await writeAuditBestEffort(app.db, request, {
        action: AuditAction.SESSION_REVOKED,
        actorUserId: user.id,
        resourceType: "session",
        resourceId: sessionId,
      });

      if (sessionId === user.sessionId) reply.clearCookie(SESSION_COOKIE, { path: "/" });

      return reply.status(204).send(null);
    },
  );
};
