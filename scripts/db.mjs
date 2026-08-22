#!/usr/bin/env node
/**
 * Unified database entry point.
 *
 *   pnpm db:new <name>   scaffold a new SQL migration (up + down)
 *   pnpm db:up           apply all pending migrations
 *   pnpm db:down         roll back the most recent migration
 *   pnpm db:status       show applied / pending migrations
 *   pnpm db:reset        drop, recreate and migrate the dev database
 *   pnpm db:verify       prove every migration is reversible (up -> down -> up)
 *
 * Append --test to target TEST_DATABASE_URL instead of DATABASE_URL:
 *   pnpm db:up --test
 *
 * Add --e2e to target the Playwright suite's own database, which is the test
 * database with `e2e` in its name. `reset --test` does both, because the two
 * suites are meant to be runnable at the same time and a half-prepared pair is
 * how one of them ends up on the other's tables.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { testDatabaseUrlFor } from "./checkout.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MIGRATIONS_DIR = join(ROOT, "migrations");

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Loads .env when present, and otherwise trusts the ambient environment.
 *
 * A container has no .env file — its configuration arrives as real environment
 * variables — so insisting on the file would make the container's startup
 * migration impossible.
 */
function loadEnv() {
  const envPath = join(ROOT, ".env");

  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
    return;
  }

  if (process.env.DATABASE_URL) return;

  fail(
    "No .env file, and DATABASE_URL is not set.\n\n" +
      "  node scripts/setup-env.mjs\n\n" +
      "Then check DATABASE_URL points at your PostgreSQL.",
  );
}

/**
 * Returns the connection string for the target database.
 *
 * The test one is per checkout — `atarimae_test` in `.env` becomes
 * `atarimae_test_<tag>` here, so a second worktree cannot delete this one's
 * rows halfway through a run. The development database is left exactly as
 * configured: it holds data somebody wants to keep, and moving it out from
 * under them would be the opposite of helpful. See `checkout.mjs`.
 */
function targetUrl(useTest, suite = "") {
  const key = useTest ? "TEST_DATABASE_URL" : "DATABASE_URL";
  const url = process.env[key];
  if (!url) fail(`${key} is not set in .env`);
  return useTest ? testDatabaseUrlFor(url, ROOT, suite) : url;
}

/**
 * Only needed by reset/verify, which create and drop databases. A deployment
 * never does either — its database already exists — so this stays optional
 * rather than blocking the startup migration.
 */
function adminUrl() {
  const url = process.env.ADMIN_DATABASE_URL;
  if (!url) {
    fail(
      "ADMIN_DATABASE_URL is not set.\n\n" +
        "It is only required for creating or dropping databases. On a\n" +
        "deployment, the database already exists — startup uses `db:up` instead.",
    );
  }
  return url;
}

/** Extracts the database name from a postgres:// connection string. */
function dbNameFrom(url) {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name) fail(`Cannot determine database name from: ${redact(url)}`);
  return name;
}

function redact(url) {
  return url.replace(/:\/\/([^:]+):[^@]*@/, "://$1:***@");
}

