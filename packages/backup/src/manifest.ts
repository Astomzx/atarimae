/**
 * What the archive says about itself, and how that claim is checked.
 *
 * The manifest exists so a restore can fail *before* it touches anything. Every
 * check here — the format, the digests, the key id, the schema version — is a
 * question that is cheap to ask while the archive is still a file on disk and
 * expensive to ask after it has been written over a running system.
 *
 * What is deliberately not in here: the encryption key. `ENCRYPTION_KEY_CURRENT`
 * decrypts the stored SMTP password, and an archive holding both the ciphertext
 * and the key protects nothing at all — it is one file that is equivalent to
 * the plaintext. Only the key *id* is recorded, which is enough to tell somebody
 * their restore will not be able to read its own secrets, and not enough to
 * read them.
 */

import { createHash } from "node:crypto";

export const FORMAT = "atarimae-backup";

/**
 * Bumped only when an older restore could get an archive wrong rather than
 * merely miss something. A restore refuses a version it does not know, because
 * the alternative is a partial restore of a format it is guessing at.
 */
export const FORMAT_VERSION = 1;

export const MANIFEST_NAME = "manifest.json";
export const DATABASE_NAME = "database.sql";
export const ATTACHMENT_PREFIX = "attachments/";

export interface ArchivedFile {
  /** Storage key for attachments; the entry name for everything else. */
  key: string;
  bytes: number;
  sha256: string;
}

export interface Manifest {
  format: typeof FORMAT;
  formatVersion: number;
  createdAt: string;
  /** Server version the archive was taken from, for the record. */
  appVersion: string;
  postgresVersion: string;
  /** Filename of the newest applied migration. A restore compares it. */
  latestMigration: string;
  /**
   * Key id from ENCRYPTION_KEY_CURRENT. Never the key itself.
   * Absent only if the source had no key configured, which cannot happen for a
   * server that started.
   */
  encryptionKeyId: string | null;
  database: ArchivedFile;
  attachments: {
    count: number;
    totalBytes: number;
    files: ArchivedFile[];
  };
  /** Row counts, so "the restore is missing half the users" is answerable. */
  rowCounts: Record<string, number>;
}

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * `<keyId>:<base64>` in, key id out. Anything else yields null rather than
 * throwing: failing a backup because the key is oddly formatted would refuse to
 * protect the data over a detail that only matters on the way back in.
 */
export function keyIdOf(encryptionKeyCurrent: string | undefined): string | null {
  if (!encryptionKeyCurrent) return null;
  const colon = encryptionKeyCurrent.indexOf(":");
  if (colon <= 0) return null;
  return encryptionKeyCurrent.slice(0, colon);
}

export class BackupFormatError extends Error {}

/**
 * Parses and validates a manifest read out of an archive.
 *
 * Hand-checked rather than schema-validated on purpose. Reading an archive is
 * the one thing that has to work when the rest of the system does not, so
 * everything between here and a verified archive uses the Node standard library
 * and nothing else — not TypeBox, and not the project's own schema package.
 * Only the command that talks to PostgreSQL needs a dependency.
 */
export function parseManifest(raw: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BackupFormatError(`${MANIFEST_NAME} is not valid JSON.`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new BackupFormatError(`${MANIFEST_NAME} is not an object.`);
  }

  const manifest = parsed as Partial<Manifest>;

  if (manifest.format !== FORMAT) {
    throw new BackupFormatError(
      `This is not an Atarimae backup (format is ${JSON.stringify(manifest.format)}).`,
    );
  }

  if (manifest.formatVersion !== FORMAT_VERSION) {
    throw new BackupFormatError(
      `Backup format version ${String(manifest.formatVersion)} cannot be read by ` +
        `this version, which understands ${FORMAT_VERSION}. Restore it with the ` +
        `version of Atarimae that wrote it.`,
    );
  }

  if (!manifest.database || typeof manifest.database.sha256 !== "string") {
    throw new BackupFormatError(`${MANIFEST_NAME} does not describe a database dump.`);
  }

  if (!manifest.attachments || !Array.isArray(manifest.attachments.files)) {
    throw new BackupFormatError(`${MANIFEST_NAME} does not describe its attachments.`);
  }

  return manifest as Manifest;
}

export interface DigestProblem {
  key: string;
  reason: "absent" | "size" | "digest";
  expected: string;
  found: string;
}

/**
 * Checks archive contents against what the manifest promised.
 *
 * Both size and digest are compared, and the size is reported separately even
 * though a digest mismatch would also catch it. Truncation is the common
 * failure — a disk that filled up mid-write — and "expected 4096 bytes, found
 * 1200" tells an operator what happened, where two different hashes do not.
 */
export function verifyDigests(
  expected: readonly ArchivedFile[],
  actual: ReadonlyMap<string, Uint8Array>,
): DigestProblem[] {
  const problems: DigestProblem[] = [];

  for (const file of expected) {
    const data = actual.get(file.key);

    if (data === undefined) {
      problems.push({
        key: file.key,
        reason: "absent",
        expected: `${file.bytes} bytes`,
        found: "not in the archive",
      });
      continue;
    }

    if (data.length !== file.bytes) {
      problems.push({
        key: file.key,
        reason: "size",
        expected: `${file.bytes} bytes`,
        found: `${data.length} bytes`,
      });
      continue;
    }

    const digest = sha256(data);
    if (digest !== file.sha256) {
      problems.push({
        key: file.key,
        reason: "digest",
        expected: file.sha256,
        found: digest,
      });
    }
  }

  return problems;
}
