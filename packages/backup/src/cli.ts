#!/usr/bin/env node
/**
 * Backup, verify and restore.
 *
 *   pnpm backup [--out <file>]      write a verified archive
 *   pnpm backup:verify <file>       check an archive without touching anything
 *   pnpm restore <file> [--force]   put one back
 *
 * The archive is a gzipped tar holding a manifest, a plain-SQL dump and every
 * attachment. Deliberately one file: two things that must be copied together
 * are two things somebody will eventually copy separately.
 *
 * What is deliberately *not* in it: ENCRYPTION_KEY_CURRENT. See manifest.ts.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import pg from "pg";

import {
  ATTACHMENT_PREFIX,
  DATABASE_NAME,
  FORMAT,
  FORMAT_VERSION,
  MANIFEST_NAME,
  keyIdOf,
  parseManifest,
  sha256,
  verifyDigests,
  type ArchivedFile,
  type Manifest,
} from "./manifest.js";
import { describeReconcile, reconcile } from "./reconcile.js";
import { createTar, readTar } from "./tar.js";

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function say(message = ""): void {
  process.stdout.write(`${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`\n${message}\n\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Loads .env when there is one, and otherwise trusts the ambient environment —
 * the same rule as scripts/db.mjs, and for the same reason: a container has no
 * .env file, and `docker compose exec app` is the documented way to run this.
 */
function loadEnv(root: string): void {
  const envPath = join(root, ".env");
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
    return;
  }
  if (process.env["DATABASE_URL"]) return;

  fail(
    "No .env file, and DATABASE_URL is not set.\n\n" +
      "  node scripts/setup-env.mjs\n\n" +
      "Then check DATABASE_URL points at your PostgreSQL.",
  );
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) fail(`${name} is not set.`);
  return value;
}

// ---------------------------------------------------------------------------
// pg_dump / psql
// ---------------------------------------------------------------------------

/**
 * Both tools must be present and must not be older than the server.
 *
 * A pg_dump older than its server refuses outright, which is a good error. The
 * bad one is the reverse case people hit in Docker: no client tools in the
 * image at all, `spawnSync` sets `error` rather than a non-zero status, and a
 * naive check reads status 0 and reports a successful backup of nothing.
 */
function requireClientTool(tool: string): void {
  const probe = spawnSync(tool, ["--version"], { encoding: "utf8" });

  if (probe.error) {
    fail(
      `${tool} is not on PATH.\n\n` +
        `The backup command shells out to PostgreSQL's own client tools rather\n` +
        `than reimplementing them. Install postgresql-client 18 or newer.`,
    );
  }
  if (probe.status !== 0) {
    fail(`${tool} --version exited ${String(probe.status)}: ${probe.stderr ?? ""}`);
  }
}

function pgDump(databaseUrl: string): Uint8Array {
  const result = spawnSync(
    "pg_dump",
    [
      databaseUrl,
      // The restore target may be owned by a different role than the source,
      // which is the ordinary case when restoring onto a new machine.
      "--no-owner",
      "--no-privileges",
      "--format=plain",
      // Refuse rather than emit a dump that a restore would silently mangle.
      "--encoding=UTF8",
    ],
    { maxBuffer: 1024 * 1024 * 1024, encoding: "buffer" },
  );

  if (result.error) fail(`pg_dump could not be run: ${result.error.message}`);
  if (result.status !== 0) {
    fail(
      `pg_dump exited ${String(result.status)}:\n\n${result.stderr?.toString() ?? ""}`,
    );
  }

  const dump = result.stdout;
  if (!dump || dump.length === 0) {
    fail("pg_dump produced an empty dump. Refusing to write a backup of nothing.");
  }

  return new Uint8Array(dump);
}

function psql(databaseUrl: string, sql: string, label: string): void {
  const result = spawnSync(
    "psql",
    [
      databaseUrl,
      "--quiet",
      // Without this psql reports success for a script whose statements failed,
      // which would restore half a database and print nothing.
      "--set=ON_ERROR_STOP=1",
      "--no-psqlrc",
      "--file=-",
    ],
    { input: sql, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 },
  );

  if (result.error) fail(`psql could not be run: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${label} failed — psql exited ${String(result.status)}:\n\n${result.stderr}`);
  }
}

