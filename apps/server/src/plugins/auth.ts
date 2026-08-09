import { ServiceAccountErrorCode, type Role } from "@atarimae/api-schema";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { ApiError } from "../errors.js";
import { bearerToken, hashApiToken } from "../lib/api-token.js";
import { hashSessionToken, SESSION_COOKIE } from "../lib/session.js";

export interface RequestUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  createdAt: string;
  lastLoginAt: string | null;
  /** Null when the caller authenticated with an API token. */
  sessionId: string | null;
  /** 'person' signed in with a password; 'service' presented an API token. */
  kind: "person" | "service";
  /** The token used, when there was one. Recorded in the audit trail. */
  apiTokenId?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Populated by the session hook. Null when unauthenticated. */
    user: RequestUser | null;
  }
}

/** Role ordering. Higher values include every capability of the lower ones. */
const RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };

export function hasAtLeast(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}

interface SessionRow {
  session_id: string;
  user_id: string;
  email: string;
  display_name: string;
  role: Role;
  created_at: string;
  last_login_at: string | null;
}

interface TokenRow {
  token_id: string;
  user_id: string;
  email: string;
  display_name: string;
  role: Role;
  created_at: string;
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  app.decorateRequest("user", null);

  /**
   * Resolves the session on every request.
   *
   * The lookup joins users and filters disabled accounts in the same query, so
   * disabling somebody takes effect on their very next request rather than
   * whenever their session happens to expire.
   */
  app.addHook("onRequest", async (request: FastifyRequest) => {
    /**
     * An API token, if one was presented.
     *
     * Checked before the cookie so that a browser session cannot quietly grant
     * more than the token was meant to: a request carrying both is the token's
     * request, at the token's role.
     */
    const presented = bearerToken(request.headers.authorization);
    if (presented) {
      const { rows } = await app.db.query<TokenRow>(
        `SELECT t.id AS token_id, u.id AS user_id, u.email, u.display_name,
                u.role, u.created_at
           FROM api_tokens t
           JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = $1
            AND t.revoked_at IS NULL
            AND (t.expires_at IS NULL OR t.expires_at > now())
            AND u.disabled_at IS NULL
            AND u.kind = 'service'`,
        [hashApiToken(presented)],
      );

      const token = rows[0];
      if (!token) return;

      request.user = {
        id: token.user_id,
        email: token.email,
        displayName: token.display_name,
        role: token.role,
        createdAt: token.created_at,
        lastLoginAt: null,
        sessionId: null,
        kind: "service",
        apiTokenId: token.token_id,
      };

      // Not awaited, for the same reason as the session's last_seen_at: it
      // answers "is this integration still running", and must not slow down
      // the request that proves it is.
      void app.db
        .query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1", [
          token.token_id,
        ])
        .catch((error: unknown) => {
          request.log.warn({ err: error }, "failed to update api token last_used_at");
        });

      return;
    }

    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) return;

    const { rows } = await app.db.query<SessionRow>(
      `SELECT s.id            AS session_id,
              u.id            AS user_id,
              u.email,
              u.display_name,
              u.role,
              u.created_at,
              u.last_login_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.session_token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND u.disabled_at IS NULL`,
      [hashSessionToken(raw)],
    );

    const row = rows[0];
    if (!row) return;

    request.user = {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
      sessionId: row.session_id,
      kind: "person",
    };

    // Sliding activity timestamp. Deliberately not awaited: it drives the
    // "your sessions" list and must never add latency to a real request.
    void app.db
      .query("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [row.session_id])
      .catch((error: unknown) => {
        request.log.warn({ err: error }, "failed to update session last_seen_at");
      });
  });
}

/**
 * preHandler requiring any authenticated user.
 *
 * Declared `async` deliberately. Fastify decides how to wait for a hook from
 * its arity: a two-argument hook is expected to return a promise, and a plain
 * synchronous function returning `undefined` leaves the request hanging
 * forever with no error. The three-argument `done` form would work too, but
 * async is harder to get subtly wrong.
 */

export async function requireAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!request.user) throw ApiError.unauthenticated();
}

/**
 * preHandler requiring at least `minimum`.
 *
 * Every check runs server-side against the session-resolved role. The client's
 * claim about who it is never participates.
 */
export function requireRole(minimum: Role) {
  return async function check(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    if (!request.user) throw ApiError.unauthenticated();

    if (!hasAtLeast(request.user.role, minimum)) {
      throw ApiError.forbidden(`This action requires the ${minimum} role or higher.`);
    }
  };
}

/**
 * preHandler for endpoints an API token must never reach.
 *
 * The set is small and specific: issuing tokens, managing service accounts,
 * and anything to do with sessions or passwords. Without this, an admin token
 * can mint a second token that outlives its own revocation, or create another
 * service account — and a leak stops being something you can end by revoking
 * one row.
 *
 * A person's session is still required for those operations, which is the
 * point: they are decisions somebody makes, not work an integration does.
 */
export async function denyTokenAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (request.user?.kind === "service") {
    throw new ApiError(
      403,
      ServiceAccountErrorCode.TOKEN_AUTH_NOT_ALLOWED,
      "This endpoint cannot be used with an API token. Sign in as a person.",
    );
  }
}

/** `requireRole`, with API tokens refused outright. */
export function requirePersonRole(minimum: Role) {
  const check = requireRole(minimum);

  return async function checkPerson(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    await denyTokenAuth(request, reply);
    await check(request, reply);
  };
}
