import { describe, expect, it } from "vitest";

import { decodeVapidKey, encodeKey, isSupported, stateFrom } from "./push.js";

/**
 * The parts of enabling push that are worth testing without a browser: the key
 * encoding, and which of the five states a browser is in.
 *
 * Both are places where being wrong is quiet. A mis-decoded key produces a
 * subscription that looks fine and that the server can never encrypt to; a
 * mis-read permission shows somebody a button that cannot work, or hides one
 * that would have.
 */

describe("decodeVapidKey", () => {
  /**
   * Base64url in, bytes out. Browsers accept a plain string for
   * `applicationServerKey` in some versions and reject it in others, and the
   * alphabet differs from base64 — a `-` read as `+` gives a valid-looking key
   * for a different point on the curve.
   */
  it("decodes a real 65-byte P-256 key", () => {
    const bytes = new Uint8Array(65);
    bytes[0] = 0x04;
    for (let i = 1; i < 65; i += 1) bytes[i] = i;

    const base64url = Buffer.from(bytes).toString("base64url");
    const decoded = decodeVapidKey(base64url);

    expect(decoded.length).toBe(65);
    expect([...decoded]).toEqual([...bytes]);
  });

  /** base64url drops padding; atob requires it. */
  it("restores the padding base64url leaves out", () => {
    for (const length of [1, 2, 3, 4, 5, 64, 65]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 7) % 256);
      const decoded = decodeVapidKey(Buffer.from(bytes).toString("base64url"));
      expect([...decoded], `length ${length}`).toEqual([...bytes]);
    }
  });

  it("treats the base64url alphabet as base64url, not base64", () => {
    // 0xfb 0xff produces '-' and '_' in base64url and '+' and '/' in base64.
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf]);
    const base64url = Buffer.from(bytes).toString("base64url");

    expect(base64url).toMatch(/[-_]/);
    expect([...decodeVapidKey(base64url)]).toEqual([...bytes]);
  });
});

describe("encodeKey", () => {
  it("round trips with decodeVapidKey", () => {
    const bytes = new Uint8Array(16).map((_, i) => (i * 31) % 256);
    const encoded = encodeKey(bytes.buffer);

    expect([...decodeVapidKey(encoded)]).toEqual([...bytes]);
  });

  it("produces base64url, not base64", () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf]);
    const encoded = encodeKey(bytes.buffer);

    expect(encoded).not.toMatch(/[+/=]/);
  });

  /** `getKey` returns null when a subscription has no such key. */
  it("survives a missing key", () => {
    expect(encodeKey(null)).toBe("");
  });
});

describe("isSupported", () => {
  it("needs all three of service worker, PushManager and Notification", () => {
    expect(isSupported({ serviceWorker: {}, PushManager: {}, Notification: {} })).toBe(
      true,
    );
    expect(isSupported({ PushManager: {}, Notification: {} })).toBe(false);
    expect(isSupported({ serviceWorker: {}, Notification: {} })).toBe(false);
    expect(isSupported({ serviceWorker: {}, PushManager: {} })).toBe(false);
  });
});

describe("stateFrom", () => {
  const base = {
    supported: true,
    permission: "default" as NotificationPermission,
    hasServerKey: true,
    hasSubscription: false,
  };

  it("says unsupported before anything else", () => {
    expect(
      stateFrom({ ...base, supported: false, hasServerKey: false, permission: "denied" }),
    ).toEqual({ kind: "unsupported" });
  });

  /** No keypair on the server means the button could not work if pressed. */
  it("says unavailable when the server has no key", () => {
    expect(stateFrom({ ...base, hasServerKey: false })).toEqual({ kind: "unavailable" });
  });

  /**
   * The distinction that matters. A page cannot re-ask after a refusal — that
   * has to be undone in browser settings — so this is the one state where the
   * honest interface explains rather than offering a button.
   */
  it("distinguishes never asked from refused", () => {
    expect(stateFrom({ ...base, permission: "default" })).toEqual({ kind: "available" });
    expect(stateFrom({ ...base, permission: "denied" })).toEqual({ kind: "denied" });
  });

  it("is subscribed only with both permission and a subscription", () => {
    expect(stateFrom({ ...base, permission: "granted", hasSubscription: true })).toEqual({
      kind: "subscribed",
    });

    // Permission granted but the subscription was dropped — by the browser, or
    // by this device being signed out elsewhere. Offer it again.
    expect(stateFrom({ ...base, permission: "granted", hasSubscription: false })).toEqual(
      { kind: "available" },
    );
  });
});
