import {
  AuditLogQuery,
  errorResponses,
  ListAuditLogResponse,
  ListMyAuditLogResponse,
  MyAuditLogQuery,
} from "@atarimae/api-schema";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

import { requireAuth, requirePersonRole } from "../plugins/auth.js";

/**
 * Reading the audit log.
 *
 * The table was written to from the foundation and read by nothing at all — no
 * query, no route, no screen. `security.md` offered "the audit log records
 * that they did" as the answer to a hostile administrator, and collecting on
 * that promise required `psql` on the host.
 *
 * Two readers. An administrator sees everything, which is the operational
 * view. Any signed-in person sees what happened to *their own* account, which
 * is the one that changes what the promise is worth: an Owner who disables
 * somebody, changes their role or revokes their sessions becomes visible to
 * the person affected. In a company with one Owner, there is no second Owner
 * to notice.
 */

interface AuditRow {
  id: string;
  action: string;
  outcome: "success" | "failure" | "denied";
  actor_user_id: string | null;
  actor_display_name: string | null;
  resource_type: string | null;
  resource_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  request_id: string | null;
  metadata: unknown;
  created_at: string;
}

/** Keyset pagination, one row past the page so `nextBefore` is known. */
function paginate<T extends { id: string }>(
  rows: T[],
  limit: number,
): { items: T[]; nextBefore?: string } {
  if (rows.length <= limit) return { items: rows };
  const items = rows.slice(0, limit);
  return { items, nextBefore: items[items.length - 1]!.id };
}

export const auditRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /**
   * Everything, for an administrator.
   *
   * `requirePersonRole` rather than `requireRole`: an API token must not be
   * able to read the log that records what API tokens did. A leaked token is
   * already bad; a leaked token that can read the evidence of its own use and
   * everybody's sign-in addresses is worse.
   */
  app.get(
    "/audit-logs",
    {
      preHandler: requirePersonRole("admin"),
      schema: {
        tags: ["settings"],
        summary: "Audit log",
        description:
          "Every recorded action, newest first. Paginated by keyset rather " +
          "than offset — a log that is appended to constantly makes offset " +
          "pages repeat and skip entries.",
        querystring: AuditLogQuery,
        response: { 200: ListAuditLogResponse, ...errorResponses },
      },
    },
    async (request) => {
      const { limit = 50, before, action, actorUserId } = request.query;

      const { rows } = await app.db.query<AuditRow>(
        `SELECT a.id, a.action, a.outcome, a.actor_user_id,
                u.display_name AS actor_display_name,
                a.resource_type, a.resource_id,
                host(a.ip_address) AS ip_address,
                a.user_agent, a.request_id, a.metadata, a.created_at
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.actor_user_id
          WHERE ($1::uuid IS NULL OR a.id < $1)
            AND ($2::text IS NULL OR a.action = $2)
            AND ($3::uuid IS NULL OR a.actor_user_id = $3)
          ORDER BY a.id DESC
          LIMIT $4`,
        [before ?? null, action ?? null, actorUserId ?? null, limit + 1],
      );

      const page = paginate(rows, limit);

      return {
        items: page.items.map((row) => ({
          id: row.id,
          action: row.action,
          outcome: row.outcome,
          actorUserId: row.actor_user_id,
          actorDisplayName: row.actor_display_name,
          resourceType: row.resource_type,
          resourceId: row.resource_id,
          ipAddress: row.ip_address,
          userAgent: row.user_agent,
          requestId: row.request_id,
          metadata: row.metadata,
          createdAt: row.created_at,
        })),
        ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
      };
    },
  );

  /**
   * What happened to *you*, for anybody.
   *
   * Two directions, and both matter. Things you did — signing in, from where.
   * And things done to you by somebody else — your role changed, your account
   * disabled, your sessions revoked. The second is the reason this endpoint
   * exists, so it is not filtered out just because you were not the actor.
   */
  app.get(
    "/my/audit-logs",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["settings"],
        summary: "Your own audit trail",
        description:
          "Actions you took, and actions somebody else took on your account. " +
          "Includes a count of failed sign-ins against your account in the " +
          "last 24 hours.",
        querystring: MyAuditLogQuery,
        response: { 200: ListMyAuditLogResponse, ...errorResponses },
      },
    },
    async (request) => {
      const user = request.user!;
      const { limit = 50, before } = request.query;

      /*
       * `metadata` is deliberately absent from the projection, not merely from
       * the response shape. It is open-ended jsonb that already carries the
       * address somebody typed at a failed sign-in — which, for an unknown
       * address, is somebody else's. Not selecting it means a future feature
       * writing something careless into it cannot leak through this route.
       */
      const { rows } = await app.db.query<AuditRow>(
        `SELECT a.id, a.action, a.outcome, a.actor_user_id,
                u.display_name AS actor_display_name,
                NULL AS resource_type, NULL::uuid AS resource_id,
                host(a.ip_address) AS ip_address,
                a.user_agent, NULL AS request_id, NULL AS metadata, a.created_at
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.actor_user_id
          WHERE ($2::uuid IS NULL OR a.id < $2)
            AND (
                  a.actor_user_id = $1
               OR (a.resource_type = 'user' AND a.resource_id = $1)
            )
          ORDER BY a.id DESC
          LIMIT $3`,
        [user.id, before ?? null, limit + 1],
      );

      const page = paginate(rows, limit);

      const { rows: failed } = await app.db.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM audit_logs
          WHERE action = 'auth.login_failed'
            AND actor_user_id = $1
            AND created_at > now() - interval '24 hours'`,
        [user.id],
      );

      return {
        items: page.items.map((row) => ({
          id: row.id,
          action: row.action,
          outcome: row.outcome,
          // Your own name back is noise; somebody else's is the whole point.
          actorDisplayName: row.actor_user_id === user.id ? null : row.actor_display_name,
          byOther: row.actor_user_id !== null && row.actor_user_id !== user.id,
          ipAddress: row.ip_address,
          userAgent: row.user_agent,
          createdAt: row.created_at,
        })),
        ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
        recentFailedSignIns: Number(failed[0]?.count ?? "0"),
      };
    },
  );
};
