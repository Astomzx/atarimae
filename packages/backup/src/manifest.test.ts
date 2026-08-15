import { describe, expect, it } from "vitest";

import {
  BackupFormatError,
  FORMAT,
  FORMAT_VERSION,
  keyIdOf,
  parseManifest,
  sha256,
  verifyDigests,
  type ArchivedFile,
  type Manifest,
} from "./manifest.js";

const bytes = (text: string) => new TextEncoder().encode(text);

function validManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    createdAt: "2026-08-16T00:00:00.000Z",
    appVersion: "0.0.0",
    postgresVersion: "18.4",
    latestMigration: "20260809072729_call-providers.sql",
    encryptionKeyId: "key01",
    database: { key: "database.sql", bytes: 9, sha256: sha256(bytes("SELECT 1;")) },
    attachments: { count: 0, totalBytes: 0, files: [] },
    rowCounts: { users: 3 },
    ...overrides,
  };
}

describe("parseManifest", () => {
  it("accepts what this version writes", () => {
    const manifest = parseManifest(JSON.stringify(validManifest()));
    expect(manifest.latestMigration).toBe("20260809072729_call-providers.sql");
  });

  it("refuses something that is not an Atarimae backup", () => {
    const foreign = JSON.stringify({ format: "some-other-tool", formatVersion: 1 });
    expect(() => parseManifest(foreign)).toThrow(/not an Atarimae backup/);
  });

  /**
   * A newer archive read by an older restore is the case that must not
   * half-succeed: guessing at a format produces a system that is partly
   * restored and reports success.
   */
  it("refuses a format version it does not understand", () => {
    const newer = JSON.stringify(validManifest({ formatVersion: FORMAT_VERSION + 1 }));
    expect(() => parseManifest(newer)).toThrow(/cannot be read by this version/);
  });

  it("refuses a manifest with no database dump described", () => {
    const partial = JSON.stringify({ format: FORMAT, formatVersion: FORMAT_VERSION });
    expect(() => parseManifest(partial)).toThrow(BackupFormatError);
  });

  it("refuses a manifest that is not JSON", () => {
    expect(() => parseManifest("this is not json")).toThrow(/not valid JSON/);
  });
});

describe("keyIdOf", () => {
  /**
   * The archive records which key its ciphertext was written under and never
   * the key. An archive holding both is one file equivalent to the plaintext.
   */
  it("takes the id and leaves the key behind", () => {
    expect(keyIdOf("key01:c2VjcmV0LWtleS1tYXRlcmlhbA==")).toBe("key01");
  });

  it("does not fail a backup over an oddly formatted key", () => {
    expect(keyIdOf("nocolon")).toBeNull();
    expect(keyIdOf(":leading")).toBeNull();
    expect(keyIdOf(undefined)).toBeNull();
  });
});

describe("verifyDigests", () => {
  const content = bytes("attachment bytes");
  const file: ArchivedFile = {
    key: "2026/08/a",
    bytes: content.length,
    sha256: sha256(content),
  };

  it("passes when the archive holds what the manifest promised", () => {
    const actual = new Map([["2026/08/a", content]]);
    expect(verifyDigests([file], actual)).toEqual([]);
  });

  it("reports a file the manifest lists and the archive does not hold", () => {
    const [problem] = verifyDigests([file], new Map());
    expect(problem?.reason).toBe("absent");
    expect(problem?.key).toBe("2026/08/a");
  });

  /**
   * Truncation is the common failure — a disk that filled up mid-write — and
   * two byte counts explain it where two hashes do not.
   */
  it("reports a truncated file as a size problem, with both lengths", () => {
    const actual = new Map([["2026/08/a", content.slice(0, 4)]]);
    const [problem] = verifyDigests([file], actual);

    expect(problem?.reason).toBe("size");
    expect(problem?.expected).toBe("16 bytes");
    expect(problem?.found).toBe("4 bytes");
  });

  it("reports altered content of the right length as a digest problem", () => {
    const altered = bytes("attachment bytez");
    const [problem] = verifyDigests([file], new Map([["2026/08/a", altered]]));

    expect(problem?.reason).toBe("digest");
    expect(problem?.found).toBe(sha256(altered));
  });

  it("checks every file rather than stopping at the first problem", () => {
    const second: ArchivedFile = { key: "2026/08/b", bytes: 1, sha256: "0".repeat(64) };
    expect(verifyDigests([file, second], new Map())).toHaveLength(2);
  });
});
