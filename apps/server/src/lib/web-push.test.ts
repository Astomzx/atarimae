import { createECDH, createVerify, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  audienceFor,
  decryptPayload,
  encryptPayload,
  generateVapidKeys,
  MAX_BODY_BYTES,
  vapidAuthorization,
  type PushSubscription,
} from "./web-push.js";

/**
 * There is no browser here to produce a real subscription and no push service
 * to accept the result, so the round trip *is* the verification: this file
 * plays the part of the user agent, generating the keypair a browser would
 * generate, and decrypts what the server encrypted to it.
 *
 * That is the whole reason this is written rather than depended on. A library
 * would be equally untestable against a real endpoint from here, and trusting
 * one would have been trust rather than evidence.
 */

/** Everything a browser gives an application when it subscribes. */
function fakeBrowserSubscription(): {
  subscription: PushSubscription;
  privateKey: Buffer;
  auth: Buffer;
} {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);

  return {
    subscription: {
      endpoint: "https://push.example.test/subscription/abc123",
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: auth.toString("base64url"),
    },
    privateKey: ecdh.getPrivateKey(),
    auth,
  };
}

describe("payload encryption", () => {
  it("round trips", () => {
    const { subscription, privateKey, auth } = fakeBrowserSubscription();
    const payload = JSON.stringify({ title: "確認のお願い", body: "本日の配車です。" });

    const body = encryptPayload(subscription, payload);

    expect(decryptPayload(body, privateKey, auth)).toBe(payload);
  });

  /** Japanese is the interface language; a byte-length mistake shows up here. */
  it("round trips multi-byte text", () => {
    const { subscription, privateKey, auth } = fakeBrowserSubscription();
    const payload = "第一営業所：明日の点呼は五時三十分です。確認してください。";

    const body = encryptPayload(subscription, payload);

    expect(decryptPayload(body, privateKey, auth)).toBe(payload);
  });

  /**
   * A fresh salt and ephemeral key per message. Two identical notifications
   * that produced identical bodies would leak that they are the same message
   * to anything watching the wire.
   */
  it("produces a different body every time for the same input", () => {
    const { subscription } = fakeBrowserSubscription();

    const first = encryptPayload(subscription, "同じ本文");
    const second = encryptPayload(subscription, "同じ本文");

    expect(first.equals(second)).toBe(false);
  });

  /** The push service must not be able to read it — that is the point. */
  it("cannot be decrypted with the wrong key", () => {
    const { subscription } = fakeBrowserSubscription();
    const eavesdropper = fakeBrowserSubscription();

    const body = encryptPayload(subscription, "秘密");

    expect(() =>
      decryptPayload(body, eavesdropper.privateKey, eavesdropper.auth),
    ).toThrow();
  });

  it("cannot be decrypted with the right key and the wrong auth secret", () => {
    const { subscription, privateKey } = fakeBrowserSubscription();

    const body = encryptPayload(subscription, "秘密");

    expect(() => decryptPayload(body, privateKey, randomBytes(16))).toThrow();
  });

  /** A tampered body must fail, not decrypt to something else. */
  it("refuses a body whose ciphertext was altered", () => {
    const { subscription, privateKey, auth } = fakeBrowserSubscription();
    const body = encryptPayload(subscription, "本日の配車です。");

    const target = body.length - 20;
    body[target] = (body[target] ?? 0) ^ 0xff;

    expect(() => decryptPayload(body, privateKey, auth)).toThrow();
  });

  it("starts with the 16-byte salt and declares a 65-byte key", () => {
    const { subscription } = fakeBrowserSubscription();
    const body = encryptPayload(subscription, "x", Buffer.alloc(16, 7));

    expect(body.subarray(0, 16).equals(Buffer.alloc(16, 7))).toBe(true);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body[20]).toBe(65);
  });

  describe("refuses what it cannot send", () => {
    it("refuses a subscription key of the wrong length", () => {
      const { subscription } = fakeBrowserSubscription();
      const broken = { ...subscription, p256dh: Buffer.alloc(10).toString("base64url") };

      expect(() => encryptPayload(broken, "x")).toThrow(/expected 65/);
    });

    it("refuses an auth secret of the wrong length", () => {
      const { subscription } = fakeBrowserSubscription();
      const broken = { ...subscription, auth: Buffer.alloc(8).toString("base64url") };

      expect(() => encryptPayload(broken, "x")).toThrow(/expected 16/);
    });

    /**
     * Better to fail here than to have a push service reject it: the delivery
     * would be recorded as failed and retried forever against a payload that
     * can never fit.
     */
    it("refuses a payload too large for a push service to accept", () => {
      const { subscription } = fakeBrowserSubscription();

      expect(() => encryptPayload(subscription, "あ".repeat(2000))).toThrow(
        new RegExp(String(MAX_BODY_BYTES)),
      );
    });
  });
});

describe("VAPID", () => {
  const keys = generateVapidKeys();

  it("generates a key a browser would accept", () => {
    const publicKey = Buffer.from(keys.publicKey, "base64url");

    expect(publicKey.length).toBe(65);
    expect(publicKey[0]).toBe(0x04);
    expect(Buffer.from(keys.privateKey, "base64url").length).toBe(32);
  });

  it("generates a different pair each time", () => {
    expect(generateVapidKeys().publicKey).not.toBe(generateVapidKeys().publicKey);
  });

  /**
   * The signature is what stops anyone who obtains an endpoint from pushing to
   * it, so it is verified here the way a push service verifies it — against
   * the public key, in raw r||s form.
   */
  it("signs a token the push service can verify", () => {
    const header = vapidAuthorization({
      audience: "https://push.example.test",
      subject: "mailto:admin@example.test",
      keys,
    });

    const token = /vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(token).not.toBeNull();

    const [head, claims, signature] = token![1]!.split(".");
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(keys.privateKey, "base64url"));

    const verified = createVerify("SHA256")
      .update(`${head}.${claims}`)
      .verify(
        {
          key: Buffer.concat([
            // SPKI wrapper for an uncompressed P-256 point.
            Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"),
            ecdh.getPublicKey(),
          ]),
          format: "der",
          type: "spki",
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(signature!, "base64url"),
      );

    expect(verified).toBe(true);
  });

  it("carries the audience and subject the service checks", () => {
    const header = vapidAuthorization({
      audience: "https://fcm.googleapis.com",
      subject: "mailto:admin@example.test",
      keys,
      now: new Date("2026-08-16T00:00:00Z"),
    });

    const claims = JSON.parse(
      Buffer.from(header.split(".")[1]!, "base64url").toString("utf8"),
    ) as { aud: string; sub: string; exp: number };

    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe("mailto:admin@example.test");
    expect(claims.exp).toBe(Math.floor(Date.UTC(2026, 7, 16) / 1000) + 12 * 60 * 60);
  });

  it("advertises the public key alongside the token", () => {
    const header = vapidAuthorization({
      audience: "https://push.example.test",
      subject: "mailto:admin@example.test",
      keys,
    });

    expect(header.endsWith(`k=${keys.publicKey}`)).toBe(true);
  });
});

describe("audienceFor", () => {
  /** The audience is the service, not the subscription — paths must be dropped. */
  it("keeps only the scheme and host", () => {
    expect(audienceFor("https://fcm.googleapis.com/fcm/send/abc:123")).toBe(
      "https://fcm.googleapis.com",
    );
  });

  it("keeps a port", () => {
    expect(audienceFor("https://push.example.test:8443/x")).toBe(
      "https://push.example.test:8443",
    );
  });
});
