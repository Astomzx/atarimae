/**
 * Optional encryption of the archive, delegated to `age`.
 *
 * `backup.md` refused this once, and the reason still stands for the obvious
 * version of it: a passphrase or a generated key would be a *second* thing to
 * lose, alongside `ENCRYPTION_KEY_CURRENT`, and operators who lose one lose
 * both. Moving a problem is not solving it.
 *
 * So this is the narrow version, and the narrowness is the whole design:
 *
 *   **Atarimae never generates, stores, or sees a key.**
 *
 * You name a recipient you already manage — an age public key, or an SSH
 * public key you already use — and the archive is encrypted to it. Decryption
 * needs an identity file this project also never touches. Losing that key is
 * the same event as losing your SSH key, which is a risk operators already
 * understand and already have habits about.
 *
 * `age` rather than GPG: one binary, one flag, no keyring, no agent, and no
 * trust model to explain. If it is not installed, this refuses and says so
 * instead of quietly writing a plaintext archive somebody believes is
 * encrypted — which would be the worst outcome available here.
 */

import { spawnSync } from "node:child_process";

/** What an encrypted archive is called. `age`'s own convention. */
export const ENCRYPTED_SUFFIX = ".age";

export function isEncryptedPath(path: string): boolean {
  return path.toLowerCase().endsWith(ENCRYPTED_SUFFIX);
}

/**
 * The recipient goes on the command line, and that is a deliberate accepted
 * limit rather than an oversight: a *public* key is not a secret, so a process
 * list revealing it costs nothing. An identity file is different, which is why
 * that one is passed as a path and never as its contents.
 */
export function encryptArgv(recipient: string): string[] {
  return ["--encrypt", "--recipient", recipient, "--output", "-"];
}

export function decryptArgv(identityFile: string): string[] {
  return ["--decrypt", "--identity", identityFile, "--output", "-"];
}

/** Both halves of a plain-language refusal, so callers can format them. */
export class EncryptionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionUnavailableError";
  }
}

const NOT_INSTALLED =
  "`age` is not on PATH.\n\n" +
  "Atarimae does not encrypt the archive itself, deliberately: it would mean\n" +
  "holding a key it could lose, on top of the one you already have to keep.\n" +
  "It hands the file to age instead, encrypted to a recipient you manage.\n\n" +
  "  https://age-encryption.org\n\n" +
  "Or omit --encrypt-to and store the archive somewhere already protected.";

/**
 * Refuses rather than falling back.
 *
 * The failure being prevented is writing a plaintext archive when somebody
 * asked for an encrypted one. A backup that is not encrypted is recoverable;
 * a backup somebody *believes* is encrypted, sitting on a USB drive in a van,
 * is not a mistake they will find out about in time.
 */
export function requireAge(run = spawnSync): void {
  const probe = run("age", ["--version"], { encoding: "utf8" });

  if (probe.error) throw new EncryptionUnavailableError(NOT_INSTALLED);
  if (probe.status !== 0) {
    throw new EncryptionUnavailableError(
      `\`age --version\` exited ${String(probe.status)}. ` +
        `Check the installation before trusting it with a backup.`,
    );
  }
}

/** Encrypts bytes to a recipient, returning the ciphertext. */
export function encryptTo(
  plaintext: Uint8Array,
  recipient: string,
  run = spawnSync,
): Uint8Array {
  requireAge(run);

  const result = run("age", encryptArgv(recipient), {
    input: Buffer.from(plaintext),
    maxBuffer: 1024 * 1024 * 1024,
    encoding: "buffer",
  });

  if (result.error) {
    throw new EncryptionUnavailableError(`age could not be run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new EncryptionUnavailableError(
      `age exited ${String(result.status)}:\n\n${result.stderr?.toString() ?? ""}`,
    );
  }

  const out = result.stdout;
  if (!out || out.length === 0) {
    // Writing this to disk would produce an empty file with a reassuring name.
    throw new EncryptionUnavailableError("age produced no output. Refusing to write it.");
  }

  return new Uint8Array(out);
}

/** Decrypts with an identity file, returning the archive bytes. */
export function decryptWith(
  ciphertext: Uint8Array,
  identityFile: string,
  run = spawnSync,
): Uint8Array {
  requireAge(run);

  const result = run("age", decryptArgv(identityFile), {
    input: Buffer.from(ciphertext),
    maxBuffer: 1024 * 1024 * 1024,
    encoding: "buffer",
  });

  if (result.error) {
    throw new EncryptionUnavailableError(`age could not be run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new EncryptionUnavailableError(
      `Could not decrypt with ${identityFile} — age exited ` +
        `${String(result.status)}:\n\n${result.stderr?.toString() ?? ""}\n\n` +
        `This archive was encrypted to a recipient. Use the matching identity.`,
    );
  }

  const out = result.stdout;
  if (!out || out.length === 0) {
    throw new EncryptionUnavailableError("age decrypted to nothing.");
  }

  return new Uint8Array(out);
}
