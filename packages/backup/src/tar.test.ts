import { describe, expect, it } from "vitest";

import { createTar, MAX_ENTRY_BYTES, readTar } from "./tar.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

describe("tar round trip", () => {
  it("returns what it was given", () => {
    const archive = createTar([
      { name: "manifest.json", data: bytes(`{"format":"atarimae-backup"}`) },
      { name: "database.sql", data: bytes("CREATE TABLE t ();") },
    ]);

    const entries = readTar(archive);

    expect(entries.map((entry) => entry.name)).toEqual(["manifest.json", "database.sql"]);
    expect(text(entries[1]!.data)).toBe("CREATE TABLE t ();");
  });

  /**
   * Attachments are arbitrary bytes, and the padding to a 512-byte boundary is
   * where an off-by-one shows up as a file that restores slightly longer than
   * it was.
   */
  it("preserves lengths that do not land on a block boundary", () => {
    for (const size of [1, 511, 512, 513, 1024, 1025]) {
      const data = new Uint8Array(size).map((_, index) => index % 256);
      const [entry] = readTar(createTar([{ name: "attachments/x", data }]));

      expect(entry!.data.length, `size ${size}`).toBe(size);
      expect([...entry!.data], `size ${size}`).toEqual([...data]);
    }
  });

  it("preserves bytes that are not text", () => {
    const data = new Uint8Array([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]);
    const [entry] = readTar(createTar([{ name: "attachments/2026/08/id", data }]));
    expect([...entry!.data]).toEqual([...data]);
  });

  it("keeps an empty archive readable", () => {
    expect(readTar(createTar([]))).toEqual([]);
  });

  it("carries the storage key shape attachments actually use", () => {
    const name = "attachments/2026/08/0192f0c1-2b3d-7e4f-8a9b-0c1d2e3f4a5b";
    const [entry] = readTar(createTar([{ name, data: bytes("x") }]));
    expect(entry!.name).toBe(name);
  });
});

describe("tar refuses what it cannot represent", () => {
  /**
   * The alternative is a silently truncated name, which restores the file to
   * the wrong place and reports success.
   */
  it("refuses a name too long for ustar rather than truncating it", () => {
    const name = "attachments/" + "a".repeat(200);
    expect(() => createTar([{ name, data: bytes("x") }])).toThrow(/ustar limit/);
  });

  it("refuses an empty name", () => {
    expect(() => createTar([{ name: "", data: bytes("x") }])).toThrow(/name is empty/);
  });

  it("states the ustar size ceiling it enforces", () => {
    expect(MAX_ENTRY_BYTES).toBe(0o77777777777);
  });
});

describe("tar detects damage", () => {
  /**
   * A backup truncated by a full disk is the failure this catches, and catching
   * it while reading the archive is the difference between an error and a
   * restored system that is quietly wrong.
   */
  it("refuses an archive whose header checksum does not match", () => {
    const archive = createTar([{ name: "database.sql", data: bytes("SELECT 1;") }]);
    // Corrupt a byte inside the name field.
    archive[3] = 0x58;

    expect(() => readTar(archive)).toThrow(/corrupt: header checksum mismatch/);
  });

  it("refuses an archive that ends inside a file", () => {
    const archive = createTar([{ name: "database.sql", data: new Uint8Array(2000) }]);
    expect(() => readTar(archive.slice(0, 1200))).toThrow(/truncated/);
  });

  /** Damage inside the data is caught by the manifest digests, not here. */
  it("reads an archive whose payload was altered without changing its length", () => {
    const archive = createTar([{ name: "database.sql", data: bytes("SELECT 1;") }]);
    archive[512] = 0x73;
    expect(() => readTar(archive)).not.toThrow();
  });
});
