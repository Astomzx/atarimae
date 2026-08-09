import { Type, type Static } from "@sinclair/typebox";

import { NullableTimestamp, Timestamp, Uuid } from "./common/primitives.js";

/**
 * M5: 通話 — voice and video calls over the network, as LINE and WeChat do
 * them. Not telephone calls.
 *
 * Atarimae does not carry the audio and is not going to: running an SFU is a
 * product of its own. What belongs here is everything around it — who is being
 * called, when it started, whether anybody answered, and whether it is still
 * going — with the media handed to a provider an administrator chooses.
 *
 * That choice is the point. A small office should be able to point this at the
 * Jitsi already running in its server cupboard, rather than at whatever this
 * project happened to bundle.
 */

export const CallProviderKind = Type.Union([
  /** A room URL template. No credential, nothing asked of the provider. */
  Type.Literal("url"),
  /** Ask an API for a room or a join token. */
  Type.Literal("http"),
]);
export type CallProviderKind = Static<typeof CallProviderKind>;

export const CallProvider = Type.Object(
  {
    id: Uuid,
    name: Type.String(),
    kind: CallProviderKind,
    urlTemplate: Type.Union([Type.String(), Type.Null()]),
    requestUrl: Type.Union([Type.String(), Type.Null()]),
    responseUrlPath: Type.Union([Type.String(), Type.Null()]),
    /** Whether a secret is configured. Never the secret itself. */
    hasSecret: Type.Boolean(),
    isDefault: Type.Boolean(),
    disabledAt: NullableTimestamp,
    createdAt: Timestamp,
  },
  { $id: "CallProvider" },
);
export type CallProvider = Static<typeof CallProvider>;

export const ListCallProvidersResponse = Type.Object(
  { items: Type.Array(CallProvider) },
  { $id: "ListCallProvidersResponse" },
);
export type ListCallProvidersResponse = Static<typeof ListCallProvidersResponse>;

export const CreateCallProviderRequest = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120 }),
    kind: CallProviderKind,
    /**
     * kind 'url'. Must contain `{room}` — without it every call in the
     * organisation lands in one shared room, which is two conversations
     * hearing each other rather than a small bug.
     */
    urlTemplate: Type.Optional(Type.String({ maxLength: 2000 })),
    /** kind 'http'. */
    requestUrl: Type.Optional(Type.String({ maxLength: 2000 })),
    requestHeaders: Type.Optional(Type.Record(Type.String(), Type.String())),
    requestBodyTemplate: Type.Optional(Type.String({ maxLength: 4000 })),
    /** Dotted path to the join URL in the response, e.g. `data.url`. */
    responseUrlPath: Type.Optional(Type.String({ maxLength: 200 })),
    /** Substituted into headers and body as `{secret}`. Stored encrypted. */
    secret: Type.Optional(Type.String({ maxLength: 2000 })),
    isDefault: Type.Optional(Type.Boolean()),
  },
  { $id: "CreateCallProviderRequest" },
);
export type CreateCallProviderRequest = Static<typeof CreateCallProviderRequest>;

export const CallParticipant = Type.Object({
  userId: Uuid,
  displayName: Type.String(),
  joinedAt: Timestamp,
  leftAt: NullableTimestamp,
});
export type CallParticipant = Static<typeof CallParticipant>;

export const Call = Type.Object(
  {
    id: Uuid,
    channelId: Uuid,
    startedBy: Uuid,
    startedByName: Type.String(),
    startedAt: Timestamp,
    endedAt: NullableTimestamp,
    /**
     * Who actually joined. The difference between a call that happened and one
     * that rang out, which is the thing anybody wants to know afterwards.
     */
    participants: Type.Array(CallParticipant),
  },
  { $id: "Call" },
);
export type Call = Static<typeof Call>;

export const ListCallsResponse = Type.Object(
  { items: Type.Array(Call) },
  { $id: "ListCallsResponse" },
);
export type ListCallsResponse = Static<typeof ListCallsResponse>;

/**
 * The answer to joining.
 *
 * The URL is handed out here rather than with the call, because membership is
 * re-checked first — a link is not a capability, the same rule as attachments.
 */
export const JoinCallResponse = Type.Object(
  {
    call: Call,
    joinUrl: Type.String(),
  },
  { $id: "JoinCallResponse" },
);
export type JoinCallResponse = Static<typeof JoinCallResponse>;

export const CallErrorCode = {
  /** No provider is configured, so there is nowhere to hold a call. */
  NO_CALL_PROVIDER: "NO_CALL_PROVIDER",
  /** The provider could not be reached, or answered with something unusable. */
  CALL_PROVIDER_FAILED: "CALL_PROVIDER_FAILED",
  /** A URL template with no {room} placeholder. */
  CALL_PROVIDER_TEMPLATE_INVALID: "CALL_PROVIDER_TEMPLATE_INVALID",
  /** kind 'http' without a request URL or a response path. */
  CALL_PROVIDER_INCOMPLETE: "CALL_PROVIDER_INCOMPLETE",
  /** Joining or ending a call that is already over. */
  CALL_ALREADY_ENDED: "CALL_ALREADY_ENDED",
} as const;
export type CallErrorCode = (typeof CallErrorCode)[keyof typeof CallErrorCode];
