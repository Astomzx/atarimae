import { Type, type Static } from "@sinclair/typebox";

import { NullableTimestamp, Timestamp, Uuid } from "./common/primitives.js";

/**
 * Chat.
 *
 * Everything here works identically on phone and desktop — the product rule is
 * that they are not two different products, and chat is where that is easiest
 * to break by accident.
 *
 * Not in v1.0: editing, deletion, reactions, link previews, full-text
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

export const PostingPolicy = Type.Union([
  Type.Literal("everyone"),
  Type.Literal("admins_only"),
]);
export type PostingPolicy = Static<typeof PostingPolicy>;

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
    /** Set for a channel whose membership follows an organisation unit. */
    orgUnitId: Type.Union([Uuid, Type.Null()]),
    postingPolicy: PostingPolicy,
    /** The server's answer, including role, policy and an individual mute. */
    canPost: Type.Boolean(),
    /** Administrative controls are available even when the admin is not in the unit. */
    canModerate: Type.Boolean(),
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
  /**
   * Safe to show in the conversation rather than only as a download. True only
   * for formats whose bytes the server verified and which cannot carry script —
   * never for SVG, which is not accepted at all.
   */
  inline: Type.Boolean(),
});
export type MessageAttachment = Static<typeof MessageAttachment>;

/**
 * The answer to an upload, before the message that will carry it exists.
 *
 * Uploading and sending are separate on purpose: a file starts moving while
 * the message is still being typed, and one that is too large or of the wrong
 * kind is refused then rather than when the send button is finally pressed.
 */
export const UploadAttachmentResponse = Type.Object(
  {
    id: Uuid,
    name: Type.String(),
    contentType: Type.String(),
    byteSize: Type.Integer(),
    url: Type.String(),
    inline: Type.Boolean(),
  },
  { $id: "UploadAttachmentResponse" },
);
export type UploadAttachmentResponse = Static<typeof UploadAttachmentResponse>;

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
 * Files are uploaded first and claimed here.
 *
 * An id that cannot be claimed — somebody else's upload, a different channel,
 * one already sent — fails the whole send with 422. Dropping the attachment
 * and delivering the message would be the product's own worst case: a report
 * that says it worked while the thing anybody cared about is missing.
 */
export const SendMessageRequest = Type.Object(
  {
    body: MessageBody,
    replyToId: Type.Optional(Uuid),
    attachmentIds: Type.Optional(Type.Array(Uuid, { maxItems: 10 })),
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
  role: Type.Union([
    Type.Literal("owner"),
    Type.Literal("admin"),
    Type.Literal("member"),
  ]),
  joinedAt: Timestamp,
  muted: Type.Boolean(),
});
export type ChannelMember = Static<typeof ChannelMember>;

export const ListChannelMembersResponse = Type.Object(
  { items: Type.Array(ChannelMember) },
  { $id: "ListChannelMembersResponse" },
);
export type ListChannelMembersResponse = Static<typeof ListChannelMembersResponse>;

export const UpdateChannelModerationRequest = Type.Object(
  { postingPolicy: PostingPolicy },
  { $id: "UpdateChannelModerationRequest" },
);
export type UpdateChannelModerationRequest = Static<
  typeof UpdateChannelModerationRequest
>;

export const UpdateChannelMemberMuteRequest = Type.Object(
  { muted: Type.Boolean() },
  { $id: "UpdateChannelMemberMuteRequest" },
);
export type UpdateChannelMemberMuteRequest = Static<
  typeof UpdateChannelMemberMuteRequest
>;

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
  /**
   * A call is ringing in this channel.
   *
   * This is the one event where best-effort delivery is felt: somebody is
   * waiting for an answer right now, and a client that missed it finds out on
   * its next fetch instead. That is why the channel list also carries the live
   * call — the socket makes it immediate, it does not make it true.
   */
  Type.Object({
    type: Type.Literal("call.started"),
    channelId: Uuid,
    callId: Uuid,
    startedBy: Uuid,
    startedByName: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("call.ended"),
    channelId: Uuid,
    callId: Uuid,
  }),
  Type.Object({ type: Type.Literal("ping") }),
]);
export type RealtimeEvent = Static<typeof RealtimeEvent>;

export const ChatErrorCode = {
  /** Not a member, or the channel is private and the caller cannot see it. */
  CHANNEL_FORBIDDEN: "CHANNEL_FORBIDDEN",
  CHANNEL_NAME_TAKEN: "CHANNEL_NAME_TAKEN",
  CHANNEL_ARCHIVED: "CHANNEL_ARCHIVED",
  CHANNEL_ADMINS_ONLY: "CHANNEL_ADMINS_ONLY",
  CHANNEL_MEMBER_MUTED: "CHANNEL_MEMBER_MUTED",
  CHANNEL_NOT_MODERATABLE: "CHANNEL_NOT_MODERATABLE",
  /** Direct conversations have a fixed membership. */
  CANNOT_MODIFY_DIRECT: "CANNOT_MODIFY_DIRECT",
  /** Opening a conversation with oneself. */
  CANNOT_MESSAGE_SELF: "CANNOT_MESSAGE_SELF",
  /** The message being replied to is in another channel. */
  REPLY_ACROSS_CHANNELS: "REPLY_ACROSS_CHANNELS",

  /** The extension is not on the allow-list. */
  ATTACHMENT_TYPE_NOT_ALLOWED: "ATTACHMENT_TYPE_NOT_ALLOWED",
  /** The bytes are not what the extension claims — a renamed file. */
  ATTACHMENT_CONTENT_MISMATCH: "ATTACHMENT_CONTENT_MISMATCH",
  /** Over 25 MiB, or empty. */
  ATTACHMENT_TOO_LARGE: "ATTACHMENT_TOO_LARGE",
  ATTACHMENT_EMPTY: "ATTACHMENT_EMPTY",
  /** No usable filename in the Content-Disposition header. */
  ATTACHMENT_NAME_INVALID: "ATTACHMENT_NAME_INVALID",
  /**
   * An attachment id that cannot be attached to this message: uploaded by
   * somebody else, uploaded to a different channel, already sent, or expired.
   */
  ATTACHMENT_NOT_CLAIMABLE: "ATTACHMENT_NOT_CLAIMABLE",
} as const;
export type ChatErrorCode = (typeof ChatErrorCode)[keyof typeof ChatErrorCode];
