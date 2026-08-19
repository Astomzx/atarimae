import { describe, expect, it } from "vitest";

import {
  decryptArgv,
  decryptWith,
  encryptArgv,
  encryptTo,
  ENCRYPTED_SUFFIX,
  EncryptionUnavailableError,
  isEncryptedPath,
  requireAge,
} from "./encryption.js";

/**
 * Encryption is delegated to `age`, so what is testable here is everything
 * except age itself: the command handed to it, and — far more importantly —
 * what happens when it is missing or fails.
 *
 * That second half is the point. The failure being designed against is writing
 * a *plaintext* archive when somebody asked for an encrypted one. A backup
 * that is not encrypted is recoverable; a backup somebody believes is
 * encrypted, sitting on a USB drive in a van, is not a mistake they find out
 * about in time.
 *
 * `age` is not installed on the machine this was written on, so `spawnSync` is
 * injected and the real binary is never invoked here. See
 * `docs/architecture/backup.md` for what that leaves unverified.
 */

/** Stands in for spawnSync, recording what age would have been asked to do. */
function fakeAge(
  behaviour: {
    version?: { status?: number; error?: Error };
    run?: { status?: number; stdout?: Buffer; stderr?: Buffer; error?: Error };
  } = {},
) {
  const calls: { args: string[]; input?: Buffer }[] = [];

  const run = ((_command: string, args: string[], options?: { input?: Buffer }) => {
    calls.push({ args, ...(options?.input ? { input: options.input } : {}) });

    if (args[0] === "--version") {
      return { status: behaviour.version?.status ?? 0, error: behaviour.version?.error };
    }

    return {
      status: behaviour.run?.status ?? 0,
      stdout: behaviour.run?.stdout ?? Buffer.from("age-ciphertext"),
      stderr: behaviour.run?.stderr ?? Buffer.alloc(0),
      error: behaviour.run?.error,
    };
  }) as unknown as typeof import("node:child_process").spawnSync;

  return { run, calls };
}

const PLAINTEXT = new TextEncoder().encode("an archive");
const RECIPIENT = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";

describe("the command handed to age", () => {
  /**
   * A public key is not a secret, so it may go on the command line where a
   * process list can see it. An identity file is different — hence a path,
   * never its contents.
   */
  it("names the recipient and writes to stdout", () => {
    expect(encryptArgv(RECIPIENT)).toEqual([
      "--encrypt",
      "--recipient",
      RECIPIENT,
      "--output",
      "-",
    ]);
  });

  it("decrypts with an identity file rather than a key value", () => {
    expect(decryptArgv("/home/op/.age/key.txt")).toEqual([
      "--decrypt",
      "--identity",
      "/home/op/.age/key.txt",
      "--output",
      "-",
    ]);
  });

  it("passes the archive on stdin", () => {
    const { run, calls } = fakeAge();
    encryptTo(PLAINTEXT, RECIPIENT, run);

    const encrypt = calls.find((call) => call.args[0] === "--encrypt");
    expect(encrypt?.input?.equals(Buffer.from(PLAINTEXT))).toBe(true);
  });
});

describe("when age is not there", () => {
  /**
   * The refusal that matters most. Falling back to writing the archive
   * unencrypted would hand somebody a file they believe is protected.
   */
  it("refuses rather than writing plaintext", () => {
    const { run } = fakeAge({ version: { error: new Error("ENOENT") } });

    expect(() => encryptTo(PLAINTEXT, RECIPIENT, run)).toThrow(
      EncryptionUnavailableError,
    );
  });

  it("says what to install, and what to do instead", () => {
    const { run } = fakeAge({ version: { error: new Error("ENOENT") } });

    try {
      requireAge(run);
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("age-encryption.org");
      expect(message).toContain("--encrypt-to");
    }
  });

  it("refuses an installation that answers but fails", () => {
    const { run } = fakeAge({ version: { status: 127 } });
    expect(() => requireAge(run)).toThrow(/exited 127/);
  });
});

describe("when age fails", () => {
  it("surfaces the exit status and its message", () => {
    const { run } = fakeAge({
      run: { status: 1, stderr: Buffer.from("age: no identity matched") },
    });

    expect(() => decryptWith(PLAINTEXT, "/tmp/key.txt", run)).toThrow(
      /no identity matched/,
    );
  });

  /** Wrong key is the common mistake, so the message names the cause. */
  it("explains a decryption failure in terms of the recipient", () => {
    const { run } = fakeAge({ run: { status: 1 } });

    expect(() => decryptWith(PLAINTEXT, "/tmp/key.txt", run)).toThrow(
      /encrypted to a recipient/,
    );
  });

  /**
   * Zero bytes with a status of zero. Writing that to disk produces an empty
   * file with a reassuring name, which is the quietest possible way to lose a
   * backup.
   */
  it("refuses empty output even when age claims success", () => {
    const { run } = fakeAge({ run: { status: 0, stdout: Buffer.alloc(0) } });

    expect(() => encryptTo(PLAINTEXT, RECIPIENT, run)).toThrow(/no output/);
  });
});

describe("recognising an encrypted archive", () => {
  /** Decided by the file, so a missing --identity is explained by name. */
  it("goes by the suffix age itself uses", () => {
    expect(ENCRYPTED_SUFFIX).toBe(".age");
    expect(isEncryptedPath("/backups/atarimae-2026-08-19.tar.gz.age")).toBe(true);
    expect(isEncryptedPath("/backups/ATARIMAE.TAR.GZ.AGE")).toBe(true);
    expect(isEncryptedPath("/backups/atarimae-2026-08-19.tar.gz")).toBe(false);
    expect(isEncryptedPath("/backups/age/atarimae.tar.gz")).toBe(false);
  });
});
