import { AnnouncementErrorCode, type CommandSummary } from "@atarimae/api-schema";

import type { DatabaseClient } from "../db.js";
import { ApiError } from "../errors.js";
import { assignObligations, emptySummary } from "./obligations.js";
import { resolveTargetUsers } from "./targets.js";

/**
 * Publishing.
 *
 * Everything here happens in one transaction, and that is the entire point.
 * The failure this must make impossible is an announcement that is published
 * but notifies nobody — recipients written, obligations written, and then the
 * process dying before the notification intent was recorded.
 *
 * The outbox row is therefore written inside this transaction, not sent from
 * it. SMTP being unreachable delays mail; it can never lose it.
 */

export interface PublishResult {
  recipientsCreated: number;
  obligations: CommandSummary;
  notificationsQueued: number;
  publishedRevisionId: string;
}

interface AnnouncementRow {
  id: string;
  requires_acknowledgement: boolean;
  acknowledgement_due_at: string | null;
  current_published_content_revision_id: string | null;
  current_target_version_id: string | null;
  archived_at: string | null;
}

export async function publishAnnouncement(
  client: DatabaseClient,
  announcementId: string,
  actorUserId: string,
): Promise<PublishResult> {
  // Locked for the duration: two administrators pressing publish at the same
  // moment must not both expand targets and create two sets of recipients.
  const { rows } = await client.query<AnnouncementRow>(
    `SELECT id, requires_acknowledgement, acknowledgement_due_at,
            current_published_content_revision_id, current_target_version_id,
            archived_at
       FROM announcements
      WHERE id = $1
        FOR UPDATE`,
    [announcementId],
  );

  const announcement = rows[0];
  if (!announcement) throw ApiError.notFound("Announcement not found.");

  if (announcement.archived_at) {
    throw new ApiError(
      422,
      AnnouncementErrorCode.ANNOUNCEMENT_ARCHIVED,
      "This announcement has been archived.",
    );
  }

  if (announcement.current_published_content_revision_id) {
    throw new ApiError(
      409,
      AnnouncementErrorCode.ANNOUNCEMENT_ALREADY_PUBLISHED,
      "This announcement is already published. Revise its content instead.",
    );
  }

  if (!announcement.current_target_version_id) {
    throw new ApiError(
      422,
      AnnouncementErrorCode.NO_TARGETS,
      "Set at least one target before publishing.",
    );
  }

  // The latest revision becomes the published one.
  const { rows: revisions } = await client.query<{ id: string }>(
    `SELECT id FROM announcement_content_revisions
      WHERE announcement_id = $1
      ORDER BY version_no DESC
      LIMIT 1`,
    [announcementId],
  );

  const revisionId = revisions[0]?.id;
  if (!revisionId) {
    throw new ApiError(
      422,
      AnnouncementErrorCode.ANNOUNCEMENT_NOT_PUBLISHED,
      "This announcement has no content to publish.",
    );
  }

  const resolved = await resolveTargetUsers(
    client,
    announcement.current_target_version_id,
  );

  if (resolved.length === 0) {
    // Publishing to nobody is always a mistake — usually a department that is
    // empty or whose members were all disabled. Refusing is far kinder than a
    // published announcement with a 0/0 acknowledgement rate.
    throw new ApiError(
      422,
      AnnouncementErrorCode.NO_RESOLVED_RECIPIENTS,
      "The selected targets currently contain no active members.",
    );
  }

  let recipientsCreated = 0;

  for (const person of resolved) {
    const { rows: inserted } = await client.query<{ id: string }>(
      `INSERT INTO announcement_recipients (announcement_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (announcement_id, user_id) DO NOTHING
       RETURNING id`,
      [announcementId, person.userId],
    );

    let recipientId = inserted[0]?.id;
    if (recipientId) {
      recipientsCreated += 1;
    } else {
      const { rows: existing } = await client.query<{ id: string }>(
        `SELECT id FROM announcement_recipients
          WHERE announcement_id = $1 AND user_id = $2`,
        [announcementId, person.userId],
      );
      recipientId = existing[0]!.id;
    }

    // Why this person is here. Several targets may have matched them; all are
    // recorded, so "why was I included" stays answerable years later.
    for (const targetId of person.targetIds) {
      await client.query(
        `INSERT INTO announcement_recipient_sources (recipient_id, target_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [recipientId, targetId],
      );
    }
  }

  await client.query(
    `UPDATE announcements
        SET current_published_content_revision_id = $2
      WHERE id = $1`,
    [announcementId, revisionId],
  );

  // No acknowledgement required means no obligations at all — which is why
  // obligations carry no `required` flag of their own.
  const obligations = announcement.requires_acknowledgement
    ? await assignObligations(client, {
        announcementId,
        contentRevisionId: revisionId,
        announcementDueAt: announcement.acknowledgement_due_at,
        operation: "initial_assignment",
      })
    : emptySummary();

  await client.query(
    `INSERT INTO announcement_events
       (announcement_id, event_type, actor_user_id, metadata)
     VALUES ($1, 'published', $2, $3::jsonb)`,
    [
      announcementId,
      actorUserId,
      JSON.stringify({
        recipientsCreated,
        obligationsCreated: obligations.createdCount,
        contentRevisionId: revisionId,
      }),
    ],
  );

  return {
    recipientsCreated,
    obligations,
    // One outbox row per obligation. Zero when the announcement needs no
    // acknowledgement, which is correct: nobody is being asked for anything.
    notificationsQueued: obligations.createdCount,
    publishedRevisionId: revisionId,
  };
}
