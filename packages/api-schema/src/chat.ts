import { Type, type Static } from "@sinclair/typebox";

import { NullableTimestamp, Timestamp, Uuid } from "./common/primitives.js";

/**
 * M3a chat.
 *
 * Everything here works identically on phone and desktop — the product rule is
 * that they are not two different products, and chat is where that is easiest
 * to break by accident.
 *
 * Not in v1.0 (M3b): editing, deletion, reactions, link previews, full-text
 * search, threads, presence, typing indicators.
 */

export const ChannelKind = Type.Union([
  Type.Literal("public"),
  Type.Literal("private"),
  Type.Literal("direct"),
  Type.Literal("group"),
]);
export type ChannelKind = Static<typeof ChannelKind>;

export const ChannelName = Type.String({ minLength: 1, maxLength: 80 });
export const MessageBody = Type.String({ minLength: 1, maxLength: 10_000 });

export const ChannelSummary = Type.Object(
  {
    id: Uuid,
    kind: ChannelKind,
    /** Null for conversations, which are named after their participants. */
    name: Type.Union([Type.String(), Type.Null()]),
    description: Type.Union([Type.String(), Type.Null()]),
    memberCount: Type.Integer(),
    /** Display name for a direct conversation: the other person. */
    counterpartName: Type.Union([Type.String(), Type.Null()]),
    unreadCount: Type.Integer(),
    /** True when an unread message mentions the caller. */
    hasMention: Type.Boolean(),
    lastMessageAt: NullableTimestamp,
    lastMessagePreview: Type.Union([Type.String(), Type.Null()]),
    isMember: Type.Boolean(),
    createdAt: Timestamp,
  },
  { $id: "ChannelSummary" },
);
export type ChannelSummary = Static<typeof ChannelSummary>;

export const ListChannelsResponse = Type.Object(
  { items: Type.Array(ChannelSummary) },
  { $id: "ListChannelsResponse" },
);
export type ListChannelsResponse = Static<typeof ListChannelsResponse>;

export const CreateChannelRequest = Type.Object(
  {
    name: ChannelName,
    kind: Type.Union([Type.Literal("public"), Type.Literal("private")]),
    description: Type.Optional(Type.String({ maxLength: 500 })),
    /** Initial members. The creator is always included. */
    memberIds: Type.Optional(Type.Array(Uuid, { maxItems: 500 })),
  },
  { $id: "CreateChannelRequest" },
);
export type CreateChannelRequest = Static<typeof CreateChannelRequest>;

/**
 * Opens the one-to-one conversation with someone, creating it if needed.
 *
 * Idempotent on purpose: two people must never end up with two separate
 * conversations, each holding half the history.
 */
export const OpenDirectRequest = Type.Object(
  { userId: Uuid },
  { $id: "OpenDirectRequest" },
);
export type OpenDirectRequest = Static<typeof OpenDirectRequest>;

export const MessageAttachment = Type.Object({
  id: Uuid,
  name: Type.String(),
  contentType: Type.String(),
  byteSize: Type.Integer(),
  url: Type.String(),
});

export const Message = Type.Object(
  {
    id: Uuid,
    channelId: Uuid,
    authorId: Uuid,
    authorName: Type.String(),
    body: MessageBody,
    replyToId: Type.Union([Uuid, Type.Null()]),
    /** Enough to render "in reply to …" without a second request. */
    replyToPreview: Type.Union([Type.String(), Type.Null()]),
    mentions: Type.Array(Uuid),
    attachments: Type.Array(MessageAttachment),
    createdAt: Timestamp,
  },
  { $id: "Message" },
);
export type Message = Static<typeof Message>;

export const ListMessagesQuery = Type.Object({
  /** Returns messages older than this id — ids are time-ordered (uuidv7). */
  before: Type.Optional(Uuid),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
});
export type ListMessagesQuery = Static<typeof ListMessagesQuery>;

export const ListMessagesResponse = Type.Object(
  {
    /** Oldest first, ready to render. */
    items: Type.Array(Message),
    /** Pass as `before` for the previous page. Null when at the beginning. */
    nextBefore: Type.Union([Uuid, Type.Null()]),
  },
  { $id: "ListMessagesResponse" },
);
export type ListMessagesResponse = Static<typeof ListMessagesResponse>;

/**
 * Attachments are not in this release.
 *
 * The tables exist and messages carry an (always empty) attachment list, but
 * there is no upload endpoint yet — file handling needs the validation and
 * storage rules in M6 before it is safe to accept uploads.
 */
export const SendMessageRequest = Type.Object(
  {
    body: MessageBody,
    replyToId: Type.Optional(Uuid),
  },
  { $id: "SendMessageRequest" },
);
export type SendMessageRequest = Static<typeof SendMessageRequest>;

export const MarkReadRequest = Type.Object(
  { messageId: Uuid },
  { $id: "MarkReadRequest" },
);
export type MarkReadRequest = Static<typeof MarkReadRequest>;

export const ChannelMember = Type.Object({
  userId: Uuid,
  displayName: Type.String(),
  joinedAt: Timestamp,
});
export type ChannelMember = Static<typeof ChannelMember>;

export const ListChannelMembersResponse = Type.Object(
  { items: Type.Array(ChannelMember) },
  { $id: "ListChannelMembersResponse" },
);
export type ListChannelMembersResponse = Static<typeof ListChannelMembersResponse>;

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

/**
 * Events pushed over the WebSocket.
 *
 * Delivery is best-effort: the socket makes the app feel live, it is not the
 * source of truth. A client that misses an event still sees the message on its
 * next fetch, which is why reconnecting simply reloads rather than replaying.
 */
export const RealtimeEvent = Type.Union([
  Type.Object({
    type: Type.Literal("message.created"),
    channelId: Uuid,
    message: Message,
  }),
  Type.Object({
    type: Type.Literal("channel.read"),
    channelId: Uuid,
    lastReadMessageId: Uuid,
  }),
  Type.Object({ type: Type.Literal("ping") }),
]);
export type RealtimeEvent = Static<typeof RealtimeEvent>;

export const ChatErrorCode = {
  /** Not a member, or the channel is private and the caller cannot see it. */
  CHANNEL_FORBIDDEN: "CHANNEL_FORBIDDEN",
  CHANNEL_NAME_TAKEN: "CHANNEL_NAME_TAKEN",
  CHANNEL_ARCHIVED: "CHANNEL_ARCHIVED",
  /** Direct conversations have a fixed membership. */
  CANNOT_MODIFY_DIRECT: "CANNOT_MODIFY_DIRECT",
  /** Opening a conversation with oneself. */
  CANNOT_MESSAGE_SELF: "CANNOT_MESSAGE_SELF",
  /** The message being replied to is in another channel. */
  REPLY_ACROSS_CHANNELS: "REPLY_ACROSS_CHANNELS",
} as const;
export type ChatErrorCode = (typeof ChatErrorCode)[keyof typeof ChatErrorCode];
