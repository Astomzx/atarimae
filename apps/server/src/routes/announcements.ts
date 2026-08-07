import {
  AcknowledgementStatistics,
  AcknowledgeRequest,
  AnnouncementDetail,
  AnnouncementErrorCode,
  AnnouncementSummary,
  CreateAnnouncementRequest,
  errorResponses,
  ListAnnouncementsResponse,
  ListMyAnnouncementsResponse,
  PublishResponse,
  ReviseContentRequest,
  SetPersonalizationRequest,
  SetTargetsRequest,
  SetTargetsResponse,
  Uuid,
} from "@atarimae/api-schema";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import { withTransaction, type DatabaseClient } from "../db.js";
import { ApiError } from "../errors.js";
import { publishAnnouncement } from "../services/publish.js";
import { countTargetUsers } from "../services/targets.js";
import { requireAuth, requireRole } from "../plugins/auth.js";

interface AnnouncementRow {
  id: string;
  requires_acknowledgement: boolean;
  acknowledgement_due_at: string | null;
  current_published_content_revision_id: string | null;
  current_target_version_id: string | null;
  archived_at: string | null;
  created_at: string;
  title: string | null;
  published_at: string | null;
  recipient_count: string | null;
}

/** Status is derived from the columns that define it, never stored. */
function statusOf(row: {
  archived_at: string | null;
  current_published_content_revision_id: string | null;
}): "draft" | "published" | "archived" {
  if (row.archived_at) return "archived";
  return row.current_published_content_revision_id ? "published" : "draft";
}

const SELECT_SUMMARY = `
  SELECT a.id, a.requires_acknowledgement, a.acknowledgement_due_at,
         a.current_published_content_revision_id, a.current_target_version_id,
         a.archived_at, a.created_at,
         (SELECT cr.title FROM announcement_content_revisions cr
           WHERE cr.announcement_id = a.id
           ORDER BY cr.version_no DESC LIMIT 1) AS title,
         (SELECT cr.created_at FROM announcement_content_revisions cr
           WHERE cr.id = a.current_published_content_revision_id) AS published_at,
         (SELECT count(*) FROM announcement_recipients r
           WHERE r.announcement_id = a.id) AS recipient_count
    FROM announcements a
`;

function toSummary(row: AnnouncementRow) {
  const published = row.current_published_content_revision_id !== null;
  return {
    id: row.id,
    title: row.title ?? "(無題)",
    status: statusOf(row),
    requiresAcknowledgement: row.requires_acknowledgement,
    acknowledgementDueAt: row.acknowledgement_due_at,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    recipientCount: published ? Number(row.recipient_count ?? 0) : null,
  };
}

