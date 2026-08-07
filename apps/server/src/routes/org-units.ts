import {
  AssignOrgUnitRequest,
  CreateOrgUnitRequest,
  errorResponses,
  ListOrgUnitsQuery,
  ListOrgUnitsResponse,
  OrgUnit,
  OrgUnitErrorCode,
  UpdateOrgUnitRequest,
  UserSummary,
  Uuid,
} from "@atarimae/api-schema";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import { withTransaction, type DatabaseClient } from "../db.js";
import { ApiError } from "../errors.js";
import { AuditAction, writeAudit } from "../lib/audit.js";
import { requireAuth, requireRole } from "../plugins/auth.js";

interface OrgUnitRow {
  id: string;
  name: string;
  kind: "department" | "branch" | "team" | "other";
  parent_id: string | null;
  description: string | null;
  disabled_at: string | null;
  member_count: string;
  created_at: string;
}

const SELECT_ORG_UNIT = `
  SELECT o.id, o.name, o.kind, o.parent_id, o.description, o.disabled_at, o.created_at,
         (SELECT count(*)
            FROM user_org_units m
            JOIN users u ON u.id = m.user_id
           WHERE m.org_unit_id = o.id
             AND m.left_at IS NULL
             AND u.disabled_at IS NULL) AS member_count
    FROM org_units o
`;

function toOrgUnit(row: OrgUnitRow) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    parentId: row.parent_id,
    description: row.description,
    disabledAt: row.disabled_at,
    memberCount: Number(row.member_count),
    createdAt: row.created_at,
  };
}

async function fetchOrgUnit(client: DatabaseClient, id: string) {
  const { rows } = await client.query<OrgUnitRow>(`${SELECT_ORG_UNIT} WHERE o.id = $1`, [
    id,
  ]);
  return rows[0];
}

/** Maps the unique-name index violation onto a usable error code. */
function rethrowNameClash(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("uq_org_units_name")) {
    throw new ApiError(
      409,
      OrgUnitErrorCode.ORG_UNIT_NAME_TAKEN,
      "Another active unit already uses that name.",
    );
  }
  throw error;
}

