import {
  AnnouncementErrorCode,
  CsvErrorCode,
  errorResponses,
  ImportPersonalizationsRequest,
  ImportPersonalizationsResponse,
  Uuid,
} from "@atarimae/api-schema";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import { withTransaction } from "../db.js";
import { ApiError } from "../errors.js";
import { parseCsv, toCsv, UTF8_BOM } from "../lib/csv.js";
import { requestReacknowledgement } from "../services/obligations.js";
import { requireRole } from "../plugins/auth.js";

/**
 * CSV in and out.
 *
 * The export is deliberately re-importable: an administrator downloads the
 * roster, fills the `personal_body` column in Excel, and uploads the same file.
 * Anything that makes the round trip awkward — a BOM-less file that Excel
 * renders as mojibake, an id column that gets reformatted — defeats the point.
 */

const REQUIRED_COLUMN = "user_id";
const BODY_COLUMN = "personal_body";

export const announcementCsvRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /**
   * The roster to fill in. Includes each person's current paragraph so the
   * file is an edit of the present state rather than a blank form.
   */
  app.get(
    "/announcements/:announcementId/personalizations.csv",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["announcements"],
        summary: "Download the per-person content sheet",
        params: Type.Object({ announcementId: Uuid }),
        produces: ["text/csv"],
      },
    },
    async (request, reply) => {
      const { announcementId } = request.params;

      const { rows } = await app.db.query<{
        user_id: string;
        display_name: string;
        email: string;
        department: string | null;
        personal_body: string | null;
      }>(
        `SELECT u.id AS user_id, u.display_name, u.email,
                (SELECT o.name FROM user_org_units m
                   JOIN org_units o ON o.id = m.org_unit_id
                  WHERE m.user_id = u.id AND m.left_at IS NULL
                  ORDER BY m.is_primary DESC, o.name LIMIT 1) AS department,
                (SELECT p.personal_body FROM announcement_personalizations p
                  WHERE p.announcement_id = $1 AND p.user_id = u.id
                    AND p.superseded_at IS NULL) AS personal_body
           FROM users u
          WHERE u.disabled_at IS NULL AND u.anonymized_at IS NULL
          ORDER BY u.display_name`,
        [announcementId],
      );

      const csv = toCsv(
        ["user_id", "display_name", "department", "personal_body"],
        rows.map((r) => [r.user_id, r.display_name, r.department, r.personal_body]),
      );

      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header(
          "content-disposition",
          `attachment; filename="personalizations-${announcementId}.csv"`,
        )
        .send(UTF8_BOM + csv);
    },
  );

  app.post(
    "/announcements/:announcementId/personalizations/import",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["announcements"],
        summary: "Bulk-set per-person content from CSV",
        description:
          "One transaction for the whole file. Fifty rows of which twenty-three " +
          "succeeded is not an acceptable state, so a single unusable row " +
          "rejects the batch and nothing is written.",
        params: Type.Object({ announcementId: Uuid }),
        body: ImportPersonalizationsRequest,
        response: { 200: ImportPersonalizationsResponse, ...errorResponses },
      },
    },
    async (request) => {
      const actor = request.user!;
      const { announcementId } = request.params;
      const { csv, changeKind, requireReacknowledgement } = request.body;

      const parsed = parseCsv(csv);

      if (!parsed.headers.includes(REQUIRED_COLUMN)) {
        throw new ApiError(
          422,
          CsvErrorCode.CSV_MISSING_COLUMN,
          `The file must contain a "${REQUIRED_COLUMN}" column.`,
          { headers: parsed.headers },
        );
      }
      if (!parsed.headers.includes(BODY_COLUMN)) {
        throw new ApiError(
          422,
          CsvErrorCode.CSV_MISSING_COLUMN,
          `The file must contain a "${BODY_COLUMN}" column.`,
          { headers: parsed.headers },
        );
      }

      return withTransaction(app.db, async (client) => {
        const { rows: announcements } = await client.query<{
          archived_at: string | null;
          published: string | null;
          acknowledgement_due_at: string | null;
        }>(
          `SELECT archived_at,
                  current_published_content_revision_id AS published,
                  acknowledgement_due_at
             FROM announcements WHERE id = $1 FOR UPDATE`,
          [announcementId],
        );

        const announcement = announcements[0];
        if (!announcement) throw ApiError.notFound("Announcement not found.");
        if (announcement.archived_at) {
          throw new ApiError(
            422,
            AnnouncementErrorCode.ANNOUNCEMENT_ARCHIVED,
            "This announcement has been archived.",
          );
        }

        // Validate every row before writing any of them, so the rejection
        // message lists all the problems rather than only the first.
        const problems: { line: number; reason: string }[] = [];
        const entries: { userId: string; body: string; line: number }[] = [];

        for (const [index, row] of parsed.rows.entries()) {
          const line = index + 2; // header is line 1
          const userId = row[REQUIRED_COLUMN] ?? "";
          const body = row[BODY_COLUMN] ?? "";

          if (userId === "") {
            problems.push({ line, reason: "user_id is empty" });
            continue;
          }
          // Blank content means "no paragraph for this person", which is a
          // legitimate row rather than an error.
          if (body === "") continue;

          entries.push({ userId, body, line });
        }

        if (entries.length > 0) {
          const { rows: known } = await client.query<{ id: string }>(
            `SELECT id FROM users
              WHERE id = ANY($1::uuid[]) AND disabled_at IS NULL AND anonymized_at IS NULL`,
            [entries.map((e) => e.userId)],
          );
          const valid = new Set(known.map((k) => k.id));

          for (const entry of entries) {
            if (!valid.has(entry.userId)) {
              problems.push({
                line: entry.line,
                reason: `no active user with id ${entry.userId}`,
              });
            }
          }
        }

        if (problems.length > 0) {
          throw new ApiError(
            422,
            CsvErrorCode.CSV_INVALID_ROWS,
            "The file contains rows that cannot be applied. Nothing was written.",
            { problems: problems.slice(0, 50), problemCount: problems.length },
          );
        }

        let written = 0;
        let unchanged = 0;
        const changedUserIds: string[] = [];

        for (const entry of entries) {
          const { rows: existing } = await client.query<{ personal_body: string }>(
            `SELECT personal_body FROM announcement_personalizations
              WHERE announcement_id = $1 AND user_id = $2 AND superseded_at IS NULL`,
            [announcementId, entry.userId],
          );

          // Rewriting an identical paragraph would create a pointless revision
          // and, worse, could re-ask somebody who has already confirmed.
          if (existing[0]?.personal_body === entry.body) {
            unchanged += 1;
            continue;
          }

          if (existing[0]) {
            await client.query(
              `UPDATE announcement_personalizations SET superseded_at = now()
                WHERE announcement_id = $1 AND user_id = $2 AND superseded_at IS NULL`,
              [announcementId, entry.userId],
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
              entry.userId,
              entry.body,
              existing[0] ? changeKind : "initial",
              actor.id,
            ],
          );

          written += 1;
          changedUserIds.push(entry.userId);
        }

        let reacknowledgementRequested = 0;

        if (
          requireReacknowledgement &&
          changeKind === "personal_major" &&
          announcement.published &&
          changedUserIds.length > 0
        ) {
          for (const userId of changedUserIds) {
            const summary = await requestReacknowledgement(client, {
              announcementId,
              contentRevisionId: announcement.published,
              announcementDueAt: announcement.acknowledgement_due_at,
              operation: "personal_reacknowledgement",
              onlyUserId: userId,
            });
            reacknowledgementRequested += summary.createdCount;
          }
        }

        await client.query(
          `INSERT INTO announcement_events
             (announcement_id, event_type, actor_user_id, metadata)
           VALUES ($1, 'personalization_changed', $2, $3::jsonb)`,
          [
            announcementId,
            actor.id,
            JSON.stringify({
              source: "csv",
              rowCount: parsed.rows.length,
              written,
              unchanged,
              reacknowledgementRequested,
            }),
          ],
        );

        return {
          rowCount: parsed.rows.length,
          written,
          unchanged,
          reacknowledgementRequested,
        };
      });
    },
  );

  /**
   * The acknowledgement result, as a spreadsheet.
   *
   * Every organisation eventually needs this outside the product — for a
   * meeting, an audit, or a manager who works in Excel. Refusing to export it
   * is how software holds an organisation's own records hostage.
   */
  app.get(
    "/announcements/:announcementId/acknowledgements.csv",
    {
      preHandler: requireRole("admin"),
      schema: {
        tags: ["announcements"],
        summary: "Download acknowledgement results",
        params: Type.Object({ announcementId: Uuid }),
        produces: ["text/csv"],
      },
    },
    async (request, reply) => {
      const { announcementId } = request.params;

      const { rows } = await app.db.query<{
        display_name: string;
        email: string;
        department: string | null;
        state: string;
        acknowledged_at: string | null;
        due_at: string | null;
        waived_reason: string | null;
      }>(
        `SELECT u.display_name,
                u.email,
                (SELECT o.name FROM user_org_units m
                   JOIN org_units o ON o.id = m.org_unit_id
                  WHERE m.user_id = u.id AND m.left_at IS NULL
                  ORDER BY m.is_primary DESC, o.name LIMIT 1) AS department,
                CASE
                  WHEN ob.waived_at IS NOT NULL THEN 'waived'
                  WHEN ob.superseded_at IS NOT NULL THEN 'superseded'
                  WHEN a.id IS NOT NULL THEN 'acknowledged'
                  ELSE 'pending'
                END AS state,
                a.acknowledged_at,
                ob.due_at,
                ob.waived_reason
           FROM announcement_recipients r
           JOIN users u ON u.id = r.user_id
           LEFT JOIN announcement_ack_obligations ob ON ob.recipient_id = r.id
           LEFT JOIN announcement_acknowledgements a ON a.obligation_id = ob.id
          WHERE r.announcement_id = $1
          ORDER BY u.display_name, ob.assigned_at`,
        [announcementId],
      );

      const csv = toCsv(
        [
          "display_name",
          "email",
          "department",
          "state",
          "acknowledged_at",
          "due_at",
          "waived_reason",
        ],
        rows.map((r) => [
          r.display_name,
          r.email,
          r.department,
          r.state,
          r.acknowledged_at,
          r.due_at,
          r.waived_reason,
        ]),
      );

      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header(
          "content-disposition",
          `attachment; filename="acknowledgements-${announcementId}.csv"`,
        )
        .send(UTF8_BOM + csv);
    },
  );
};
