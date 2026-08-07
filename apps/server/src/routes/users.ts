import {
  CreateUserRequest,
  errorResponses,
  ListUsersQuery,
  ListUsersResponse,
  UpdateUserRoleRequest,
  UserErrorCode,
  UserSummary,
  Uuid,
} from "@atarimae/api-schema";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import { withTransaction, type DatabaseClient } from "../db.js";
import { ApiError } from "../errors.js";
import { AuditAction, writeAudit, writeAuditBestEffort } from "../lib/audit.js";
import { hashPassword } from "../lib/password.js";
import { waiveObligationsForUser } from "../services/obligations.js";
import { requireAuth, requireRole } from "../plugins/auth.js";

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: "owner" | "admin" | "member";
  disabled_at: string | null;
  last_login_at: string | null;
  created_at: string;
  org_units: { id: string; name: string; isPrimary: boolean }[] | null;
}

const SELECT_USER = `
  SELECT u.id, u.email, u.display_name, u.role, u.disabled_at,
         u.last_login_at, u.created_at,
         COALESCE(
           (SELECT json_agg(json_build_object(
                     'id', o.id, 'name', o.name, 'isPrimary', m.is_primary)
                   ORDER BY m.is_primary DESC, o.name)
              FROM user_org_units m
              JOIN org_units o ON o.id = m.org_unit_id
             WHERE m.user_id = u.id AND m.left_at IS NULL),
           '[]'::json
         ) AS org_units
    FROM users u
`;

function toSummary(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    disabledAt: row.disabled_at,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    orgUnits: row.org_units ?? [],
  };
}

async function fetchUser(client: DatabaseClient, id: string) {
  const { rows } = await client.query<UserRow>(`${SELECT_USER} WHERE u.id = $1`, [id]);
  return rows[0];
}

