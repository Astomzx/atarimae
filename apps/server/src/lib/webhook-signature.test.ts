import { describe, expect, it } from "vitest";

import { checkOutboundUrl } from "./outbound-url.js";
import {
  computeSignature,
  generateWebhookSecret,
  parseSignatureHeader,
  signatureHeader,
  verifySignature,
} from "./webhook-signature.js";

const SECRET = "whsec_test_secret_value";
const BODY = JSON.stringify({ event: "announcement.published", id: "abc" });
const NOW = 1_786_190_000;

describe("signing", () => {
  /**
   * The signature we send has to be one a receiver can actually verify. The
   * verifier here is the same code the documentation describes, so this is the
   * end-to-end claim, not a restatement of the implementation.
   */
  it("produces a header that verifies", () => {
    const header = signatureHeader(SECRET, NOW, BODY);

    expect(verifySignature(SECRET, header, BODY, { nowSeconds: NOW })).toBe(true);
  });

  it("fails when the body was changed in flight", () => {
    const header = signatureHeader(SECRET, NOW, BODY);

    expect(verifySignature(SECRET, header, `${BODY} tampered`, { nowSeconds: NOW })).toBe(
      false,
    );
  });

  it("fails under the wrong secret", () => {
    const header = signatureHeader(SECRET, NOW, BODY);

    expect(verifySignature("whsec_other", header, BODY, { nowSeconds: NOW })).toBe(false);
  });

  /**
   * The timestamp is signed together with the body, so a captured request
   * cannot be replayed tomorrow: its signature is only valid for the moment it
   * carries, and the receiver refuses anything outside the window.
   */
  it("refuses a captured request replayed later", () => {
    const header = signatureHeader(SECRET, NOW, BODY);

    expect(verifySignature(SECRET, header, BODY, { nowSeconds: NOW + 3600 })).toBe(false);
  });

  it("refuses a timestamp from the future", () => {
    const header = signatureHeader(SECRET, NOW + 3600, BODY);

    expect(verifySignature(SECRET, header, BODY, { nowSeconds: NOW })).toBe(false);
  });

  it("allows the delay of a slow network", () => {
    const header = signatureHeader(SECRET, NOW, BODY);

    expect(verifySignature(SECRET, header, BODY, { nowSeconds: NOW + 120 })).toBe(true);
  });

  /**
   * Without the separator, a body beginning with digits could be shifted into
   * the timestamp: two different (timestamp, body) pairs signing the same
   * string.
   */
  it("cannot be confused by a body that starts with digits", () => {
    const first = computeSignature(SECRET, 123, "45.body");
    const second = computeSignature(SECRET, 12345, ".body");

    expect(first).not.toBe(second);
  });

  it("generates a distinct secret every time, marked for a secret scanner", () => {
    const secrets = new Set(Array.from({ length: 50 }, generateWebhookSecret));

    expect(secrets.size).toBe(50);
    expect(generateWebhookSecret().startsWith("whsec_")).toBe(true);
  });
});

describe("parsing the header", () => {
  it("reads the timestamp and signature", () => {
    expect(parseSignatureHeader("t=123,v1=abc")).toEqual({
      timestamp: 123,
      signatures: ["abc"],
    });
  });

  /** Several signatures is how a secret is rotated without downtime. */
  it("accepts more than one signature", () => {
    expect(parseSignatureHeader("t=123,v1=abc,v1=def")?.signatures).toEqual([
      "abc",
      "def",
    ]);
  });

  it("is null for anything unusable", () => {
    expect(parseSignatureHeader("")).toBeNull();
    expect(parseSignatureHeader("v1=abc")).toBeNull();
    expect(parseSignatureHeader("t=123")).toBeNull();
    expect(parseSignatureHeader("t=abc,v1=def")).toBeNull();
  });
});

/**
 * A webhook URL is attacker-controlled input the server then fetches on its own
 * network. Unchecked, it is a request forger with a delivery log for output.
 */
describe("where a webhook may point", () => {
  it("accepts an ordinary public endpoint", () => {
    expect(checkOutboundUrl("https://example.test/hooks/atarimae")).toEqual({
      ok: true,
      url: "https://example.test/hooks/atarimae",
    });
  });

  it("refuses the cloud metadata service", () => {
    expect(checkOutboundUrl("http://169.254.169.254/latest/meta-data/")).toMatchObject({
      reason: "PRIVATE_ADDRESS",
    });
  });

  it("refuses loopback, however it is spelled", () => {
    for (const url of [
      "http://localhost:5432/",
      "http://127.0.0.1/",
      "http://127.1.2.3/",
      "http://[::1]/",
      // The same address in the form `new URL()` rewrites it to. Checking only
      // the dotted form let this straight through.
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:7f00:1]/",
      "http://[0:0:0:0:0:ffff:10.0.0.1]/",
      "http://anything.localhost/",
    ]) {
      expect(checkOutboundUrl(url), url).toMatchObject({ reason: "PRIVATE_ADDRESS" });
    }
  });

  it("refuses private ranges", () => {
    for (const url of [
      "http://10.0.0.5/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.1.1/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
    ]) {
      expect(checkOutboundUrl(url), url).toMatchObject({ reason: "PRIVATE_ADDRESS" });
    }
  });

  it("allows a public address that merely looks close to a private one", () => {
    expect(checkOutboundUrl("http://172.32.0.1/")).toMatchObject({ ok: true });
    expect(checkOutboundUrl("http://11.0.0.1/")).toMatchObject({ ok: true });
  });

  it("refuses a scheme that is not http", () => {
    expect(checkOutboundUrl("file:///etc/passwd")).toMatchObject({
      reason: "SCHEME_NOT_ALLOWED",
    });
    expect(checkOutboundUrl("gopher://example.test/")).toMatchObject({
      reason: "SCHEME_NOT_ALLOWED",
    });
  });

  /** Some clients forward these as an Authorization header. */
  it("refuses credentials embedded in the URL", () => {
    expect(checkOutboundUrl("https://user:pass@example.test/")).toMatchObject({
      reason: "CREDENTIALS_IN_URL",
    });
  });

  it("refuses something that is not a URL at all", () => {
    expect(checkOutboundUrl("not a url")).toMatchObject({ reason: "NOT_A_URL" });
  });
});
