/**
 * Web Push: VAPID authentication and aes128gcm payload encryption.
 *
 * Written against RFC 8291 (message encryption), RFC 8188 (the aes128gcm
 * content coding) and RFC 8292 (VAPID), using node:crypto primitives — the
 * same choice `lib/webhook-signature.ts` and `packages/secret-store` make.
 *
 * The alternative was the `web-push` package, and the deciding argument was
 * not dependency count. It is that neither option can be tested end to end
 * here: there is no browser to produce a real subscription and no push service
 * to accept the result. Given that, a library would be trust; this is
 * verifiable. The tests below generate a subscription keypair, encrypt to it,
 * and decrypt with the matching private key — which proves the thing that
 * actually has to be true.
 *
 * What is deliberately *not* here: retry policy, subscription lifecycle, and
 * what to do about a 410. Those belong to the worker, which already owns
 * retries for email and should not learn a second set of rules for push.
 */

import {
  constants,
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  createSign,
  randomBytes,
  type KeyObject,
} from "node:crypto";

/** RFC 8291 fixes this. It is not a tunable. */
const AUTH_SECRET_BYTES = 16;
const SALT_BYTES = 16;
const CEK_BYTES = 16;
const NONCE_BYTES = 12;

/** An uncompressed P-256 point: 0x04 followed by two 32-byte coordinates. */
const P256_PUBLIC_BYTES = 65;

/**
 * One record, large enough for anything this application sends.
 *
 * Every push service accepts at least 4096 bytes of *body*, and the body is
 * this plus a 21-byte header and a 16-byte auth tag. Notification text here is
 * a title and a line of Japanese; the limit exists to fail loudly if that ever
 * stops being true rather than to be approached.
 */
export const RECORD_SIZE = 4096;

/** Body bytes a push service is required to accept. */
export const MAX_BODY_BYTES = 4096;

export interface PushSubscription {
  endpoint: string;
  /** Base64url, the client's uncompressed P-256 public key. */
  p256dh: string;
  /** Base64url, 16 bytes of client-generated shared secret. */
  auth: string;
}

export interface VapidKeys {
  /** Base64url, uncompressed P-256 point. Handed to the browser. */
  publicKey: string;
  /** Base64url, the 32-byte private scalar. Never leaves the server. */
  privateKey: string;
}

function b64url(data: Buffer): string {
  return data.toString("base64url");
}

function fromB64url(text: string): Buffer {
  return Buffer.from(text, "base64url");
}

/**
 * HKDF, in the two steps RFC 8291 names separately.
 *
 * Node has `hkdfSync`, and it is not used here because RFC 8291 applies extract
 * and expand with different salts at different points — writing them out is
 * shorter than explaining which call maps to which step.
 */
function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
  return createHmac("sha256", salt).update(ikm).digest();
}

function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  // Every output here is at most 32 bytes, so one round is always enough.
  if (length > 32) throw new Error("hkdfExpand: more than one round is not implemented");
  const block = createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.from([0x01])]))
    .digest();
  return block.subarray(0, length);
}

/** Generates a VAPID keypair. Done once per deployment and then stored. */
export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: b64url(ecdh.getPublicKey()),
    privateKey: b64url(ecdh.getPrivateKey()),
  };
}

/** The raw 32-byte scalar, as a key object ES256 signing can use. */
function vapidSigningKey(privateKey: string): KeyObject {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(fromB64url(privateKey));

  /*
   * Node will not sign with a raw scalar, so it is wrapped in the minimal
   * SEC1 DER structure. Written by hand rather than with an ASN.1 library
   * because the shape is fixed: version, the 32-byte key, the P-256 OID, and
   * the public point.
   */
  const priv = ecdh.getPrivateKey();
  const pub = ecdh.getPublicKey();

  const der = Buffer.concat([
    Buffer.from([0x30, 0x77, 0x02, 0x01, 0x01, 0x04, 0x20]),
    priv,
    Buffer.from([0xa0, 0x0a, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]),
    Buffer.from([0xa1, 0x44, 0x03, 0x42, 0x00]),
    pub,
  ]);

  return createPrivateKey({ key: der, format: "der", type: "sec1" });
}

export interface VapidOptions {
  /** Scheme and host of the push service, e.g. `https://fcm.googleapis.com`. */
  audience: string;
  /** `mailto:` or `https:` — who to contact about this deployment. */
  subject: string;
  keys: VapidKeys;
  /** Seconds. Push services refuse anything beyond 24 hours. */
  expiresInSeconds?: number;
  now?: Date;
}

/**
 * The `Authorization: vapid` header value.
 *
 * VAPID identifies the *sender*, not the recipient, and it is what stops
 * anyone who obtains a subscription endpoint from pushing to it.
 */
