import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createSecretStore, SecretStoreError } from "./secret-store.js";

const keyMaterial = () => randomBytes(32).toString("base64");

const KEY_01 = `key01:${keyMaterial()}`;
const KEY_02 = `key02:${keyMaterial()}`;

describe("createSecretStore", () => {
  it("round-trips a value", async () => {
    const store = createSecretStore({ current: KEY_01 });
    const encrypted = await store.encrypt("hunter2");

    expect(encrypted).not.toContain("hunter2");
    expect(await store.decrypt(encrypted)).toBe("hunter2");
  });

  it("round-trips non-ASCII plaintext", async () => {
    const store = createSecretStore({ current: KEY_01 });
    const secret = "パスワード🔐";

    expect(await store.decrypt(await store.encrypt(secret))).toBe(secret);
  });

  it("round-trips an empty string", async () => {
    const store = createSecretStore({ current: KEY_01 });

    expect(await store.decrypt(await store.encrypt(""))).toBe("");
  });

  it("produces different ciphertext for the same plaintext", async () => {
    const store = createSecretStore({ current: KEY_01 });

    // A fresh nonce per encryption. Without this, identical SMTP passwords
    // across two providers would be visibly identical in the database.
    expect(await store.encrypt("same")).not.toBe(await store.encrypt("same"));
  });

  it("tags ciphertext with the current key id", async () => {
    const store = createSecretStore({ current: KEY_02 });
    const encrypted = await store.encrypt("value");

    expect(encrypted.startsWith("enc:v1:key02:")).toBe(true);
    expect(store.currentKeyId()).toBe("key02");
  });

  it("recognises its own ciphertext", async () => {
    const store = createSecretStore({ current: KEY_01 });

    expect(store.isEncrypted(await store.encrypt("x"))).toBe(true);
    expect(store.isEncrypted("plaintext-password")).toBe(false);
  });
});

describe("key rotation", () => {
  it("decrypts values written under the previous key", async () => {
    const before = createSecretStore({ current: KEY_01 });
    const legacy = await before.encrypt("smtp-password");

    // Operator rotated: key02 is now current, key01 kept for reading.
    const after = createSecretStore({ current: KEY_02, previous: KEY_01 });

    expect(await after.decrypt(legacy)).toBe("smtp-password");
    expect((await after.encrypt("new")).startsWith("enc:v1:key02:")).toBe(true);
  });

  it("fails with an actionable message when the old key was dropped", async () => {
    const before = createSecretStore({ current: KEY_01 });
    const legacy = await before.encrypt("smtp-password");

    const after = createSecretStore({ current: KEY_02 });

    await expect(after.decrypt(legacy)).rejects.toThrow(/ENCRYPTION_KEY_PREVIOUS/);
  });

  it("rejects reusing a key id for different key material", () => {
    const conflicting = `key01:${keyMaterial()}`;

    expect(() => createSecretStore({ current: KEY_01, previous: conflicting })).toThrow(
      /fresh id/,
    );
  });

  it("treats an empty previous key as absent", () => {
    expect(() => createSecretStore({ current: KEY_01, previous: "" })).not.toThrow();
    expect(() => createSecretStore({ current: KEY_01, previous: "   " })).not.toThrow();
  });
});

describe("tamper detection", () => {
  it("rejects modified ciphertext", async () => {
    const store = createSecretStore({ current: KEY_01 });
    const encrypted = await store.encrypt("original");

    const parts = encrypted.split(":");
    const body = Buffer.from(parts[4]!, "base64url");
    body[0] = (body[0] ?? 0) ^ 0xff;
    parts[4] = body.toString("base64url");

    await expect(store.decrypt(parts.join(":"))).rejects.toThrow(SecretStoreError);
  });

  it("rejects a swapped auth tag", async () => {
    const store = createSecretStore({ current: KEY_01 });
    const a = (await store.encrypt("a")).split(":");
    const b = (await store.encrypt("b")).split(":");

    a[5] = b[5]!;

    await expect(store.decrypt(a.join(":"))).rejects.toThrow(SecretStoreError);
  });

  it("rejects ciphertext from an unrelated key", async () => {
    const foreign = createSecretStore({ current: `key01:${keyMaterial()}` });
    const store = createSecretStore({ current: KEY_01 });

    await expect(store.decrypt(await foreign.encrypt("secret"))).rejects.toThrow(
      /wrong or the stored ciphertext was modified/,
    );
  });
});

describe("malformed input", () => {
  const store = () => createSecretStore({ current: KEY_01 });

  it.each([
    ["too few parts", "enc:v1:key01:aaa"],
    ["wrong prefix", "xxx:v1:key01:aaa:bbb:ccc"],
    ["unknown version", "enc:v9:key01:aaa:bbb:ccc"],
  ])("rejects %s", async (_label, value) => {
    await expect(store().decrypt(value)).rejects.toThrow(SecretStoreError);
  });

  it("rejects a plaintext value passed to decrypt", async () => {
    await expect(store().decrypt("just-a-password")).rejects.toThrow(SecretStoreError);
  });
});

describe("key configuration", () => {
  it("rejects a key without an id prefix", () => {
    expect(() => createSecretStore({ current: keyMaterial() })).toThrow(
      /<keyId>:<base64 key>/,
    );
  });

  it("rejects a key that is not 32 bytes", () => {
    const short = randomBytes(16).toString("base64");

    expect(() => createSecretStore({ current: `key01:${short}` })).toThrow(/32 bytes/);
  });

  it("rejects an invalid key id", () => {
    expect(() => createSecretStore({ current: `KEY 01:${keyMaterial()}` })).toThrow(
      /invalid key id/,
    );
  });
});
