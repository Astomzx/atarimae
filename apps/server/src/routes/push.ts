import {
  errorResponses,
  PushErrorCode,
  PushPublicKeyResponse,
  PushSubscriptionStatus,
  SubscribeToPushRequest,
} from "@atarimae/api-schema";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import { ApiError } from "../errors.js";
import { requireAuth } from "../plugins/auth.js";
import { loadVapidKeys } from "../services/push.js";

/**
 * Subscribing a device to push.
 *
 * The device is taken from the session, never from the request body. A device
 * token in the payload would be one more thing a client can get wrong, and it
 * would let a caller attach a subscription to a device that is not theirs.
 *
 * Which also means an API token cannot subscribe: it has no device, and a push
 * notification to an integration is not a thing.
 */

/** The device this session was created on. */
async function deviceForSession(
  app: Parameters<FastifyPluginAsyncTypebox>[0],
  sessionId: string,
): Promise<string> {
  const { rows } = await app.db.query<{ user_device_id: string | null }>(
    "SELECT user_device_id FROM sessions WHERE id = $1 AND revoked_at IS NULL",
    [sessionId],
  );

  const deviceId = rows[0]?.user_device_id;
  if (!deviceId) {
    throw new ApiError(
      422,
      PushErrorCode.NOT_A_DEVICE_SESSION,
      "This session is not associated with a device, so it cannot receive push.",
    );
  }
  return deviceId;
}

export const pushRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /**
   * The key a browser needs before it can subscribe.
   *
   * Returns null rather than failing when no keypair could be established:
   * the client's honest response is "push is unavailable", and a 500 here
   * would look like a bug in the browser's permission flow instead.
   */
  app.get(
    "/push/public-key",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["auth"],
        summary: "VAPID public key",
        response: { 200: PushPublicKeyResponse, ...errorResponses },
      },
    },
    async () => {
      try {
        const keys = await loadVapidKeys(app.db, app.secrets, app.config.PUBLIC_ORIGIN);
        return { publicKey: keys.publicKey };
      } catch (error) {
        app.log.error({ err: error }, "could not load VAPID keys");
        return { publicKey: null };
      }
    },
  );

  app.put(
    "/push/subscription",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["auth"],
        summary: "Subscribe this device to push",
        description:
          "Idempotent. Re-subscribing with the same endpoint refreshes the " +
          "keys, which is what a browser does when it rotates them.",
        body: SubscribeToPushRequest,
        response: { 200: PushSubscriptionStatus, ...errorResponses },
      },
    },
    async (request) => {
      const user = request.user!;
      if (!user.sessionId) {
        throw new ApiError(
          422,
          PushErrorCode.NOT_A_DEVICE_SESSION,
          "An API token has no device to subscribe.",
        );
      }

      const deviceId = await deviceForSession(app, user.sessionId);
      const { endpoint, keys } = request.body;

      /*
       * Keyed on the endpoint, which is what the browser considers the
       * identity of a subscription. The partial unique index covers live rows
       * only, so a previously revoked endpoint coming back — a person
       * re-granting permission — becomes a new row rather than resurrecting
       * one whose revocation is part of the record.
       */
      await app.db.query(
        `INSERT INTO push_subscriptions
           (user_device_id, endpoint, p256dh_key, auth_key, last_confirmed_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (endpoint) WHERE revoked_at IS NULL
         DO UPDATE SET p256dh_key = EXCLUDED.p256dh_key,
                       auth_key   = EXCLUDED.auth_key,
                       user_device_id = EXCLUDED.user_device_id,
                       enabled    = true,
                       last_confirmed_at = now()`,
        [deviceId, endpoint, keys.p256dh, keys.auth],
      );

      return { subscribed: true };
    },
  );

  app.delete(
    "/push/subscription",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["auth"],
        summary: "Unsubscribe this device",
        description:
          "Revokes rather than deletes, so that 'this device used to be " +
          "subscribed' stays answerable.",
        body: Type.Object({ endpoint: Type.String({ maxLength: 2048 }) }),
        response: { 200: PushSubscriptionStatus, ...errorResponses },
      },
    },
    async (request) => {
      const user = request.user!;
      if (!user.sessionId) {
        throw new ApiError(
          422,
          PushErrorCode.NOT_A_DEVICE_SESSION,
          "An API token has no device to unsubscribe.",
        );
      }

      const deviceId = await deviceForSession(app, user.sessionId);

      /*
       * Scoped to this device, not just to the endpoint. Without the device
       * clause anybody could revoke anybody's subscription by guessing — or
       * by having once been told — an endpoint URL.
       */
      await app.db.query(
        `UPDATE push_subscriptions
            SET revoked_at = now(), enabled = false
          WHERE endpoint = $1 AND user_device_id = $2 AND revoked_at IS NULL`,
        [request.body.endpoint, deviceId],
      );

      return { subscribed: false };
    },
  );
};
