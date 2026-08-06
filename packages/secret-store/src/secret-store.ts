import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Reversible encryption for credentials Atarimae must present to *other*
 * systems: SMTP passwords, call provider API secrets, integration client
 * secrets.
 *
 * This is deliberately NOT for:
 *   - user passwords        -> Argon2id hash
 *   - Atarimae API tokens   -> SHA-256 hash of the token
 *   - session tokens        -> SHA-256 hash
 *
 * If the plaintext never needs to leave the server, hash it instead. Encryption
 * is strictly for the cases where we have to replay the original value.
 *
 * Ciphertext format:
 *
 *   enc:v1:<keyId>:<nonce>:<ciphertext>:<authTag>
 *
 * Every component after the version is base64url. The key id travels with the
 * ciphertext so rotation never requires a migration: rows written under the old
 * key stay readable while new writes use the current key.
 */

const PREFIX = "enc";
const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_ID_PATTERN = /^[a-z0-9_-]{1,32}$/;

export class SecretStoreError extends Error {
  override readonly name = "SecretStoreError";
}

export interface SecretStore {
  /** Encrypts with the current key. */
  encrypt(plaintext: string): Promise<string>;
  /** Decrypts with whichever configured key matches the embedded key id. */
  decrypt(encrypted: string): Promise<string>;
  /** True when the value looks like output of this store. */
  isEncrypted(value: string): boolean;
  /** Key id new ciphertext is written under — surfaced for rotation tooling. */
  currentKeyId(): string;
}

export interface SecretStoreConfig {
  /** `<keyId>:<base64 32 bytes>`, e.g. from ENCRYPTION_KEY_CURRENT. */
  current: string;
  /** Optional previous key, kept readable during rotation. */
  previous?: string | undefined;
}

interface ParsedKey {
  id: string;
  key: Buffer;
}

/**
 * Parses `<keyId>:<base64>` into a usable key.
 *
 * The key id prefix is what makes rotation possible: without it, decrypting a
 * value would mean trying every key and hoping the GCM tag rejects the wrong
 * ones — which works, but silently turns a config mistake into a decrypt
 * failure that is impossible to diagnose.
 */
function parseKey(raw: string, label: string): ParsedKey {
  const separator = raw.indexOf(":");
  if (separator === -1) {
    throw new SecretStoreError(
      `${label} must be formatted as <keyId>:<base64 key>, for example "key01:AAAA...".`,
    );
  }

  const id = raw.slice(0, separator);
  const encoded = raw.slice(separator + 1);

  if (!KEY_ID_PATTERN.test(id)) {
    throw new SecretStoreError(
      `${label} has an invalid key id "${id}". Use 1-32 characters of [a-z0-9_-].`,
    );
  }

  let key: Buffer;
  try {
    key = Buffer.from(encoded, "base64");
  } catch {
    throw new SecretStoreError(`${label} key material is not valid base64.`);
  }

  if (key.length !== KEY_BYTES) {
    throw new SecretStoreError(
      `${label} must decode to exactly ${KEY_BYTES} bytes, got ${key.length}. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }

  return { id, key };
}

export function createSecretStore(config: SecretStoreConfig): SecretStore {
  const current = parseKey(config.current, "ENCRYPTION_KEY_CURRENT");

  const previous =
    config.previous && config.previous.trim() !== ""
      ? parseKey(config.previous, "ENCRYPTION_KEY_PREVIOUS")
      : undefined;

  if (previous && previous.id === current.id) {
    // Same id, different material would make ciphertext undecryptable in a way
    // that only shows up for rows written before the swap.
    const sameKey =
      previous.key.length === current.key.length &&
      timingSafeEqual(previous.key, current.key);
    if (!sameKey) {
      throw new SecretStoreError(
        `ENCRYPTION_KEY_PREVIOUS reuses key id "${current.id}" with different key ` +
          `material. Give the new key a fresh id (key02, key03, ...).`,
      );
    }
  }

  const keysById = new Map<string, Buffer>();
  keysById.set(current.id, current.key);
  if (previous) keysById.set(previous.id, previous.key);

  return {
    currentKeyId() {
      return current.id;
    },

    isEncrypted(value: string) {
      return value.startsWith(`${PREFIX}:${VERSION}:`);
    },

    // Both are `async` so that every failure surfaces as a rejected promise.
    // A synchronous throw from a Promise-returning method would slip past
    // `.catch()` at the call site.
    // eslint-disable-next-line @typescript-eslint/require-await
    async encrypt(plaintext: string) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, current.key, nonce);

      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();

      return [
        PREFIX,
        VERSION,
        current.id,
        nonce.toString("base64url"),
        ciphertext.toString("base64url"),
        authTag.toString("base64url"),
      ].join(":");
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async decrypt(encrypted: string) {
      const parts = encrypted.split(":");
      if (parts.length !== 6) {
        throw new SecretStoreError(
          `Malformed ciphertext: expected 6 colon-separated parts, got ${parts.length}.`,
        );
      }

      const [prefix, version, keyId, nonceB64, ciphertextB64, authTagB64] = parts as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];

      if (prefix !== PREFIX) {
        throw new SecretStoreError(`Malformed ciphertext: expected "${PREFIX}" prefix.`);
      }
      if (version !== VERSION) {
        throw new SecretStoreError(
          `Unsupported ciphertext version "${version}". This build understands ${VERSION}.`,
        );
      }

      const key = keysById.get(keyId);
      if (!key) {
        throw new SecretStoreError(
          `No key configured for key id "${keyId}". If this value was written ` +
            `under an older key, set ENCRYPTION_KEY_PREVIOUS to it.`,
        );
      }

      const nonce = Buffer.from(nonceB64, "base64url");
      const ciphertext = Buffer.from(ciphertextB64, "base64url");
      const authTag = Buffer.from(authTagB64, "base64url");

      if (nonce.length !== NONCE_BYTES) {
        throw new SecretStoreError(
          `Malformed ciphertext: nonce must be ${NONCE_BYTES} bytes.`,
        );
      }
      if (authTag.length !== AUTH_TAG_BYTES) {
        throw new SecretStoreError(
          `Malformed ciphertext: auth tag must be ${AUTH_TAG_BYTES} bytes.`,
        );
      }

      const decipher = createDecipheriv(ALGORITHM, key, nonce);
      decipher.setAuthTag(authTag);

      try {
        return decipher.update(ciphertext, undefined, "utf8") + decipher.final("utf8");
      } catch {
        // GCM authentication failed: wrong key, or the stored value was altered.
        throw new SecretStoreError(
          `Failed to decrypt value written under key id "${keyId}". The key is ` +
            `wrong or the stored ciphertext was modified.`,
        );
      }
    },
  };
}
