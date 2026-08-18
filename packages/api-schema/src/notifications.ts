import { Type, type Static } from "@sinclair/typebox";

import { NullableTimestamp, Timestamp, Uuid } from "./common/primitives.js";

/**
 * Reading your own notifications.
 *
 * The table has been written to since M2 and read by nothing — the same shape
 * as the audit log. It is added now because the desktop client needs it:
 * WebView2 refuses a Web Push subscription and has never implemented the
 * Notification API, so the only way a Windows client can raise a native
 * notification is for the Rust shell to ask what is waiting.
 *
 * Deliberately not a full inbox. There is no mark-as-read, no pagination, no
 * archive — a notification here is a signal that something needs confirming,
 * and the place to act on it is the announcement itself.
 */

export const NotificationEventType = Type.Union([
  Type.Literal("obligation.assigned"),
  Type.Literal("obligation.reassigned"),
  Type.Literal("obligation.deadline_reminder_24h"),
  Type.Literal("mention"),
]);
export type NotificationEventType = Static<typeof NotificationEventType>;

export const MyNotification = Type.Object(
  {
    id: Uuid,
    eventType: NotificationEventType,
    title: Type.String(),
    body: Type.String(),
    /** The announcement this is about, when there is one. */
    announcementId: Type.Union([Uuid, Type.Null()]),
    readAt: NullableTimestamp,
    createdAt: Timestamp,
  },
  { $id: "MyNotification" },
);
export type MyNotification = Static<typeof MyNotification>;

export const ListMyNotificationsQuery = Type.Object({
  /** Default true: the caller almost always wants what is outstanding. */
  unreadOnly: Type.Optional(Type.Boolean({ default: true })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  /**
   * Only notifications newer than this id.
   *
   * uuidv7 is time-ordered, so this is "since I last looked" without a clock
   * — which matters for a poller whose clock may disagree with the server's.
   */
  after: Type.Optional(Uuid),
});
export type ListMyNotificationsQuery = Static<typeof ListMyNotificationsQuery>;

export const ListMyNotificationsResponse = Type.Object(
  {
    items: Type.Array(MyNotification),
    /** Unread count, whatever the filter — for a badge. */
    unreadCount: Type.Integer(),
  },
  { $id: "ListMyNotificationsResponse" },
);
export type ListMyNotificationsResponse = Static<typeof ListMyNotificationsResponse>;
