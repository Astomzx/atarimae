import { Type, type Static } from "@sinclair/typebox";

/**
 * Push subscriptions.
 *
 * A subscription belongs to the *device the caller is signed in on*, taken
 * from the session rather than from the request body. The alternative — a
 * device token in the payload — is one more thing a client can get wrong, and
 * it would let a caller attach a subscription to somebody else's device.
 */

/** The public half of the deployment's VAPID keypair. */
export const PushPublicKeyResponse = Type.Object(
  {
    /**
     * Base64url, uncompressed P-256. Null when the server has not managed to
     * establish a keypair — the client must then say push is unavailable
     * rather than calling `subscribe` with nothing.
     */
    publicKey: Type.Union([Type.String(), Type.Null()]),
  },
  { $id: "PushPublicKeyResponse" },
);
export type PushPublicKeyResponse = Static<typeof PushPublicKeyResponse>;

export const SubscribeToPushRequest = Type.Object({
  /** `PushSubscription.endpoint` from the browser. */
  endpoint: Type.String({ format: "uri", maxLength: 2048 }),
  keys: Type.Object({
    /** Base64url, 65 bytes decoded. Validated server-side on first send. */
    p256dh: Type.String({ minLength: 1, maxLength: 200 }),
    /** Base64url, 16 bytes decoded. */
    auth: Type.String({ minLength: 1, maxLength: 64 }),
  }),
});
export type SubscribeToPushRequest = Static<typeof SubscribeToPushRequest>;

export const PushSubscriptionStatus = Type.Object(
  {
    subscribed: Type.Boolean(),
  },
  { $id: "PushSubscriptionStatus" },
);
export type PushSubscriptionStatus = Static<typeof PushSubscriptionStatus>;

export const PushErrorCode = {
  /** The caller holds an API token, which has no device to subscribe. */
  NOT_A_DEVICE_SESSION: "PUSH_NOT_A_DEVICE_SESSION",
  /** No VAPID keypair, so nothing could be sent to this subscription. */
  NOT_CONFIGURED: "PUSH_NOT_CONFIGURED",
} as const;
