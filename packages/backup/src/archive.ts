/**
 * Assembling an archive, once, for both callers.
 *
 * `pnpm backup` and `POST /backup/export` must produce the same thing. Two
 * implementations of "what goes in a backup" is precisely the drift this
 * project spends its documentation warning about: the one nobody runs would
 * be the one missing a table, and it would be missing it silently.
 *
 * What is *not* here: where the bytes go, whether to encrypt them, and what to
 * do about an inconsistency. Those differ between a terminal and an HTTP
 * response — a CLI can offer `--allow-missing-attachments` and wait for an
 * answer; a request cannot.
 */

import { createTar } from "./tar.js";
import {
  DATABASE_NAME,
  FORMAT,
  FORMAT_VERSION,
  MANIFEST_NAME,
  ATTACHMENT_PREFIX,
  keyIdOf,
  sha256,
  type ArchivedFile,
  type Manifest,
} from "./manifest.js";
import { reconcile, type ReconcileResult } from "./reconcile.js";

export interface StoredFile {
  key: string;
  data: Uint8Array;
}

export interface ArchiveInput {
  /** Output of `pg_dump --format=plain`. */
  dump: Uint8Array;
  /** Every file under ATTACHMENT_ROOT, keyed as the database refers to it. */
  files: readonly StoredFile[];
  /** `storage_key` of every attachment row. */
  databaseKeys: readonly string[];
  postgresVersion: string;
  latestMigration: string;
  rowCounts: Record<string, number>;
  /** `<keyId>:<base64>`; only the id is recorded. */
  encryptionKeyCurrent: string | undefined;
  appVersion?: string;
  now?: Date;
}

export interface BuiltArchive {
  /** Uncompressed tar. The caller gzips, and may then encrypt. */
  tar: Uint8Array;
  manifest: Manifest;
  /** Whether the database and the files agree. Never decided here. */
  reconciliation: ReconcileResult;
}

/**
 * Builds the tar and the manifest that describes it.
 *
 * The reconciliation is computed and returned rather than enforced. Both
 * callers need to know; only they can decide what it means. The CLI refuses
 * unless told otherwise, because an operator can be asked; the HTTP export
 * refuses outright, because a request has nobody to ask.
 */
export function buildArchive(input: ArchiveInput): BuiltArchive {
  const reconciliation = reconcile({
    databaseKeys: input.databaseKeys,
    fileKeys: input.files.map((file) => file.key),
  });

  const attachmentFiles: ArchivedFile[] = input.files.map((file) => ({
    key: file.key,
    bytes: file.data.length,
    sha256: sha256(file.data),
  }));

  const manifest: Manifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    createdAt: (input.now ?? new Date()).toISOString(),
    appVersion: input.appVersion ?? "0.0.0",
    postgresVersion: input.postgresVersion,
    latestMigration: input.latestMigration,
    encryptionKeyId: keyIdOf(input.encryptionKeyCurrent),
    database: {
      key: DATABASE_NAME,
      bytes: input.dump.length,
      sha256: sha256(input.dump),
    },
    attachments: {
      count: attachmentFiles.length,
      totalBytes: attachmentFiles.reduce((sum, file) => sum + file.bytes, 0),
      files: attachmentFiles,
    },
    rowCounts: input.rowCounts,
  };

  const tar = createTar([
    {
      name: MANIFEST_NAME,
      data: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
    },
    { name: DATABASE_NAME, data: input.dump },
    ...input.files.map((file) => ({
      name: ATTACHMENT_PREFIX + file.key,
      data: file.data,
    })),
  ]);

  return { tar, manifest, reconciliation };
}