export const orgUnitRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    "/org-units",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["org-units"],
        summary: "Create a department, branch or team",
        body: CreateOrgUnitRequest,
        response: { 201: OrgUnit, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = request.user!;
      const { name, kind, parentId, description } = request.body;

      const created = await withTransaction(app.db, async (client) => {
        if (parentId) {
          const parent = await fetchOrgUnit(client, parentId);
          if (!parent) throw ApiError.notFound("Parent unit not found.");
        }

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO org_units (name, kind, parent_id, description)
           VALUES ($1, COALESCE($2, 'department'), $3, $4)
           RETURNING id`,
          [name, kind ?? null, parentId ?? null, description ?? null],
        );

        const id = rows[0]!.id;

        await writeAudit(client, request, {
          action: AuditAction.ORG_UNIT_CREATED,
          actorUserId: actor.id,
          resourceType: "org_unit",
          resourceId: id,
          metadata: { name, kind: kind ?? "department" },
        });

        return (await fetchOrgUnit(client, id))!;
      }).catch(rethrowNameClash);

      return reply.status(201).send(toOrgUnit(created));
    },
  );

  app.get(
    "/org-units",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["org-units"],
        summary: "List organisation units",
        description:
          "Any signed-in user can see the structure — it is what announcement " +
          "targeting is expressed in. Disabled units are admin-only.",
        querystring: ListOrgUnitsQuery,
        response: { 200: ListOrgUnitsResponse, ...errorResponses },
      },
    },
    async (request) => {
      const actor = request.user!;
      const showDisabled =
        request.query.includeDisabled === true && actor.role !== "member";

      const { rows } = await app.db.query<OrgUnitRow>(
        `${SELECT_ORG_UNIT}
         ${showDisabled ? "" : "WHERE o.disabled_at IS NULL"}
         ORDER BY o.name`,
      );

      return { items: rows.map(toOrgUnit) };
    },
  );

  app.get(
    "/org-units/:orgUnitId",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["org-units"],
        summary: "Get one organisation unit",
        params: Type.Object({ orgUnitId: Uuid }),
        response: { 200: OrgUnit, ...errorResponses },
      },
    },
    async (request) => {
      const { rows } = await app.db.query<OrgUnitRow>(
        `${SELECT_ORG_UNIT} WHERE o.id = $1`,
        [request.params.orgUnitId],
      );
      const row = rows[0];
      if (!row) throw ApiError.notFound("Organisation unit not found.");
      return toOrgUnit(row);
    },
  );

  app.patch(
    "/org-units/:orgUnitId",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["org-units"],
        summary: "Rename or re-describe a unit",
        description:
          "Renaming does not affect historical announcement targets: those " +
          "reference the unit by id, so past statistics stay intact.",
        params: Type.Object({ orgUnitId: Uuid }),
        body: UpdateOrgUnitRequest,
        response: { 200: OrgUnit, ...errorResponses },
      },
    },
    async (request) => {
      const actor = request.user!;
      const { orgUnitId } = request.params;
      const { name, kind, description } = request.body;

      const updated = await withTransaction(app.db, async (client) => {
        const before = await fetchOrgUnit(client, orgUnitId);
        if (!before) throw ApiError.notFound("Organisation unit not found.");

        await client.query(
          `UPDATE org_units
              SET name        = COALESCE($2, name),
                  kind        = COALESCE($3, kind),
                  description = CASE WHEN $4::boolean THEN $5 ELSE description END
            WHERE id = $1`,
          [
            orgUnitId,
            name ?? null,
            kind ?? null,
            description !== undefined,
            description ?? null,
          ],
        );

        await writeAudit(client, request, {
          action: AuditAction.ORG_UNIT_UPDATED,
          actorUserId: actor.id,
          resourceType: "org_unit",
          resourceId: orgUnitId,
          metadata: { from: before.name, to: name ?? before.name },
        });

        return (await fetchOrgUnit(client, orgUnitId))!;
      }).catch(rethrowNameClash);

      return toOrgUnit(updated);
    },
  );

  app.post(
    "/org-units/:orgUnitId/disable",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["org-units"],
        summary: "Disable a unit",
        description:
          "Units are never deleted. Historical announcement targets keep " +
          "referencing this id, so past acknowledgement statistics remain " +
          "explainable. Existing memberships are left in place.",
        params: Type.Object({ orgUnitId: Uuid }),
        response: { 200: OrgUnit, ...errorResponses },
      },
    },
    async (request) => {
      const actor = request.user!;
      const { orgUnitId } = request.params;

      const updated = await withTransaction(app.db, async (client) => {
        const unit = await fetchOrgUnit(client, orgUnitId);
        if (!unit) throw ApiError.notFound("Organisation unit not found.");

        await client.query(
          "UPDATE org_units SET disabled_at = now() WHERE id = $1 AND disabled_at IS NULL",
          [orgUnitId],
        );

        await writeAudit(client, request, {
          action: AuditAction.ORG_UNIT_DISABLED,
          actorUserId: actor.id,
          resourceType: "org_unit",
          resourceId: orgUnitId,
          metadata: { name: unit.name, memberCount: Number(unit.member_count) },
        });

        return (await fetchOrgUnit(client, orgUnitId))!;
      });

      return toOrgUnit(updated);
    },
  );

  app.post(
    "/org-units/:orgUnitId/restore",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["org-units"],
        summary: "Re-enable a disabled unit",
        params: Type.Object({ orgUnitId: Uuid }),
        response: { 200: OrgUnit, ...errorResponses },
      },
    },
    async (request) => {
      const actor = request.user!;
      const { orgUnitId } = request.params;

      const updated = await withTransaction(app.db, async (client) => {
        const unit = await fetchOrgUnit(client, orgUnitId);
        if (!unit) throw ApiError.notFound("Organisation unit not found.");

        await client.query("UPDATE org_units SET disabled_at = NULL WHERE id = $1", [
          orgUnitId,
        ]);

        await writeAudit(client, request, {
          action: AuditAction.ORG_UNIT_UPDATED,
          actorUserId: actor.id,
          resourceType: "org_unit",
          resourceId: orgUnitId,
          metadata: { restored: true },
        });

        return (await fetchOrgUnit(client, orgUnitId))!;
      }).catch(rethrowNameClash);

      return toOrgUnit(updated);
    },
  );

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  app.post(
    "/users/:userId/org-units",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["org-units"],
        summary: "Add a member to a unit",
        description:
          "A person may belong to several units. Setting a new primary demotes " +
          "the previous one in the same transaction, because the schema permits " +
          "only one.",
        params: Type.Object({ userId: Uuid }),
        body: AssignOrgUnitRequest,
        response: { 200: UserSummary, ...errorResponses },
      },
    },
    async (request) => {
      const actor = request.user!;
      const { userId } = request.params;
      const { orgUnitId, isPrimary } = request.body;

      await withTransaction(app.db, async (client) => {
        const { rows: userRows } = await client.query<{ id: string }>(
          "SELECT id FROM users WHERE id = $1 AND anonymized_at IS NULL",
          [userId],
        );
        if (!userRows[0]) throw ApiError.notFound("User not found.");

        const unit = await fetchOrgUnit(client, orgUnitId);
        if (!unit) throw ApiError.notFound("Organisation unit not found.");

        if (unit.disabled_at) {
          throw new ApiError(
            422,
            OrgUnitErrorCode.ORG_UNIT_DISABLED,
            "That unit is disabled and cannot take new members.",
          );
        }

        const { rows: existing } = await client.query<{ id: string }>(
          `SELECT id FROM user_org_units
            WHERE user_id = $1 AND org_unit_id = $2 AND left_at IS NULL`,
          [userId, orgUnitId],
        );

        if (existing[0] && !isPrimary) {
          throw new ApiError(
            409,
            OrgUnitErrorCode.ALREADY_ASSIGNED,
            "That member already belongs to this unit.",
          );
        }

        // Demote first: the partial unique index allows only one primary per
        // user, so the old one must stop being primary before the new one is.
        if (isPrimary) {
          await client.query(
            `UPDATE user_org_units SET is_primary = false
              WHERE user_id = $1 AND is_primary AND left_at IS NULL`,
            [userId],
          );
        }

        if (existing[0]) {
          await client.query("UPDATE user_org_units SET is_primary = $2 WHERE id = $1", [
            existing[0].id,
            isPrimary ?? false,
          ]);
        } else {
          await client.query(
            `INSERT INTO user_org_units (user_id, org_unit_id, is_primary)
             VALUES ($1, $2, $3)`,
            [userId, orgUnitId, isPrimary ?? false],
          );
        }

        await writeAudit(client, request, {
          action: AuditAction.USER_ORG_UNIT_CHANGED,
          actorUserId: actor.id,
          resourceType: "user",
          resourceId: userId,
          metadata: { orgUnitId, orgUnitName: unit.name, isPrimary: isPrimary ?? false },
        });
      });

      const { rows } = await app.db.query(
        `SELECT u.id, u.email, u.display_name, u.role, u.disabled_at,
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
           FROM users u WHERE u.id = $1`,
        [userId],
      );

      const row = rows[0] as {
        id: string;
        email: string;
        display_name: string;
        role: "owner" | "admin" | "member";
        disabled_at: string | null;
        last_login_at: string | null;
        created_at: string;
        org_units: { id: string; name: string; isPrimary: boolean }[];
      };

      return {
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        disabledAt: row.disabled_at,
        lastLoginAt: row.last_login_at,
        createdAt: row.created_at,
        orgUnits: row.org_units,
      };
    },
  );

  app.delete(
    "/users/:userId/org-units/:orgUnitId",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["org-units"],
        summary: "Remove a member from a unit",
        description:
          "Records a departure date rather than deleting the row, so it stays " +
          "possible to explain why somebody was included in a past " +
          "announcement. Leaving a unit never waives an acknowledgement " +
          "obligation — only an explicit administrative command does.",
        params: Type.Object({ userId: Uuid, orgUnitId: Uuid }),
        response: { 204: Type.Null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = request.user!;
      const { userId, orgUnitId } = request.params;

      const { rowCount } = await app.db.query(
        `UPDATE user_org_units SET left_at = now()
          WHERE user_id = $1 AND org_unit_id = $2 AND left_at IS NULL`,
        [userId, orgUnitId],
      );

      if ((rowCount ?? 0) === 0) throw ApiError.notFound("Membership not found.");

      await writeAudit(app.db, request, {
        action: AuditAction.USER_ORG_UNIT_CHANGED,
        actorUserId: actor.id,
        resourceType: "user",
        resourceId: userId,
        metadata: { orgUnitId, removed: true },
      });

      return reply.status(204).send(null);
    },
  );
};