function fail(message) {
  console.error(`\n[db] ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// node-pg-migrate wrapper
// ---------------------------------------------------------------------------

/**
 * Resolves node-pg-migrate's entry script from node_modules rather than relying
 * on PATH, so `node scripts/db.mjs up` works the same as `pnpm db:up`.
 */
function migrateBin() {
  const require = createRequire(import.meta.url);
  try {
    const pkgPath = require.resolve("node-pg-migrate/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["node-pg-migrate"];
    if (rel) return join(dirname(pkgPath), rel);
  } catch {
    // exports map may hide package.json; fall through to the bin shim.
  }
  const shim = join(ROOT, "node_modules", ".bin", "node-pg-migrate");
  if (existsSync(shim) || existsSync(`${shim}.cmd`)) return shim;
  fail("Cannot locate node-pg-migrate. Run: pnpm install");
}

function runMigrate(args, databaseUrl) {
  const bin = migrateBin();
  const isJs = bin.endsWith(".js") || bin.endsWith(".mjs") || bin.endsWith(".cjs");

  const result = spawnSync(isJs ? process.execPath : bin, isJs ? [bin, ...args] : args, {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
    shell: !isJs,
  });
  if (result.error) fail(`Failed to run node-pg-migrate: ${result.error.message}`);
  return result.status ?? 1;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Creates a timestamped SQL migration with both directions stubbed out.
 * SQL (rather than the JS builder API) keeps CHECK constraints and partial
 * unique indexes readable — this project has a lot of both.
 */
function cmdNew(rawName) {
  if (!rawName) {
    fail("Usage: pnpm db:new <name>\n\n  Example: pnpm db:new create-org-units");
  }
  const slug = rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) fail(`Invalid migration name: ${rawName}`);

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const filename = `${stamp}_${slug}.sql`;
  const path = join(MIGRATIONS_DIR, filename);

  const template = `-- ${slug}
--
-- Both directions are required. \`pnpm db:verify\` runs up -> down -> up in CI
-- and fails the build if the down migration is missing or does not restore the
-- previous schema.

-- Up Migration

-- Down Migration

`;

  writeFileSync(path, template, "utf8");
  console.log(`\n[db] Created migrations/${filename}\n`);
  console.log("  Write the Up Migration, then the Down Migration that reverses it.");
  console.log("  Apply with:  pnpm db:up");
  console.log("  Verify with: pnpm db:verify\n");
  return 0;
}

function listMigrationFiles() {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") || f.endsWith(".js") || f.endsWith(".cjs"))
    .sort();
}

async function cmdStatus(useTest, suite = "") {
  const url = targetUrl(useTest, suite);
  const files = listMigrationFiles();
  const client = new pg.Client({ connectionString: url });

  let applied = [];
  try {
    await client.connect();
  } catch (error) {
    fail(
      `Cannot connect to ${redact(url)}\n\n  ${error.message}\n\n` +
        "Is PostgreSQL running? Try: pnpm db:reset",
    );
  }

  try {
    const { rows } = await client.query(
      "SELECT name, run_on FROM pgmigrations ORDER BY id",
    );
    applied = rows;
  } catch (error) {
    if (error.code === "42P01") {
      console.log(
        `\n[db] ${dbNameFrom(url)}: no migrations table yet — nothing applied.`,
      );
    } else {
      throw error;
    }
  } finally {
    await client.end();
  }

  const appliedNames = new Set(applied.map((r) => r.name));
  console.log(`\n[db] ${dbNameFrom(url)} (${redact(url)})\n`);

  if (files.length === 0) {
    console.log("  No migration files in migrations/.");
    console.log("  Create one with: pnpm db:new <name>\n");
    return 0;
  }

  for (const file of files) {
    const name = file.replace(/\.(sql|js|cjs)$/, "");
    const row = applied.find((r) => r.name === name);
    if (row) {
      const when = new Date(row.run_on).toISOString().replace("T", " ").slice(0, 19);
      console.log(`  [applied] ${name}  (${when})`);
    } else {
      console.log(`  [PENDING] ${name}`);
    }
  }

  const pending = files.filter(
    (f) => !appliedNames.has(f.replace(/\.(sql|js|cjs)$/, "")),
  );
  console.log(
    `\n  ${files.length} migration(s), ${applied.length} applied, ${pending.length} pending.\n`,
  );
  if (pending.length > 0) console.log("  Apply with: pnpm db:up\n");
  return 0;
}

/**
 * Drops and recreates the database.
 *
 * The locale matters: Windows would otherwise default to a CP932 collation
 * while the production container uses something else, which silently changes
 * ORDER BY results and unique index behaviour. The builtin C.UTF-8 provider
 * behaves identically on every platform.
 */
async function cmdReset(useTest, createOnly, suite = "", force = false) {
  const url = targetUrl(useTest, suite);
  const name = dbNameFrom(url);
  const client = new pg.Client({ connectionString: adminUrl() });

  try {
    await client.connect();
  } catch (error) {
    fail(
      `Cannot connect to the maintenance database.\n\n  ${error.message}\n\n` +
        "Check ADMIN_DATABASE_URL in .env and that PostgreSQL is running.",
    );
  }

  try {
    if (!createOnly) {
      /**
       * Something else connected is a reason to stop, not a reason to push
       * harder.
       *
       * This used to terminate every session and drop the database without
       * mentioning it — which, when the connection belonged to a running test
       * suite or a dev server, destroyed what it was using and left the
       * failure to appear somewhere else entirely. Named rather than counted,
       * because "2 connections" does not tell you which window to go and look
       * at.
       */
      const { rows: connected } = await client.query(
        `SELECT DISTINCT coalesce(application_name, '') AS app
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [name],
      );

      if (connected.length > 0 && !force) {
        const who = connected.map((row) => row.app || "unnamed").join(", ");
        fail(
          `${name} has ${connected.length} other connection(s): ${who}\n\n` +
            "Something is using this database — a dev server, a test run, or a\n" +
            "psql session. Stop it, or pass --force to drop it anyway.",
        );
      }

      // Terminate what is left, otherwise DROP DATABASE fails.
      await client.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [name],
      );
      await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
      console.log(`[db] Dropped ${name}`);
    }

    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      name,
    ]);
    if (exists.rowCount === 0) {
      await client.query(
        `CREATE DATABASE ${quoteIdent(name)}
           TEMPLATE template0
           ENCODING 'UTF8'
           LOCALE_PROVIDER builtin
           BUILTIN_LOCALE 'C.UTF-8'`,
      );
      console.log(`[db] Created ${name} (UTF8, builtin C.UTF-8)`);
    } else {
      console.log(`[db] ${name} already exists`);
    }
  } finally {
    await client.end();
  }
  return 0;
}

function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    fail(`Refusing to use unsafe database name: ${name}`);
  }
  return `"${name}"`;
}

/**
 * Proves every migration is reversible. Runs against the TEST database so it
 * never touches development data.
 *
 *   up (all) -> down (all) -> up (all)
 *
 * A migration without a working Down Migration fails here rather than during a
 * production rollback at 2am.
 */
async function cmdVerify() {
  const url = targetUrl(true);
  const count = listMigrationFiles().length;

  if (count === 0) {
    console.log("\n[db] No migrations to verify.\n");
    return 0;
  }

  console.log(`\n[db] Verifying ${count} migration(s) are reversible.`);
  console.log(`[db] Target: ${dbNameFrom(url)} (test database)\n`);

  await cmdReset(true, false);

  const steps = [
    ["up", ["up"], "Applying all migrations"],
    ["down", ["down", String(count)], "Rolling back all migrations"],
    ["up", ["up"], "Re-applying all migrations"],
  ];

  for (const [, args, label] of steps) {
    console.log(`\n[db] ${label}...`);
    const status = runMigrate(args, url);
    if (status !== 0) {
      fail(
        `${label} failed.\n\n` +
          "If the rollback failed, a migration is missing its Down Migration\n" +
          "or the down does not fully reverse the up.",
      );
    }
  }

  console.log("\n[db] All migrations are reversible.\n");
  return 0;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const e2eOnly = argv.includes("--e2e");
  // --e2e names a test database, so it implies --test rather than contradicting
  // it. `reset --e2e` on the development database would be a bad surprise.
  const useTest = argv.includes("--test") || e2eOnly;
  const createOnly = argv.includes("--create-only");
  const force = argv.includes("--force");
  // Container startup needs the migration names and result, not every SQL
  // statement echoed into production logs.
  const quiet = argv.includes("--quiet");
  const suite = e2eOnly ? "e2e" : "";
  const rest = argv.slice(1).filter((a) => !a.startsWith("--"));

  if (!command) {
    console.log(
      "\nUsage: node scripts/db.mjs <new|up|down|redo|status|reset|verify> " +
        "[--test] [--e2e] [--quiet]\n",
    );
    process.exit(1);
  }

  loadEnv();

  switch (command) {
    case "new":
      process.exit(cmdNew(rest[0]));
      break;
    case "up":
      process.exit(
        runMigrate(quiet ? ["up", "--verbose=false"] : ["up"], targetUrl(useTest, suite)),
      );
      break;
    case "down":
      process.exit(runMigrate(["down", rest[0] ?? "1"], targetUrl(useTest, suite)));
      break;
    case "redo":
      process.exit(runMigrate(["redo"], targetUrl(useTest, suite)));
      break;
    case "status":
      process.exit(await cmdStatus(useTest, suite));
      break;
    case "reset": {
      /**
       * `reset --test` prepares both test databases.
       *
       * The two suites have one database each so they can run at the same
       * time, and one command is what makes that reliable: a developer — or a
       * CI job — who prepares only the one they were thinking about leaves the
       * other missing or a migration behind, and the suite that finds it says
       * something about tables rather than about databases.
       */
      const suites = useTest && !e2eOnly ? ["", "e2e"] : [suite];

      for (const each of suites) {
        await cmdReset(useTest, createOnly, each, force);
        if (!createOnly) {
          const status = runMigrate(["up"], targetUrl(useTest, each));
          if (status !== 0) process.exit(status);
        }
      }
      process.exit(0);
      break;
    }
    case "verify":
      process.exit(await cmdVerify());
      break;
    default:
      fail(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