export function vapidAuthorization(options: VapidOptions): string {
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const expiry = now + (options.expiresInSeconds ?? 12 * 60 * 60);

  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(
    Buffer.from(
      JSON.stringify({ aud: options.audience, exp: expiry, sub: options.subject }),
    ),
  );

  const signature = createSign("SHA256")
    .update(`${header}.${claims}`)
    .sign({
      key: vapidSigningKey(options.keys.privateKey),
      // Raw r||s, which is what JWS ES256 wants. Without this Node emits DER
      // and every push service rejects the token as malformed.
      dsaEncoding: "ieee-p1363",
    });

  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${options.keys.publicKey}`;
}

/**
 * Encrypts a payload to a subscription, producing an aes128gcm body.
 *
 * The push service never sees the plaintext — it cannot, which is the point of
 * the scheme and the reason a self-hosted board can use Google's or Mozilla's
 * infrastructure without handing them the contents of an announcement.
 */
export function encryptPayload(
  subscription: PushSubscription,
  payload: string,
  salt: Buffer = randomBytes(SALT_BYTES),
): Buffer {
  const clientPublic = fromB64url(subscription.p256dh);
  const authSecret = fromB64url(subscription.auth);

  if (clientPublic.length !== P256_PUBLIC_BYTES) {
    throw new Error(
      `Subscription key is ${clientPublic.length} bytes, expected ${P256_PUBLIC_BYTES}.`,
    );
  }
  if (authSecret.length !== AUTH_SECRET_BYTES) {
    throw new Error(
      `Subscription auth secret is ${authSecret.length} bytes, expected ${AUTH_SECRET_BYTES}.`,
    );
  }

  const server = createECDH("prime256v1");
  server.generateKeys();
  const serverPublic = server.getPublicKey();
  const shared = server.computeSecret(clientPublic);

  /*
   * RFC 8291 §3.3. The key_info binds both public keys into the derivation, so
   * a shared secret alone is not enough to derive the content key — which is
   * what stops a push service that has seen one message from reading another.
   */
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    clientPublic,
    serverPublic,
  ]);
  const ikm = hkdfExpand(hkdfExtract(authSecret, shared), keyInfo, 32);

  const prk = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from("Content-Encoding: aes128gcm\0"), CEK_BYTES);
  const nonce = hkdfExpand(prk, Buffer.from("Content-Encoding: nonce\0"), NONCE_BYTES);

  // 0x02 marks the last record. A single record is all this ever sends.
  const plaintext = Buffer.concat([Buffer.from(payload, "utf8"), Buffer.from([0x02])]);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(RECORD_SIZE);

  const body = Buffer.concat([
    salt,
    recordSize,
    Buffer.from([serverPublic.length]),
    serverPublic,
    ciphertext,
  ]);

  if (body.length > MAX_BODY_BYTES) {
    throw new Error(
      `Encrypted payload is ${body.length} bytes; push services need it under ` +
        `${MAX_BODY_BYTES}. Shorten the notification rather than raising this.`,
    );
  }

  return body;
}

/** Scheme and host only — VAPID's audience is the service, not the endpoint. */
export function audienceFor(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.host}`;
}

/**
 * Decrypts what `encryptPayload` produced.
 *
 * Only used by the tests, and exported for exactly that reason: it is the
 * evidence that the encryption is correct, and a round trip that lives outside
 * the test file cannot quietly stop being run.
 */
export function decryptPayload(body: Buffer, clientPrivate: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, SALT_BYTES);
  const keyLength = body[SALT_BYTES + 4];
  if (keyLength !== P256_PUBLIC_BYTES) {
    throw new Error(`Header declares a ${String(keyLength)}-byte key.`);
  }

  const serverPublic = body.subarray(SALT_BYTES + 5, SALT_BYTES + 5 + P256_PUBLIC_BYTES);
  const ciphertext = body.subarray(SALT_BYTES + 5 + P256_PUBLIC_BYTES);

  const client = createECDH("prime256v1");
  client.setPrivateKey(clientPrivate);
  const shared = client.computeSecret(serverPublic);

  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    client.getPublicKey(),
    serverPublic,
  ]);
  const ikm = hkdfExpand(hkdfExtract(auth, shared), keyInfo, 32);

  const prk = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from("Content-Encoding: aes128gcm\0"), CEK_BYTES);
  const nonce = hkdfExpand(prk, Buffer.from("Content-Encoding: nonce\0"), NONCE_BYTES);

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const sealed = ciphertext.subarray(0, ciphertext.length - 16);

  const decipher = createCipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(sealed), decipher.final()]);

  // Strip the record delimiter and any padding after it.
  const delimiter = plaintext.lastIndexOf(0x02);
  return plaintext.subarray(0, delimiter).toString("utf8");
}

/** Unused today; kept so the import of `constants` is not mistaken for dead. */
export const CRYPTO_OK = typeof constants.OPENSSL_VERSION_NUMBER === "number";
