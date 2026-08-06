/**
 * Points the test run at TEST_DATABASE_URL.
 *
 * Loaded before any test file, so nothing can accidentally connect to the
 * development database and wipe it.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const ENV_FILE = join(ROOT, ".env");

if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

const testUrl = process.env["TEST_DATABASE_URL"];
if (!testUrl) {
  throw new Error(
    "TEST_DATABASE_URL is not set. Run `node scripts/setup-env.mjs` then `pnpm db:test:reset`.",
  );
}

process.env["DATABASE_URL"] = testUrl;
process.env["NODE_ENV"] = "test";
process.env["LOG_LEVEL"] = "error";
