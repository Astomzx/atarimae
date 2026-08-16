import type { SecretStore } from "@atarimae/secret-store";

import type { Database } from "../db.js";
import {
  audienceFor,
  encryptPayload,
  generateVapidKeys,
  vapidAuthorization,
  type PushSubscription,
  type VapidKeys,
} from "../lib/web-push.js";

/**
 * Sending a push, and knowing when to stop.
 *
 * `lib/web-push.ts` owns the cryptography and nothing else. This owns the
 * parts that touch the outside world: where the VAPID keypair lives, what a
 * push service's reply means, and when a subscription should be given up on.
 *
 * The thing worth understanding here is that a dead subscription is the normal
 * case, not an error. Browsers discard them when an application is uninstalled,
 * when a profile is cleared, or for no stated reason at all, and the push
 * service answers 404 or 410 forever afterwards. Retrying those is how a queue
 * fills with work that can never succeed.
 */

export const VAPID_SETTINGS_KEY = "vapid";

interface StoredVapid {
  publicKey: string;
  /** Ciphertext, via the same secret store as the SMTP password. */
  privateKeyCiphertext: string;
  /** `mailto:` or `https:` — who a push service should contact. */
  subject: string;
}

/**
 * Reads the deployment's VAPID keypair, generating one the first time.
 *
 * Generated on demand rather than at startup, and stored rather than derived
 * from configuration, because the public half is an identity the *browser*
 * remembers: every existing subscription is bound to it. A key regenerated on
 * restart would silently invalidate every subscription in the organisation,
 * and the symptom would be notifications quietly not arriving.
 *
 * Which is also why it lives in `system_settings` rather than the environment
 * — `pnpm backup` carries it, so a restore keeps working subscriptions.
 */
export async function loadVapidKeys(
  db: Database,
  secrets: SecretStore,
  subject: string,
): Promise<VapidKeys & { subject: string }> {
  const { rows } = await db.query<{ value: StoredVapid }>(
    "SELECT value FROM system_settings WHERE key = $1",
    [VAPID_SETTINGS_KEY],
  );

  const stored = rows[0]?.value;
  if (stored) {
    return {
      publicKey: stored.publicKey,
      privateKey: await secrets.decrypt(stored.privateKeyCiphertext),
      subject: stored.subject,
    };
  }

  const generated = generateVapidKeys();
  const value: StoredVapid = {
    publicKey: generated.publicKey,
    privateKeyCiphertext: await secrets.encrypt(generated.privateKey),
    subject,
  };

  /*
   * ON CONFLICT DO NOTHING, then read back. Two workers starting at once would
   * otherwise each generate a keypair and the second would overwrite the
   * first — invalidating any subscription made in between, for the lifetime of
   * the deployment.
   */
  await db.query(
    `INSERT INTO system_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO NOTHING`,
    [VAPID_SETTINGS_KEY, JSON.stringify(value)],
  );

  const { rows: settled } = await db.query<{ value: StoredVapid }>(
    "SELECT value FROM system_settings WHERE key = $1",
    [VAPID_SETTINGS_KEY],
  );

  const winner = settled[0]!.value;
  return {
    publicKey: winner.publicKey,
    privateKey: await secrets.decrypt(winner.privateKeyCiphertext),
    subject: winner.subject,
  };
}

export type PushOutcome =
  /** Accepted by the push service. Says nothing about the device seeing it. */
  | { status: "sent" }
  /**
   * The subscription is dead and will never work again. Revoke it rather than
   * retrying — this is an ordinary event, not a failure.
   */
  | { status: "gone"; reason: string }
  /** Worth trying again: the service was busy, unreachable, or broken. */
  | { status: "failed"; reason: string };

export interface PushPayload {
  title: string;
  body: string;
  /** Where clicking it should land, relative to the origin. */
  path: string;
}

/**
 * The delivery deadline a push service holds a message for.
 *
 * Four hours: long enough for a phone that is off overnight to still be told
 * before the morning shift, short enough that nobody is woken by an
 * acknowledgement request from two days ago. An announcement people are being
 * asked to confirm is time-bound by nature.
 */
const TTL_SECONDS = 4 * 60 * 60;

const REQUEST_TIMEOUT_MS = 10_000;

export interface PushSender {
  send(subscription: PushSubscription, payload: PushPayload): Promise<PushOutcome>;
  /** Handed to browsers so they can subscribe. Public half only. */
  publicKey: string;
}

export function createPushSender(keys: VapidKeys & { subject: string }): PushSender {
  return {
    publicKey: keys.publicKey,

    async send(subscription, payload) {
      let body: Buffer;
      try {
        body = encryptPayload(subscription, JSON.stringify(payload));
      } catch (error) {
        /*
         * A subscription whose keys are the wrong length, or a payload that
         * cannot fit, will never succeed however many times it is tried. Both
         * are permanent, so neither is a retry.
         */
        return { status: "gone", reason: (error as Error).message };
      }

      let response: Response;
      try {
        response = await fetch(subscription.endpoint, {
          method: "POST",
          headers: {
            Authorization: vapidAuthorization({
              audience: audienceFor(subscription.endpoint),
              subject: keys.subject,
              keys,
            }),
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            TTL: String(TTL_SECONDS),
            // Wakes a device that is saving power. These are asking somebody to
            // confirm something; arriving tomorrow is the same as not arriving.
            Urgency: "high",
          },
          body: new Uint8Array(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        return { status: "failed", reason: (error as Error).message };
      }

      if (response.ok) return { status: "sent" };

      /*
       * 404 and 410 are the browser saying this subscription no longer exists.
       * 403 means the push service rejected our VAPID identity for this
       * endpoint, which for an already-stored subscription means it was made
       * under a different key — equally permanent.
       */
      if (response.status === 404 || response.status === 410) {
        return { status: "gone", reason: `push service returned ${response.status}` };
      }
      if (response.status === 403) {
        return {
          status: "gone",
          reason: "push service refused this sender for this subscription (403)",
        };
      }

      return { status: "failed", reason: `push service returned ${response.status}` };
    },
  };
}

/**
 * Marks a subscription as gone.
 *
 * Revoked rather than deleted, in keeping with the rule that nothing here is
 * ever really removed: `push_subscriptions` carries `revoked_at` precisely so
 * that "this device used to be subscribed" stays answerable.
 */
export async function revokeSubscription(db: Database, id: string): Promise<void> {
  await db.query(
    `UPDATE push_subscriptions
        SET revoked_at = now(), enabled = false
      WHERE id = $1 AND revoked_at IS NULL`,
    [id],
  );
}