// ---------------------------------------------------------------------------
// The database side
// ---------------------------------------------------------------------------

interface DatabaseFacts {
  postgresVersion: string;
  latestMigration: string;
  storageKeys: string[];
  rowCounts: Record<string, number>;
  tableCount: number;
}

/**
 * Every table is counted, rather than a hand-written list of the interesting
 * ones.
 *
 * A list has to be maintained, and the failure when it is not is silent in the
 * worst direction: a table added in a later milestone is simply not compared,
 * so a restore that loses all of it passes every check. Asking the catalogue
 * costs one more query and cannot go stale.
 */
async function readDatabase(databaseUrl: string): Promise<DatabaseFacts> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    // current_setting, not SHOW: SHOW names its own output column and cannot
    // be aliased, which quietly yields undefined and a manifest that records
    // the server version as "unknown".
    const version = await client.query<{ v: string }>(
      "SELECT current_setting('server_version') AS v",
    );

    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );

    const names = tables.rows.map((row) => row.table_name);

    if (names.length === 0) {
      return {
        postgresVersion: version.rows[0]?.v ?? "unknown",
        latestMigration: "",
        storageKeys: [],
        rowCounts: {},
        tableCount: 0,
      };
    }

    const migration = await client.query<{ name: string }>(
      "SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1",
    );

    const keys = await client.query<{ storage_key: string }>(
      "SELECT storage_key FROM message_attachments",
    );

    /*
     * One statement rather than one per table, and the identifiers come from
     * the catalogue rather than from anything a person typed — but they are
     * still quoted, because "a name from the database is safe" is the
     * assumption that makes the one table someday named in mixed case a syntax
     * error at three in the morning.
     */
    const counts = await client.query<Record<string, string>>(
      names
        .map(
          (name, index) =>
            `SELECT '${name}' AS t, count(*)::text AS c FROM "${name.replace(/"/g, '""')}"` +
            (index === names.length - 1 ? "" : " UNION ALL"),
        )
        .join(" "),
    );

    const rowCounts: Record<string, number> = {};
    for (const row of counts.rows) {
      rowCounts[String(row["t"])] = Number(row["c"]);
    }

    return {
      postgresVersion: version.rows[0]?.v ?? "unknown",
      latestMigration: migration.rows[0]?.name ?? "",
      storageKeys: keys.rows.map((row) => row.storage_key),
      rowCounts,
      tableCount: names.length,
    };
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// The file side
// ---------------------------------------------------------------------------

interface StoredFile {
  key: string;
  data: Uint8Array;
}

/**
 * Every file under ATTACHMENT_ROOT, keyed the way the database refers to it.
 *
 * Keys are joined with forward slashes regardless of platform: `storageKeyFor`
 * produces `YYYY/MM/<uuid>`, and an archive written on Windows whose keys
 * contain backslashes would restore on Linux to files no row can find.
 */
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
        key: relative(root, full).split(sep).join("/"),
        data: new Uint8Array(readFileSync(full)),
      });
    }
  };

  walk(root);
  files.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return files;
}

// ---------------------------------------------------------------------------
// backup
// ---------------------------------------------------------------------------

function defaultOutputName(): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `atarimae-${stamp}.tar.gz`;
}

