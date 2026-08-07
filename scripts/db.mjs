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
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MIGRATIONS_DIR = join(ROOT, "migrations");

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Loads .env when present, and otherwise trusts the ambient environment.
 *
 * A container has no .env file — its configuration arrives as real environment
 * variables — so insisting on the file would make `docker compose exec app
 * node scripts/db.mjs up` impossible, which is the documented way to run
 * migrations on a deployment.
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

/** Returns the connection string for the target database. */
function targetUrl(useTest) {
  const key = useTest ? "TEST_DATABASE_URL" : "DATABASE_URL";
  const url = process.env[key];
  if (!url) fail(`${key} is not set in .env`);
  return url;
}

/**
 * Only needed by reset/verify, which create and drop databases. A deployment
 * never does either — its database already exists — so this stays optional
 * rather than blocking `db:up` in a container.
 */
function adminUrl() {
  const url = process.env.ADMIN_DATABASE_URL;
  if (!url) {
    fail(
      "ADMIN_DATABASE_URL is not set.\n\n" +
        "It is only required for creating or dropping databases. On a\n" +
        "deployment, the database already exists — use `db:up` instead.",
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

async function cmdStatus(useTest) {
  const url = targetUrl(useTest);
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
async function cmdReset(useTest, createOnly) {
  const url = targetUrl(useTest);
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
      // Terminate other sessions, otherwise DROP DATABASE fails.
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
  const useTest = argv.includes("--test");
  const createOnly = argv.includes("--create-only");
  const rest = argv.slice(1).filter((a) => !a.startsWith("--"));

  if (!command) {
    console.log(
      "\nUsage: node scripts/db.mjs <new|up|down|redo|status|reset|verify> [--test]\n",
    );
    process.exit(1);
  }

  loadEnv();

  switch (command) {
    case "new":
      process.exit(cmdNew(rest[0]));
      break;
    case "up":
      process.exit(runMigrate(["up"], targetUrl(useTest)));
      break;
    case "down":
      process.exit(runMigrate(["down", rest[0] ?? "1"], targetUrl(useTest)));
      break;
    case "redo":
      process.exit(runMigrate(["redo"], targetUrl(useTest)));
      break;
    case "status":
      process.exit(await cmdStatus(useTest));
      break;
    case "reset":
      await cmdReset(useTest, createOnly);
      if (!createOnly) process.exit(runMigrate(["up"], targetUrl(useTest)));
      process.exit(0);
      break;
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
