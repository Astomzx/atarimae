import type { FastifyRequest } from "fastify";

import type { Database, DatabaseClient } from "../db.js";

/**
 * Append-only security audit trail.
 *
 * Distinct from announcement_events, which is the administrator-facing business
 * timeline. This one is for accountability: who did what, from where, with what
 * outcome. Nothing in the application ever updates or deletes these rows.
 */

export const AuditAction = {
  SETUP_OWNER_CREATED: "setup.owner_created",

  LOGIN_SUCCEEDED: "auth.login_succeeded",
  LOGIN_FAILED: "auth.login_failed",
  LOGOUT: "auth.logout",
  SESSION_REVOKED: "auth.session_revoked",

  USER_CREATED: "user.created",
  USER_ROLE_CHANGED: "user.role_changed",
  USER_DISABLED: "user.disabled",
  USER_RESTORED: "user.restored",

  ORG_UNIT_CREATED: "org_unit.created",
  ORG_UNIT_UPDATED: "org_unit.updated",
  ORG_UNIT_DISABLED: "org_unit.disabled",
  USER_ORG_UNIT_CHANGED: "user.org_unit_changed",
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export type AuditOutcome = "success" | "failure" | "denied";

export interface AuditEntry {
  action: AuditAction;
  actorUserId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  outcome?: AuditOutcome;
  metadata?: Record<string, unknown>;
}

/**
 * Extracts request context. `request.ip` already accounts for trusted proxy
 * headers, which is why trustProxy is enabled in production — without it every
 * audit row behind a reverse proxy records the proxy's address.
 */
function requestContext(request: FastifyRequest) {
  return {
    ip: request.ip || null,
    userAgent: request.headers["user-agent"] ?? null,
    requestId: request.id,
  };
}

export async function writeAudit(
  executor: Database | DatabaseClient,
  request: FastifyRequest,
  entry: AuditEntry,
): Promise<void> {
  const { ip, userAgent, requestId } = requestContext(request);

  await executor.query(
    `INSERT INTO audit_logs
       (actor_user_id, action, resource_type, resource_id, outcome,
        ip_address, user_agent, request_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      entry.actorUserId ?? null,
      entry.action,
      entry.resourceType ?? null,
      entry.resourceId ?? null,
      entry.outcome ?? "success",
      ip,
      userAgent,
      requestId,
      JSON.stringify(entry.metadata ?? {}),
    ],
  );
}

/**
 * Writes an audit entry without letting a logging failure break the operation
 * that is being logged.
 *
 * Only for paths outside the main transaction — a failed sign-in, for
 * instance. Anything inside a transaction writes through `writeAudit` so that
 * the audit row and the change it describes commit together or not at all.
 */
export async function writeAuditBestEffort(
  executor: Database | DatabaseClient,
  request: FastifyRequest,
  entry: AuditEntry,
): Promise<void> {
  try {
    await writeAudit(executor, request, entry);
  } catch (error) {
    request.log.error({ err: error, action: entry.action }, "failed to write audit log");
  }
}