async function backup(argv: string[], root: string): Promise<void> {
  const databaseUrl = required("DATABASE_URL");
  const attachmentRoot = resolve(
    root,
    process.env["ATTACHMENT_ROOT"] ?? "./var/attachments",
  );
  const allowMissing = argv.includes("--allow-missing-attachments");

  const outIndex = argv.indexOf("--out");
  const out = resolve(
    outIndex === -1 ? defaultOutputName() : (argv[outIndex + 1] ?? defaultOutputName()),
  );

  requireClientTool("pg_dump");

  say("Atarimae backup");
  say();

  /*
   * Files first, database second, and the order is load-bearing.
   *
   * The attachment sweep deletes the row before the file. Copying files first
   * means a sweep that runs during a backup can only produce a file whose row
   * is gone by the time the dump is taken — a wasted block. Dumping first would
   * produce a row whose file is gone: a download that is broken forever.
   */
  say(`  reading attachments from ${attachmentRoot}`);
  const files = readAttachments(attachmentRoot);
  say(`  ${files.length} file(s)`);

  say("  dumping the database");
  const dump = pgDump(databaseUrl);
  const facts = await readDatabase(databaseUrl);

  if (facts.tableCount === 0) {
    fail(
      "This database has no tables. There is nothing to back up.\n\n" +
        "  node scripts/db.mjs status",
    );
  }

  say();
  const result = reconcile({
    databaseKeys: facts.storageKeys,
    fileKeys: files.map((file) => file.key),
  });
  say(describeReconcile(result));
  say();

  if (!result.ok && !allowMissing) {
    fail(
      `${result.missing.length} attachment row(s) have no file on disk.\n\n` +
        "This is not a problem with the backup — the running system is already\n" +
        "inconsistent, and those downloads are already broken. Writing the\n" +
        "archive anyway would preserve the breakage without recording it.\n\n" +
        "Fix it, or take the backup as-is and accept it knowingly:\n\n" +
        "  pnpm backup --allow-missing-attachments",
    );
  }

  const attachmentFiles: ArchivedFile[] = files.map((file) => ({
    key: file.key,
    bytes: file.data.length,
    sha256: sha256(file.data),
  }));

  const manifest: Manifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: process.env["npm_package_version"] ?? "0.0.0",
    postgresVersion: facts.postgresVersion,
    latestMigration: facts.latestMigration,
    encryptionKeyId: keyIdOf(process.env["ENCRYPTION_KEY_CURRENT"]),
    database: { key: DATABASE_NAME, bytes: dump.length, sha256: sha256(dump) },
    attachments: {
      count: attachmentFiles.length,
      totalBytes: attachmentFiles.reduce((sum, file) => sum + file.bytes, 0),
      files: attachmentFiles,
    },
    rowCounts: facts.rowCounts,
  };

  const archive = createTar([
    { name: MANIFEST_NAME, data: new TextEncoder().encode(stringify(manifest)) },
    { name: DATABASE_NAME, data: dump },
    ...files.map((file) => ({ name: ATTACHMENT_PREFIX + file.key, data: file.data })),
  ]);

  const compressed = gzipSync(archive);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, compressed);

  say(`  wrote ${out}`);
  say(
    `  ${describeBytes(compressed.length)} compressed, from ${describeBytes(archive.length)}`,
  );
  say();

  /*
   * Said on every successful backup, not buried in the documentation. The
   * archive is useless without the key and the key is useless without the
   * archive, and the single most common way to discover that is at the moment
   * somebody needs the backup.
   */
  say("  The encryption key is NOT in this archive, deliberately.");
  say(`  Store ENCRYPTION_KEY_CURRENT (key id "${manifest.encryptionKeyId ?? "none"}")`);
  say("  somewhere this file is not, or the stored SMTP password is unreadable.");
  say();
}

function stringify(manifest: Manifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}

