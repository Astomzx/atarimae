import { hash, verify } from "@node-rs/argon2";

/**
 * Argon2id password hashing.
 *
 * OWASP recommends Argon2id over fast hashes and over anything reversible.
 * The parameters below are the OWASP baseline: 19 MiB of memory, two
 * iterations, one degree of parallelism. Memory cost is what makes GPU attacks
 * expensive, so it is the last parameter to reduce if this ever needs tuning.
 *
 * The salt is generated per hash by the library and stored inside the encoded
 * output, so no separate salt column is needed.
 */
const OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, OPTIONS);
}

/**
 * Returns false rather than throwing on a malformed stored hash. A corrupted
 * row must read as "wrong password", never as a 500 that tells an attacker the
 * account exists.
 */
export async function verifyPassword(
  storedHash: string,
  plaintext: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, OPTIONS);
  } catch {
    return false;
  }
}

/**
 * Argon2 verification against a throwaway hash, used when no account matched.
 *
 * Without this, an unknown address returns in about a millisecond while a real
 * one takes the full hashing time, and that difference alone enumerates valid
 * accounts.
 */
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$0f3jVQ0Nn6VYQ0Uu9RQ1sB1cZqK1cQ0h9v9K0Q3nZ0M";

export async function burnVerificationTime(plaintext: string): Promise<void> {
  await verifyPassword(DUMMY_HASH, plaintext);
}