async function loadAnnouncement(client: DatabaseClient, id: string) {
  const { rows } = await client.query<AnnouncementRow>(
    `${SELECT_SUMMARY} WHERE a.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw ApiError.notFound("Announcement not found.");
  return row;
}

function assertMutable(row: AnnouncementRow): void {
  if (row.archived_at) {
    throw new ApiError(
      422,
      AnnouncementErrorCode.ANNOUNCEMENT_ARCHIVED,
      "This announcement has been archived and can no longer be changed.",
    );
  }
}

export const announcementRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // -------------------------------------------------------------------------
  // Authoring
  // -------------------------------------------------------------------------

  app.post(
    "/announcements",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["announcements"],
        summary: "Create a draft",
        description:
          "Creates the announcement and its first content revision. Nothing is " +
          "visible to anybody until it is published.",
        body: CreateAnnouncementRequest,
        response: { 201: AnnouncementSummary, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = request.user!;
      const { title, body, requiresAcknowledgement, acknowledgementDueAt } = request.body;

      const created = await withTransaction(app.db, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO announcements
             (requires_acknowledgement, acknowledgement_due_at, created_by)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [requiresAcknowledgement ?? false, acknowledgementDueAt ?? null, actor.id],
        );
        const id = rows[0]!.id;

        await client.query(
          `INSERT INTO announcement_content_revisions
             (announcement_id, version_no, title, body, change_kind, created_by)
           VALUES ($1, 1, $2, $3, 'initial', $4)`,
          [id, title, body, actor.id],
        );

        await client.query(
          `INSERT INTO announcement_events (announcement_id, event_type, actor_user_id)
           VALUES ($1, 'created', $2)`,
          [id, actor.id],
        );

        return loadAnnouncement(client, id);
      });

      return reply.status(201).send(toSummary(created));
    },
  );

  app.get(
    "/announcements",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["announcements"],
        summary: "List announcements for administration",
        description:
          "Drafts included. Members use /my/announcements instead, which only " +
          "returns what was actually addressed to them.",
        response: { 200: ListAnnouncementsResponse, ...errorResponses },
      },
    },
    async () => {
      const { rows } = await app.db.query<AnnouncementRow>(
        `${SELECT_SUMMARY} ORDER BY a.created_at DESC`,
      );
      return { items: rows.map(toSummary) };
    },
  );

  app.get(
    "/announcements/:announcementId",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["announcements"],
        summary: "Announcement detail with targets",
        params: Type.Object({ announcementId: Uuid }),
        response: { 200: AnnouncementDetail, ...errorResponses },
      },
    },
    async (request) => {
      const { announcementId } = request.params;

      return withTransaction(app.db, async (client) => {
        const row = await loadAnnouncement(client, announcementId);

        const { rows: revisions } = await client.query<{
          id: string;
          version_no: number;
          title: string;
          body: string;
          change_kind: "initial" | "content_minor" | "content_major";
          requires_reacknowledgement: boolean;
          created_at: string;
        }>(
          `SELECT id, version_no, title, body, change_kind,
                  requires_reacknowledgement, created_at
             FROM announcement_content_revisions
            WHERE announcement_id = $1
            ORDER BY version_no DESC`,
          [announcementId],
        );

        const toRevision = (r: (typeof revisions)[number]) => ({
          id: r.id,
          versionNo: r.version_no,
          title: r.title,
          body: r.body,
          changeKind: r.change_kind,
          requiresReacknowledgement: r.requires_reacknowledgement,
          createdAt: r.created_at,
          isPublished: r.id === row.current_published_content_revision_id,
        });

        const { rows: targets } = await client.query<{
          target_kind: "all" | "org_unit" | "user";
          org_unit_id: string | null;
          user_id: string | null;
        }>(
          `SELECT target_kind, org_unit_id, user_id
             FROM announcement_targets
            WHERE target_version_id = $1`,
          [row.current_target_version_id],
        );

        return {
          id: row.id,
          status: statusOf(row),
          requiresAcknowledgement: row.requires_acknowledgement,
          acknowledgementDueAt: row.acknowledgement_due_at,
          archivedAt: row.archived_at,
          createdAt: row.created_at,
          currentContent: revisions[0] ? toRevision(revisions[0]) : null,
          publishedContent:
            revisions.find((r) => r.id === row.current_published_content_revision_id) !==
            undefined
              ? toRevision(
                  revisions.find(
                    (r) => r.id === row.current_published_content_revision_id,
                  )!,
                )
              : null,
          targets: targets.map((t) =>
            t.target_kind === "all"
              ? ({ kind: "all" } as const)
              : t.target_kind === "org_unit"
                ? ({ kind: "org_unit", orgUnitId: t.org_unit_id! } as const)
                : ({ kind: "user", userId: t.user_id! } as const),
          ),
          resolvedUserCount: await countTargetUsers(
            client,
            row.current_target_version_id,
          ),
        };
      });
    },
  );

  app.put(
    "/announcements/:announcementId/targets",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["announcements"],
        summary: "Replace the target list",
        description:
          "Creates a new target version rather than editing the current one. " +
          "Changing scope is not a content revision and never triggers " +
          "re-acknowledgement on its own.",
        params: Type.Object({ announcementId: Uuid }),
        body: SetTargetsRequest,
        response: { 200: SetTargetsResponse, ...errorResponses },
      },
    },
    async (request) => {
      const actor = request.user!;
      const { announcementId } = request.params;
      const { targets } = request.body;

      return withTransaction(app.db, async (client) => {
        const row = await loadAnnouncement(client, announcementId);
        assertMutable(row);

        const { rows: versions } = await client.query<{
          id: string;
          version_no: number;
        }>(
          `INSERT INTO announcement_target_versions
             (announcement_id, version_no, created_by)
           VALUES ($1,
                   COALESCE((SELECT max(version_no) + 1
                               FROM announcement_target_versions
                              WHERE announcement_id = $1), 1),
                   $2)
           RETURNING id, version_no`,
          [announcementId, actor.id],
        );
        const versionId = versions[0]!.id;

        for (const target of targets) {
          await client.query(
            `INSERT INTO announcement_targets
               (target_version_id, target_kind, org_unit_id, user_id)
             VALUES ($1, $2, $3, $4)`,
            [
              versionId,
              target.kind,
              target.kind === "org_unit" ? target.orgUnitId : null,
              target.kind === "user" ? target.userId : null,
            ],
          );
        }

        await client.query(
          "UPDATE announcements SET current_target_version_id = $2 WHERE id = $1",
          [announcementId, versionId],
        );

        await client.query(
          `INSERT INTO announcement_events
             (announcement_id, event_type, actor_user_id, metadata)
           VALUES ($1, 'targets_changed', $2, $3::jsonb)`,
          [announcementId, actor.id, JSON.stringify({ targetCount: targets.length })],
        );

        return {
          targetVersionNo: versions[0]!.version_no,
          resolvedUserCount: await countTargetUsers(client, versionId),
        };
      });
    },
  );

  app.post(
    "/announcements/:announcementId/content",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["announcements"],
        summary: "Add a content revision",
        description:
          "A minor change never creates obligations. A major change may, but " +
          "only when requiresReacknowledgement is set — and even then only for " +
          "people who currently hold a live obligation.",
        params: Type.Object({ announcementId: Uuid }),
        body: ReviseContentRequest,
        response: { 200: AnnouncementSummary, ...errorResponses },
      },
    },
    async (request) => {
      const actor = request.user!;
      const { announcementId } = request.params;
      const { title, body, changeKind, requiresReacknowledgement } = request.body;

      const updated = await withTransaction(app.db, async (client) => {
        const row = await loadAnnouncement(client, announcementId);
        assertMutable(row);

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO announcement_content_revisions
             (announcement_id, version_no, title, body, change_kind,
              requires_reacknowledgement, created_by)
           VALUES ($1,
                   (SELECT max(version_no) + 1 FROM announcement_content_revisions
                     WHERE announcement_id = $1),
                   $2, $3, $4, $5, $6)
           RETURNING id`,
          [
            announcementId,
            title,
            body,
            changeKind,
            requiresReacknowledgement ?? false,
            actor.id,
          ],
        );

        // A published announcement moves to the new revision immediately;
        // a draft simply gains another revision.
        if (row.current_published_content_revision_id) {
          await client.query(
            `UPDATE announcements
                SET current_published_content_revision_id = $2 WHERE id = $1`,
            [announcementId, rows[0]!.id],
          );
        }

        await client.query(
          `INSERT INTO announcement_events
             (announcement_id, event_type, actor_user_id, metadata)
           VALUES ($1, 'content_revised', $2, $3::jsonb)`,
          [announcementId, actor.id, JSON.stringify({ changeKind })],
        );

        return loadAnnouncement(client, announcementId);
      });

      return toSummary(updated);
    },
  );

  app.put(
    "/announcements/:announcementId/personalizations/:userId",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["announcements"],
        summary: "Set one person's paragraph",
        description:
          "A shared body plus a paragraph that belongs only to this person — " +
          "tomorrow's overall plan, and where this individual is expected to " +
          "be. Editable while the announcement is still a draft, because it is " +
          "keyed by user rather than by recipient.",
        params: Type.Object({ announcementId: Uuid, userId: Uuid }),
        body: SetPersonalizationRequest,
        response: { 204: Type.Null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = request.user!;
      const { announcementId, userId } = request.params;
      const { personalBody, changeKind } = request.body;

      await withTransaction(app.db, async (client) => {
        const row = await loadAnnouncement(client, announcementId);
        assertMutable(row);

        const { rows: existing } = await client.query<{ version_no: number }>(
          `SELECT version_no FROM announcement_personalizations
            WHERE announcement_id = $1 AND user_id = $2 AND superseded_at IS NULL`,
          [announcementId, userId],
        );

        // Supersede before inserting: the partial unique index permits one
        // live version per person per announcement.
        if (existing[0]) {
          await client.query(
            `UPDATE announcement_personalizations SET superseded_at = now()
              WHERE announcement_id = $1 AND user_id = $2 AND superseded_at IS NULL`,
            [announcementId, userId],
          );
        }

        await client.query(
          `INSERT INTO announcement_personalizations
             (announcement_id, user_id, version_no, personal_body, change_kind, created_by)
           VALUES ($1, $2,
                   COALESCE((SELECT max(version_no) + 1
                               FROM announcement_personalizations
                              WHERE announcement_id = $1 AND user_id = $2), 1),
                   $3, $4, $5)`,
          [
            announcementId,
            userId,
            personalBody,
            existing[0] ? (changeKind ?? "personal_minor") : "initial",
            actor.id,
          ],
        );

        await client.query(
          `INSERT INTO announcement_events
             (announcement_id, event_type, actor_user_id, subject_user_id)
           VALUES ($1, 'personalization_changed', $2, $3)`,
          [announcementId, actor.id, userId],
        );
      });

      return reply.status(204).send(null);
    },
  );

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  app.post(
    "/announcements/:announcementId/publish",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["announcements"],
        summary: "Publish",
        description:
          "Resolves targets into a recipient snapshot, records why each person " +
          "was included, creates one obligation each when acknowledgement is " +
          "required, and queues the notifications — all in one transaction. " +
          "An announcement that is published but notifies nobody is the " +
          "failure this endpoint is built to make impossible.",
        params: Type.Object({ announcementId: Uuid }),
        response: { 200: PublishResponse, ...errorResponses },
      },
    },
    async (request) => {
      const actor = request.user!;
      const { announcementId } = request.params;

      const result = await withTransaction(app.db, async (client) => {
        const published = await publishAnnouncement(client, announcementId, actor.id);
        const row = await loadAnnouncement(client, announcementId);
        return { published, row };
      });

      return {
        announcement: toSummary(result.row),
        recipientsCreated: result.published.recipientsCreated,
        obligations: result.published.obligations,
        notificationsQueued: result.published.notificationsQueued,
      };
    },
  );

  // -------------------------------------------------------------------------
  // Statistics
  // -------------------------------------------------------------------------

  app.get(
    "/announcements/:announcementId/statistics",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["announcements"],
        summary: "Acknowledgement statistics",
        description:
          "The denominator is live obligations — not current department " +
          "headcount, not total recipients, not waived rows. Every figure here " +
          "must be explainable.",
        params: Type.Object({ announcementId: Uuid }),
        response: { 200: AcknowledgementStatistics, ...errorResponses },
      },
    },
    async (request) => {
      const { announcementId } = request.params;

      const { rows: counts } = await app.db.query<{
        obligation_count: string;
        acknowledged_count: string;
        waived_count: string;
        superseded_count: string;
      }>(
        `SELECT
           count(*) FILTER (
             WHERE o.waived_at IS NULL AND o.superseded_at IS NULL
           ) AS obligation_count,
           count(*) FILTER (
             WHERE o.waived_at IS NULL AND o.superseded_at IS NULL
               AND EXISTS (SELECT 1 FROM announcement_acknowledgements a
                            WHERE a.obligation_id = o.id)
           ) AS acknowledged_count,
           count(*) FILTER (WHERE o.waived_at IS NOT NULL) AS waived_count,
           count(*) FILTER (WHERE o.superseded_at IS NOT NULL) AS superseded_count
         FROM announcement_ack_obligations o
         JOIN announcement_recipients r ON r.id = o.recipient_id
        WHERE r.announcement_id = $1`,
        [announcementId],
      );

      const { rows: people } = await app.db.query<{
        user_id: string;
        display_name: string;
        acknowledged_at: string | null;
        due_at: string | null;
      }>(
        `SELECT r.user_id, u.display_name, a.acknowledged_at, o.due_at
           FROM announcement_ack_obligations o
           JOIN announcement_recipients r ON r.id = o.recipient_id
           JOIN users u ON u.id = r.user_id
           LEFT JOIN announcement_acknowledgements a ON a.obligation_id = o.id
          WHERE r.announcement_id = $1
            AND o.waived_at IS NULL
            AND o.superseded_at IS NULL
          ORDER BY u.display_name`,
        [announcementId],
      );

      const row = counts[0]!;
      const obligationCount = Number(row.obligation_count);
      const acknowledgedCount = Number(row.acknowledged_count);

      return {
        obligationCount,
        acknowledgedCount,
        pendingCount: obligationCount - acknowledgedCount,
        waivedCount: Number(row.waived_count),
        supersededCount: Number(row.superseded_count),
        acknowledgedUsers: people
          .filter((p) => p.acknowledged_at !== null)
          .map((p) => ({
            userId: p.user_id,
            displayName: p.display_name,
            acknowledgedAt: p.acknowledged_at!,
          })),
        pendingUsers: people
          .filter((p) => p.acknowledged_at === null)
          .map((p) => ({
            userId: p.user_id,
            displayName: p.display_name,
            dueAt: p.due_at,
          })),
      };
    },
  );

  // -------------------------------------------------------------------------
  // What a recipient sees
  // -------------------------------------------------------------------------

  app.get(
    "/my/announcements",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["announcements"],
        summary: "Announcements addressed to me",
        description:
          "The shared body plus this person's own paragraph, if they have one.",
        response: { 200: ListMyAnnouncementsResponse, ...errorResponses },
      },
    },
    async (request) => {
      const user = request.user!;

      const { rows } = await app.db.query<{
        id: string;
        title: string;
        body: string;
        personal_body: string | null;
        requires_acknowledgement: boolean;
        obligation_id: string | null;
        acknowledged_at: string | null;
        due_at: string | null;
        published_at: string | null;
      }>(
        `SELECT a.id,
                cr.title,
                cr.body,
                p.personal_body,
                a.requires_acknowledgement,
                o.id            AS obligation_id,
                ack.acknowledged_at,
                o.due_at,
                cr.created_at   AS published_at
           FROM announcement_recipients r
           JOIN announcements a ON a.id = r.announcement_id
           JOIN announcement_content_revisions cr
             ON cr.id = a.current_published_content_revision_id
           LEFT JOIN announcement_ack_obligations o
             ON o.recipient_id = r.id
            AND o.waived_at IS NULL
            AND o.superseded_at IS NULL
           LEFT JOIN announcement_acknowledgements ack
             ON ack.obligation_id = o.id
           LEFT JOIN announcement_personalizations p
             ON p.announcement_id = a.id
            AND p.user_id = r.user_id
            AND p.superseded_at IS NULL
          WHERE r.user_id = $1
            AND a.archived_at IS NULL
          ORDER BY cr.created_at DESC`,
        [user.id],
      );

      return {
        items: rows.map((row) => ({
          id: row.id,
          title: row.title,
          body: row.body,
          personalBody: row.personal_body,
          requiresAcknowledgement: row.requires_acknowledgement,
          obligationId: row.obligation_id,
          acknowledgedAt: row.acknowledged_at,
          dueAt: row.due_at,
          publishedAt: row.published_at,
        })),
      };
    },
  );

  app.post(
    "/my/announcements/:announcementId/acknowledge",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["announcements"],
        summary: "Acknowledge",
        description:
          "Confirms the exact combination this person was asked about: the " +
          "published body plus their own paragraph at the time the obligation " +
          "was created.",
        params: Type.Object({ announcementId: Uuid }),
        body: AcknowledgeRequest,
        response: { 204: Type.Null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const { announcementId } = request.params;
      const { clientType } = request.body;

      await withTransaction(app.db, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `SELECT o.id
             FROM announcement_ack_obligations o
             JOIN announcement_recipients r ON r.id = o.recipient_id
            WHERE r.announcement_id = $1
              AND r.user_id = $2
              AND o.waived_at IS NULL
              AND o.superseded_at IS NULL
            FOR UPDATE OF o`,
          [announcementId, user.id],
        );

        const obligation = rows[0];
        if (!obligation) {
          throw new ApiError(
            422,
            AnnouncementErrorCode.NOT_A_RECIPIENT,
            "You have no outstanding acknowledgement for this announcement.",
          );
        }

        // The unique index makes a double submission harmless rather than a
        // duplicate record.
        await client.query(
          `INSERT INTO announcement_acknowledgements
             (obligation_id, client_type, device_id)
           VALUES ($1, $2, NULL)
           ON CONFLICT (obligation_id) DO NOTHING`,
          [obligation.id, clientType],
        );
      });

      return reply.status(204).send(null);
    },
  );
};