function describeBytes(count: number): string {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KiB`;
  return `${(count / 1024 / 1024).toFixed(1)} MiB`;
}

// ---------------------------------------------------------------------------
// Reading an archive back
// ---------------------------------------------------------------------------

interface OpenedArchive {
  manifest: Manifest;
  dump: Uint8Array;
  attachments: Map<string, Uint8Array>;
}

/**
 * Opens an archive and proves it is internally complete, without touching
 * anything outside it.
 *
 * Every check that can be made from the file alone is made here, before a
 * restore has written a single byte. The alternative — discovering damage
 * halfway through — leaves a system that is neither the old one nor the new.
 */
function open(path: string): OpenedArchive {
  if (!existsSync(path)) fail(`No such archive: ${path}`);

  let entries;
  try {
    entries = readTar(gunzipSync(readFileSync(path)));
  } catch (error) {
    fail(`Could not read ${path}: ${(error as Error).message}`);
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry.data]));

  const manifestBytes = byName.get(MANIFEST_NAME);
  if (!manifestBytes) {
    fail(`${path} contains no ${MANIFEST_NAME}. It is not an Atarimae backup.`);
  }

  let manifest: Manifest;
  try {
    manifest = parseManifest(new TextDecoder().decode(manifestBytes));
  } catch (error) {
    fail((error as Error).message);
  }

  const dump = byName.get(DATABASE_NAME);
  if (!dump) fail(`${path} contains no ${DATABASE_NAME}.`);

  const attachments = new Map<string, Uint8Array>();
  for (const [name, data] of byName) {
    if (name.startsWith(ATTACHMENT_PREFIX)) {
      attachments.set(name.slice(ATTACHMENT_PREFIX.length), data);
    }
  }

  const problems = verifyDigests(
    [manifest.database, ...manifest.attachments.files],
    new Map([[DATABASE_NAME, dump], ...attachments]),
  );

  if (problems.length > 0) {
    const detail = problems
      .slice(0, 20)
      .map((p) => `    ${p.key}: ${p.reason} — expected ${p.expected}, found ${p.found}`)
      .join("\n");
    fail(
      `${path} does not match its own manifest (${problems.length} problem(s)):\n\n` +
        detail +
        (problems.length > 20 ? `\n    ... and ${problems.length - 20} more` : "") +
        "\n\nThis archive cannot be restored. Use an older one.",
    );
  }

  return { manifest, dump, attachments };
}

function describeArchive(manifest: Manifest): void {
  say(`  taken:       ${manifest.createdAt}`);
  say(`  postgres:    ${manifest.postgresVersion}`);
  say(`  migration:   ${manifest.latestMigration || "(none)"}`);
  say(`  key id:      ${manifest.encryptionKeyId ?? "(none recorded)"}`);
  say(`  attachments: ${manifest.attachments.count}`);

  const tables = Object.entries(manifest.rowCounts);
  const populated = tables.filter(([, count]) => count > 0);
  const rows = tables.reduce((sum, [, count]) => sum + count, 0);

  say(
    `  tables:      ${tables.length} (${populated.length} with rows, ${rows} rows in total)`,
  );
  for (const [table, count] of populated) {
    say(`    ${table.padEnd(30)} ${count}`);
  }
}

function verify(argv: string[]): void {
  const path = argv.find((argument) => !argument.startsWith("--"));
  if (!path) fail("Usage: pnpm backup:verify <file>");

  const { manifest, attachments } = open(resolve(path));

  say("Archive is internally complete.");
  say();
  describeArchive(manifest);
  say();

  const result = reconcile({
    databaseKeys: manifest.attachments.files.map((file) => file.key),
    fileKeys: attachments.keys(),
  });
  say(describeReconcile(result));
  say();
  say("  Every file the manifest lists is present and matches its digest.");
  say("  What this cannot check is the dump's contents — for that, restore it");
  say("  onto a spare machine. A backup you have never restored is not a backup.");
  say();
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

async function restore(argv: string[], root: string): Promise<void> {
  const path = argv.find((argument) => !argument.startsWith("--"));
  if (!path) fail("Usage: pnpm restore <file> [--force]");

  const force = argv.includes("--force");
  const databaseUrl = required("DATABASE_URL");
  const attachmentRoot = resolve(
    root,
    process.env["ATTACHMENT_ROOT"] ?? "./var/attachments",
  );

  requireClientTool("psql");

  const { manifest, dump, attachments } = open(resolve(path));

  say("Atarimae restore");
  say();
  describeArchive(manifest);
  say();

  /*
   * Restoring under a different key id is not fatal and must not be silent.
   * Everything works except the stored SMTP password, which fails at the moment
   * the first notification is sent — long after anybody connects it to this.
   */
  const currentKeyId = keyIdOf(process.env["ENCRYPTION_KEY_CURRENT"]);
  if (manifest.encryptionKeyId && currentKeyId !== manifest.encryptionKeyId) {
    say(`  WARNING: this archive's secrets were written under key id`);
    say(`  "${manifest.encryptionKeyId}", and ENCRYPTION_KEY_CURRENT here is`);
    say(`  "${currentKeyId ?? "not set"}". The restore will succeed and the stored`);
    say(`  SMTP password will not be readable. Set ENCRYPTION_KEY_PREVIOUS to the`);
    say(`  old key, or re-enter the password after restoring.`);
    say();
  }

  const before = await readDatabase(databaseUrl);
  if (before.tableCount > 0 && !force) {
    fail(
      `The target database already has ${before.tableCount} table(s).\n\n` +
        "Restoring over a database with data in it is not something to do by\n" +
        "accident, so it is not the default. Either point DATABASE_URL at an\n" +
        "empty database, or say so:\n\n" +
        "  pnpm restore <file> --force\n\n" +
        "--force drops every table in the public schema first. There is no undo.",
    );
  }

  if (before.tableCount > 0) {
    say(`  dropping ${before.tableCount} existing table(s) (--force)`);
    psql(
      databaseUrl,
      "DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
      "Dropping the schema",
    );
  }

  say("  restoring the database");
  psql(databaseUrl, new TextDecoder().decode(dump), "Restoring the database");

  say(`  writing ${attachments.size} attachment(s) to ${attachmentRoot}`);
  for (const [key, data] of attachments) {
    // Keys come from the archive, so they are treated as untrusted: a key
    // containing `..` would otherwise write outside ATTACHMENT_ROOT.
    const destination = resolve(attachmentRoot, key);
    if (destination !== attachmentRoot && !destination.startsWith(attachmentRoot + sep)) {
      fail(`Refusing to write outside ATTACHMENT_ROOT: ${key}`);
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, data);
  }

  /*
   * The restore is not finished when the last byte is written; it is finished
   * when the two halves are known to agree. This asks the restored database
   * what it expects and looks on the restored disk for it, which is the only
   * check that could catch a mistake in everything above.
   */
  say();
  const after = await readDatabase(databaseUrl);
  const onDisk = readAttachments(attachmentRoot).map((file) => file.key);
  const result = reconcile({ databaseKeys: after.storageKeys, fileKeys: onDisk });

  say(describeReconcile(result));
  say();

  if (!result.ok) {
    fail(
      "The restored database refers to attachments that are not on disk.\n\n" +
        "The restore has already been written, so this system is inconsistent\n" +
        "now. Restore an earlier archive, or accept that those downloads are\n" +
        "broken and delete the rows.",
    );
  }

  /*
   * Every table the archive recorded, compared against the restored database.
   * A table the archive knows and the restore does not is the loudest possible
   * symptom of a dump that did not apply cleanly, and it is invisible unless
   * somebody counts.
   */
  const differences: string[] = [];
  for (const [table, expected] of Object.entries(manifest.rowCounts)) {
    const actual = after.rowCounts[table];
    if (actual === undefined) {
      differences.push(
        `  ${table.padEnd(30)} archive ${expected}, restored: no such table`,
      );
    } else if (actual !== expected) {
      differences.push(`  ${table.padEnd(30)} archive ${expected}, restored ${actual}`);
    }
  }

  if (differences.length > 0) {
    fail(
      `The restored database does not match the archive:\n\n${differences.join("\n")}\n\n` +
        "The dump did not restore what it claimed to. Do not use this system.",
    );
  }

  const tables = Object.keys(manifest.rowCounts).length;
  const rows = Object.values(manifest.rowCounts).reduce((sum, count) => sum + count, 0);
  say(`  ${tables} table(s), ${rows} row(s) — every count matches the archive.`);
  say();
  say("  Restore complete, and checked against the manifest.");
  say("  Run the migrations before starting the server, in case this archive");
  say("  predates the code you are running:");
  say();
  say("    node scripts/db.mjs status");
  say();
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);

  // packages/backup/dist/cli.js -> the repository root. fileURLToPath rather
  // than URL.pathname, which yields "/F:/..." on Windows.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

  loadEnv(root);

  switch (command) {
    case "backup":
      await backup(argv, root);
      return;
    case "verify":
      verify(argv);
      return;
    case "restore":
      await restore(argv, root);
      return;
    default:
      fail(
        "Usage:\n\n" +
          "  pnpm backup [--out <file>]     write a verified archive\n" +
          "  pnpm backup:verify <file>      check an archive, touching nothing\n" +
          "  pnpm restore <file> [--force]  put one back",
      );
  }
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
