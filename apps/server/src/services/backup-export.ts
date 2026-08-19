import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";

import { buildArchive, describeReconcile, type StoredFile } from "@atarimae/backup";
import type { FastifyInstance } from "fastify";

import { ApiError } from "../errors.js";
import { BackupErrorCode } from "@atarimae/api-schema";

/**
 * The same archive `pnpm backup` writes, built in-process for the HTTP export.
 *
 * The assembly itself lives in `@atarimae/backup` and is shared, deliberately:
 * two implementations of "what goes in a backup" would drift, and the one
 * nobody runs would be the one missing a table.
 *
 * What differs here is what an inconsistency means. The CLI can offer
 * `--allow-missing-attachments` and wait for somebody to decide. A request has
 * nobody to ask, so it refuses — an archive downloaded through a browser is
 * one nobody will inspect before trusting it.
 */

export interface ExportedArchive {
  bytes: Uint8Array;
  filename: string;
  attachmentCount: number;
}

/** Files first, then the dump — the order is load-bearing. See backup.md. */
function readAttachments(root: string): StoredFile[] {
  if (!existsSync(root)) return [];

  const files: StoredFile[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;

      files.push({
        // Forward slashes on every platform: the database refers to
        // `YYYY/MM/<uuid>`, and backslashes would restore to files no row can
        // find.
        key: relative(root, full).split(sep).join("/"),
        data: new Uint8Array(readFileSync(full)),
      });
    }
  };

  walk(root);
  files.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return files;
}

function pgDump(databaseUrl: string): Uint8Array {
  const result = spawnSync(
    "pg_dump",
    [databaseUrl, "--no-owner", "--no-privileges", "--format=plain", "--encoding=UTF8"],
    { maxBuffer: 1024 * 1024 * 1024, encoding: "buffer" },
  );

  if (result.error) {
    /*
     * The image installs postgresql-client-18 for exactly this. A deployment
     * without it must say so rather than returning an archive with no
     * database in it, which would look like a backup and restore to nothing.
     */
    throw new ApiError(
      503,
      BackupErrorCode.TOOLING_MISSING,
      "pg_dump is not available on this server, so a backup cannot be produced.",
    );
  }
  if (result.status !== 0 || !result.stdout || result.stdout.length === 0) {
    throw new ApiError(
      503,
      BackupErrorCode.DUMP_FAILED,
      "pg_dump did not produce a backup.",
    );
  }

  return new Uint8Array(result.stdout);
}

export async function buildExport(app: FastifyInstance): Promise<ExportedArchive> {
  const attachmentRoot = resolve(process.cwd(), app.config.ATTACHMENT_ROOT);

  const files = readAttachments(attachmentRoot);
  const dump = pgDump(app.config.DATABASE_URL);

  const version = await app.db.query<{ v: string }>(
    "SELECT current_setting('server_version') AS v",
  );

  const tables = await app.db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  const names = tables.rows.map((row) => row.table_name);

  const migration = await app.db.query<{ name: string }>(
    "SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1",
  );

  const keys = await app.db.query<{ storage_key: string }>(
    "SELECT storage_key FROM message_attachments",
  );

  const counts = await app.db.query<Record<string, string>>(
    names
      .map(
        (name, index) =>
          `SELECT '${name}' AS t, count(*)::text AS c FROM "${name.replace(/"/g, '""')}"` +
          (index === names.length - 1 ? "" : " UNION ALL"),
      )
      .join(" "),
  );

  const rowCounts: Record<string, number> = {};
  for (const row of counts.rows) rowCounts[String(row["t"])] = Number(row["c"]);

  const built = buildArchive({
    dump,
    files,
    databaseKeys: keys.rows.map((row) => row.storage_key),
    postgresVersion: version.rows[0]?.v ?? "unknown",
    latestMigration: migration.rows[0]?.name ?? "",
    rowCounts,
    encryptionKeyCurrent: app.config.ENCRYPTION_KEY_CURRENT,
  });

  /*
   * Refused rather than offered with a warning. The CLI can ask; this cannot,
   * and an archive downloaded through a browser is one nobody inspects before
   * trusting it. A backup that restores to broken downloads is the failure the
   * whole tool exists to prevent, and it must not be easier to obtain through
   * the convenient door.
   */
  if (!built.reconciliation.ok) {
    app.log.error(
      { missing: built.reconciliation.missing.length },
      "refusing HTTP backup export: attachment rows have no file",
    );
    throw new ApiError(
      409,
      BackupErrorCode.INCONSISTENT,
      "This system has attachment rows with no file on disk, so a backup " +
        "would preserve the breakage. Fix it, or take one from the command " +
        "line with --allow-missing-attachments.\n\n" +
        describeReconcile(built.reconciliation),
    );
  }

  const stamp = new Date().toISOString().slice(0, 10);

  return {
    bytes: gzipSync(built.tar),
    filename: `atarimae-${stamp}.tar.gz`,
    attachmentCount: built.manifest.attachments.count,
  };
}
