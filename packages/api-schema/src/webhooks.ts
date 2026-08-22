import { Type, type Static } from "@sinclair/typebox";

import { NullableTimestamp, Timestamp, Uuid } from "./common/primitives.js";

/**
 * Telling another system that something happened here.
 *
 * The event list is deliberately short. Every event is a promise to keep
 * sending it in that shape, and a webhook nobody uses is a compatibility
 * constraint bought for nothing.
 */

export const WebhookEvent = Type.Union([
  /** An announcement reached its recipients. Carries how many. */
  Type.Literal("announcement.published"),
  /** One person confirmed one announcement. */
  Type.Literal("announcement.acknowledged"),
  /** A member account was created — for an HR system keeping its own list. */
  Type.Literal("user.created"),
  Type.Literal("user.disabled"),
]);
export type WebhookEvent = Static<typeof WebhookEvent>;

export const Webhook = Type.Object(
  {
    id: Uuid,
    url: Type.String(),
    description: Type.Union([Type.String(), Type.Null()]),
    events: Type.Array(WebhookEvent),
    disabledAt: NullableTimestamp,
    /**
     * Health, so a dead endpoint is visible here rather than only in a log
     * nobody reads.
     */
    consecutiveFailures: Type.Integer(),
    lastSuccessAt: NullableTimestamp,
    lastFailureAt: NullableTimestamp,
    lastError: Type.Union([Type.String(), Type.Null()]),
    createdAt: Timestamp,
  },
  { $id: "Webhook" },
);
export type Webhook = Static<typeof Webhook>;

export const ListWebhooksResponse = Type.Object(
  { items: Type.Array(Webhook) },
  { $id: "ListWebhooksResponse" },
);
export type ListWebhooksResponse = Static<typeof ListWebhooksResponse>;

export const CreateWebhookRequest = Type.Object(
  {
    url: Type.String({ maxLength: 2000 }),
    events: Type.Array(WebhookEvent, { minItems: 1 }),
    description: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { $id: "CreateWebhookRequest" },
);
export type CreateWebhookRequest = Static<typeof CreateWebhookRequest>;

/**
 * The signing secret, shown once.
 *
 * Unlike an API token this one is encrypted rather than hashed — signing needs
 * the plaintext on every delivery — but it is still not handed back after
 * creation. The receiver keeps its own copy; a second way to read it would be
 * a second way to leak it.
 */
export const CreateWebhookResponse = Type.Object(
  {
    webhook: Webhook,
    secret: Type.String({
      description: "The signing secret. Shown once. Verify X-Atarimae-Signature with it.",
    }),
  },
  { $id: "CreateWebhookResponse" },
);
export type CreateWebhookResponse = Static<typeof CreateWebhookResponse>;

/** One attempt to deliver one event to one endpoint. */
export const WebhookDelivery = Type.Object(
  {
    id: Uuid,
    event: WebhookEvent,
    attemptCount: Type.Integer(),
    lastStatus: Type.Union([Type.Integer(), Type.Null()]),
    lastError: Type.Union([Type.String(), Type.Null()]),
    deliveredAt: NullableTimestamp,
    /** When the next attempt is due. In the past means "any moment now". */
    availableAt: Timestamp,
    createdAt: Timestamp,
  },
  { $id: "WebhookDelivery" },
);
export type WebhookDelivery = Static<typeof WebhookDelivery>;

export const ListWebhookDeliveriesResponse = Type.Object(
  { items: Type.Array(WebhookDelivery) },
  { $id: "ListWebhookDeliveriesResponse" },
);
export type ListWebhookDeliveriesResponse = Static<typeof ListWebhookDeliveriesResponse>;

export const WebhookErrorCode = {
  /** Not a URL, or not http(s). */
  WEBHOOK_URL_INVALID: "WEBHOOK_URL_INVALID",
  /**
   * Loopback, link-local, private range, or cloud metadata. A webhook the
   * server fetches on its own network is a request forger if left unchecked.
   */
  WEBHOOK_URL_NOT_REACHABLE: "WEBHOOK_URL_NOT_REACHABLE",
  /** Credentials embedded in the URL, which some clients forward onward. */
  WEBHOOK_URL_HAS_CREDENTIALS: "WEBHOOK_URL_HAS_CREDENTIALS",
} as const;
export type WebhookErrorCode = (typeof WebhookErrorCode)[keyof typeof WebhookErrorCode];
