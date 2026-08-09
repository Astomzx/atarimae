import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signing outbound webhooks.
 *
 * The receiver has to answer one question: did Atarimae send this, and is it
 * fresh? An HMAC over the body alone answers only the first — anybody who
 * captures a signed request can replay it forever. So the timestamp is signed
 * *with* the body, and the receiver rejects anything old.
 *
 * The header format is deliberately the one several well-known providers use:
 *
 *   X-Atarimae-Signature: t=1786190000,v1=<hex>
 *
 * because whoever is integrating has almost certainly written the verifying
 * side of it before, and a novel format is a novel way to get it wrong.
 */

export const SIGNATURE_HEADER = "x-atarimae-signature";
export const EVENT_HEADER = "x-atarimae-event";
export const DELIVERY_HEADER = "x-atarimae-delivery";

/** Secrets are 32 bytes, shown once at creation like an API token. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

/**
 * The signed string is `<timestamp>.<body>`.
 *
 * The separator matters: without it, a body starting with digits could be
 * shifted into the timestamp and produce the same signed string from different
 * inputs.
 */
export function signedPayload(timestampSeconds: number, body: string): string {
  return `${timestampSeconds}.${body}`;
}

export function computeSignature(
  secret: string,
  timestampSeconds: number,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(signedPayload(timestampSeconds, body))
    .digest("hex");
}

export function signatureHeader(
  secret: string,
  timestampSeconds: number,
  body: string,
): string {
  return `t=${timestampSeconds},v1=${computeSignature(secret, timestampSeconds, body)}`;
}

export interface ParsedSignature {
  timestamp: number;
  signatures: string[];
}

/**
 * Parses the header a receiver would read.
 *
 * Several `v1=` values are allowed on purpose: it is how a secret is rotated
 * without downtime — sign with both for a while, then drop the old one. This
 * side does not do that yet, but the format must not have to change when it
 * does.
 */
export function parseSignatureHeader(header: string): ParsedSignature | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (!key || !value) continue;
    if (key === "t") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === "v1") {
      signatures.push(value);
    }
  }

  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/** Five minutes. Long enough for a slow network, short enough to matter. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * The verification a receiver performs, implemented here so the test suite can
 * prove the signature we send is one that actually verifies — and so the
 * documentation can point at real code rather than pseudocode.
 */
export function verifySignature(
  secret: string,
  header: string,
  body: string,
  options: { nowSeconds?: number; toleranceSeconds?: number } = {},
): boolean {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;

  // Rejected in both directions: a future timestamp is as much a sign of
  // something wrong as an old one.
  if (Math.abs(now - parsed.timestamp) > tolerance) return false;

  const expected = computeSignature(secret, parsed.timestamp, body);

  return parsed.signatures.some((candidate) => constantTimeEquals(candidate, expected));
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // Length is not secret — it is fixed by the hash — but timingSafeEqual
  // throws on a mismatch, so it has to be checked first.
  return left.length === right.length && timingSafeEqual(left, right);
}
