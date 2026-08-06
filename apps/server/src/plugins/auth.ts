import type { Role } from "@atarimae/api-schema";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { ApiError } from "../errors.js";
import { hashSessionToken, SESSION_COOKIE } from "../lib/session.js";

export interface RequestUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  createdAt: string;
  lastLoginAt: string | null;
  sessionId: string;
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
