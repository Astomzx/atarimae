import { createHash, randomBytes } from "node:crypto";

/**
 * API tokens.
 *
 * Hashed, never encrypted — the same rule as session tokens and for the same
 * reason. The server only ever compares a token, never presents one to
 * anybody, so storing something decryptable would be keeping a copy of every
 * live credential for no purpose. Encryption is reserved for secrets Atarimae
 * has to replay elsewhere, like an SMTP password.
 *
 * SHA-256 rather than Argon2, also as with sessions: the secret is 256 bits
 * from a CSPRNG. There is nothing to brute force, and a deliberately slow hash
 * on every API request would be a self-inflicted rate limit.
 */

/**
 * `atk_` marks these in a log or a leaked file at a glance, which is what
 * makes automated secret scanning possible at all.
 */
export const TOKEN_PREFIX = "atk_";

/** Enough of the token to recognise it in a list. Not enough to use it. */
const VISIBLE_HEAD_LENGTH = 6;

export interface GeneratedToken {
  /** Shown once, then unrecoverable. */
  plaintext: string;
  hash: string;
  /** e.g. `atk_7Fh2Kq`, stored and displayed so a token can be identified. */
  prefix: string;
}

export function generateApiToken(): GeneratedToken {
  // base64url: no padding, and safe in a header, a URL and a shell argument
  // without anybody having to think about quoting.
  const secret = randomBytes(32).toString("base64url");
  const plaintext = `${TOKEN_PREFIX}${secret}`;

  return {
    plaintext,
    hash: hashApiToken(plaintext),
    prefix: `${TOKEN_PREFIX}${secret.slice(0, VISIBLE_HEAD_LENGTH)}`,
  };
}

export function hashApiToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("base64url");
}

/**
 * Pulls the token out of an `Authorization` header.
 *
 * Returns null for anything that is not a Bearer token carrying our prefix.
 * Being strict here means a Basic header, or a session cookie value pasted
 * into the wrong place, never reaches the database as a hash lookup.
 */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;

  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const token = match?.[1];
  if (!token) return null;

  if (!token.startsWith(TOKEN_PREFIX)) return null;
  // Prefix plus 32 bytes of base64url. A shorter string cannot be one of ours.
  if (token.length < TOKEN_PREFIX.length + 40) return null;

  return token;
}
