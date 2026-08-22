import {
  errorResponses,
  ListMyNotificationsQuery,
  ListMyNotificationsResponse,
} from "@atarimae/api-schema";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

import { requireAuth } from "../plugins/auth.js";

/**
 * Reading your own notifications.
 *
 * Written to since announcement delivery was introduced, read by nothing until now. It is added because the
 * desktop client cannot do without it: WebView2 refuses a Web Push
 * subscription and has never implemented the Notification API, so a Windows
 * client can only raise a native notification by asking what is waiting.
 *
 * Deliberately narrow. No mark-as-read, no pagination, no archive — this is a
 * signal that something needs confirming, and the place to act on it is the
 * announcement.
 */

interface NotificationRow {
  id: string;
  event_type:
    | "obligation.assigned"
    | "obligation.reassigned"
    | "obligation.deadline_reminder_24h"
    | "mention";
  title: string;
  body: string;
  announcement_id: string | null;
  read_at: string | null;
  created_at: string;
}

export const notificationRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/my/notifications",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["announcements"],
        summary: "Your notifications",
        description:
          "Newest first. `after` takes a notification id rather than a " +
          "timestamp — uuidv7 is time-ordered, so a poller does not need its " +
          "clock to agree with the server's.",
        querystring: ListMyNotificationsQuery,
        response: { 200: ListMyNotificationsResponse, ...errorResponses },
      },
    },
    async (request) => {
      const user = request.user!;
      const { unreadOnly = true, limit = 50, after } = request.query;

      const { rows } = await app.db.query<NotificationRow>(
        `SELECT n.id, n.event_type, n.title, n.body,
                r.announcement_id,
                n.read_at, n.created_at
           FROM notifications n
           LEFT JOIN announcement_ack_obligations o ON o.id = n.obligation_id
           LEFT JOIN announcement_recipients r ON r.id = o.recipient_id
          WHERE n.user_id = $1
            AND ($2::boolean IS NOT TRUE OR n.read_at IS NULL)
            AND ($3::uuid IS NULL OR n.id > $3)
          ORDER BY n.id DESC
          LIMIT $4`,
        [user.id, unreadOnly, after ?? null, limit],
      );

      const { rows: unread } = await app.db.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
        [user.id],
      );

      return {
        items: rows.map((row) => ({
          id: row.id,
          eventType: row.event_type,
          title: row.title,
          body: row.body,
          announcementId: row.announcement_id,
          readAt: row.read_at,
          createdAt: row.created_at,
        })),
        unreadCount: Number(unread[0]?.count ?? "0"),
      };
    },
  );
};