export const userRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /**
   * An administrator creating another administrator, with no vendor in the
   * loop. This is the endpoint the entire project is an argument for.
   */
  app.post(
    "/users",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["users"],
        summary: "Create a member, admin or owner",
        description:
          "Admins may create admins. Only an Owner may grant the Owner role — " +
          "not because admins are untrusted, but because ownership carries " +
          "data export and transfer rights that should be deliberate.",
        body: CreateUserRequest,
        response: { 201: UserSummary, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = request.user!;
      const { email, displayName, role, password, primaryOrgUnitId } = request.body;

      if (role === "owner" && actor.role !== "owner") {
        throw new ApiError(
          403,
          UserErrorCode.OWNER_ROLE_REQUIRED,
          "Only an Owner can grant the Owner role.",
        );
      }

      const created = await withTransaction(app.db, async (client) => {
        const { rows: clash } = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM users
              WHERE lower(email) = lower($1) AND anonymized_at IS NULL
           ) AS exists`,
          [email],
        );

        if (clash[0]?.exists) {
          throw new ApiError(
            409,
            UserErrorCode.EMAIL_TAKEN,
            "That email address is already registered.",
          );
        }

        const passwordHash = password ? await hashPassword(password) : null;

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO users (email, display_name, role, password_hash)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [email, displayName, role, passwordHash],
        );

        const userId = rows[0]!.id;

        if (primaryOrgUnitId) {
          const { rows: unit } = await client.query<{ id: string }>(
            "SELECT id FROM org_units WHERE id = $1 AND disabled_at IS NULL",
            [primaryOrgUnitId],
          );
          if (!unit[0]) throw ApiError.notFound("Organisation unit not found.");

          await client.query(
            `INSERT INTO user_org_units (user_id, org_unit_id, is_primary)
             VALUES ($1, $2, true)`,
            [userId, primaryOrgUnitId],
          );
        }

        await writeAudit(client, request, {
          action: AuditAction.USER_CREATED,
          actorUserId: actor.id,
          resourceType: "user",
          resourceId: userId,
          metadata: { email, role, primaryOrgUnitId: primaryOrgUnitId ?? null },
        });

        return (await fetchUser(client, userId))!;
      });

      return reply.status(201).send(toSummary(created));
    },
  );

  app.get(
    "/users",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["users"],
        summary: "List members",
        description:
          "Any signed-in user can see the member directory. Disabled accounts " +
          "are only included for admins.",
        querystring: ListUsersQuery,
        response: { 200: ListUsersResponse, ...errorResponses },
      },
    },
    async (request) => {
      const actor = request.user!;
      const { orgUnitId, role, includeDisabled } = request.query;

      const wantsDisabled = includeDisabled === true && actor.role !== "member";

      const conditions: string[] = ["u.anonymized_at IS NULL"];
      const params: unknown[] = [];

      if (!wantsDisabled) conditions.push("u.disabled_at IS NULL");

      if (role) {
        params.push(role);
        conditions.push(`u.role = $${params.length}`);
      }

      if (orgUnitId) {
        params.push(orgUnitId);
        conditions.push(
          `EXISTS (SELECT 1 FROM user_org_units m
                    WHERE m.user_id = u.id
                      AND m.org_unit_id = $${params.length}
                      AND m.left_at IS NULL)`,
        );
      }

      const { rows } = await app.db.query<UserRow>(
        `${SELECT_USER} WHERE ${conditions.join(" AND ")} ORDER BY u.display_name`,
        params,
      );

      return { items: rows.map(toSummary) };
    },
  );

  app.get(
    "/users/:userId",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["users"],
        summary: "Get one member",
        params: Type.Object({ userId: Uuid }),
        response: { 200: UserSummary, ...errorResponses },
      },
    },
    async (request) => {
      const { rows } = await app.db.query<UserRow>(`${SELECT_USER} WHERE u.id = $1`, [
        request.params.userId,
      ]);
      const row = rows[0];
      if (!row) throw ApiError.notFound("User not found.");
      return toSummary(row);
    },
  );

  app.patch(
    "/users/:userId/role",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["users"],
        summary: "Change a member's role",
        description:
          "Granting or revoking Owner requires Owner. The database refuses any " +
          "change that would leave the organisation with no active Owner.",
        params: Type.Object({ userId: Uuid }),
        body: UpdateUserRoleRequest,
        response: { 200: UserSummary, ...errorResponses },
      },
    },
    async (request) => {
      const actor = request.user!;
      const { userId } = request.params;
      const { role } = request.body;

      if (userId === actor.id) {
        // Self-demotion is how an organisation accidentally loses its last
        // administrator. Another admin can always do it deliberately.
        throw new ApiError(
          422,
          UserErrorCode.SELF_ACTION_FORBIDDEN,
          "You cannot change your own role. Ask another administrator.",
        );
      }

      const updated = await withTransaction(app.db, async (client) => {
        const target = await fetchUser(client, userId);
        if (!target) throw ApiError.notFound("User not found.");

        // Both granting Owner and taking it away are Owner-only actions.
        if ((role === "owner" || target.role === "owner") && actor.role !== "owner") {
          throw new ApiError(
            403,
            UserErrorCode.OWNER_ROLE_REQUIRED,
            "Only an Owner can grant or revoke the Owner role.",
          );
        }

        await client.query("UPDATE users SET role = $2 WHERE id = $1", [userId, role]);

        await writeAudit(client, request, {
          action: AuditAction.USER_ROLE_CHANGED,
          actorUserId: actor.id,
          resourceType: "user",
          resourceId: userId,
          metadata: { from: target.role, to: role },
        });

        return (await fetchUser(client, userId))!;
      }).catch(rethrowLastOwner);

      return toSummary(updated);
    },
  );

  app.post(
    "/users/:userId/disable",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["users"],
        summary: "Disable a member",
        description:
          "The account can no longer sign in and every session is revoked. All " +
          "history is preserved — disabled is not deleted.",
        params: Type.Object({ userId: Uuid }),
        response: { 200: UserSummary, ...errorResponses },
      },
    },
    async (request) => {
      const actor = request.user!;
      const { userId } = request.params;

      if (userId === actor.id) {
        throw new ApiError(
          422,
          UserErrorCode.SELF_ACTION_FORBIDDEN,
          "You cannot disable your own account.",
        );
      }

      const updated = await withTransaction(app.db, async (client) => {
        const target = await fetchUser(client, userId);
        if (!target) throw ApiError.notFound("User not found.");

        if (target.role === "owner" && actor.role !== "owner") {
          throw new ApiError(
            403,
            UserErrorCode.OWNER_ROLE_REQUIRED,
            "Only an Owner can disable another Owner.",
          );
        }

        await client.query(
          "UPDATE users SET disabled_at = now() WHERE id = $1 AND disabled_at IS NULL",
          [userId],
        );

        // A disabled account must not stay signed in on a device it is already
        // logged into. The session hook filters disabled users, but revoking
        // makes it explicit and auditable.
        await client.query(
          `UPDATE sessions
              SET revoked_at = now(), revoked_reason = 'user_disabled'
            WHERE user_id = $1 AND revoked_at IS NULL`,
          [userId],
        );

        // Somebody who cannot sign in must not stay in an acknowledgement
        // denominator — every affected announcement would sit below 100%
        // permanently. Already-completed acknowledgements are left alone.
        const waived = await waiveObligationsForUser(client, userId);

        await writeAudit(client, request, {
          action: AuditAction.USER_DISABLED,
          actorUserId: actor.id,
          resourceType: "user",
          resourceId: userId,
          metadata: { obligationsWaived: waived },
        });

        return (await fetchUser(client, userId))!;
      }).catch(rethrowLastOwner);

      return toSummary(updated);
    },
  );

  app.post(
    "/users/:userId/restore",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["users"],
        summary: "Re-enable a disabled member",
        description:
          "Restores the ability to sign in. Acknowledgement obligations waived " +
          "while the account was disabled are deliberately not restored.",
        params: Type.Object({ userId: Uuid }),
        response: { 200: UserSummary, ...errorResponses },
      },
    },
    async (request) => {
      const actor = request.user!;
      const { userId } = request.params;

      const updated = await withTransaction(app.db, async (client) => {
        const target = await fetchUser(client, userId);
        if (!target) throw ApiError.notFound("User not found.");

        if (target.disabled_at === null) return target;

        await client.query("UPDATE users SET disabled_at = NULL WHERE id = $1", [userId]);

        await writeAudit(client, request, {
          action: AuditAction.USER_RESTORED,
          actorUserId: actor.id,
          resourceType: "user",
          resourceId: userId,
        });

        return (await fetchUser(client, userId))!;
      });

      await writeAuditBestEffort(app.db, request, {
        action: AuditAction.USER_RESTORED,
        actorUserId: actor.id,
        resourceType: "user",
        resourceId: userId,
        outcome: "success",
        metadata: { note: "obligations are not auto-restored" },
      });

      return toSummary(updated);
    },
  );
};

/**
 * Translates the database's owner-retention trigger into an API error.
 *
 * The rule lives in the schema so no code path can bypass it; this turns the
 * resulting exception into something a client can act on rather than a 500.
 */
function rethrowLastOwner(error: unknown): never {
  const message = error instanceof Error ? error.message : "";

  if (message.includes("At least one active Owner must remain")) {
    throw new ApiError(
      422,
      UserErrorCode.LAST_OWNER,
      "The organisation must always have at least one active Owner. Promote someone else first.",
    );
  }

  throw error;
}
