/**
 * Points the test run at TEST_DATABASE_URL.
 *
 * Loaded before any test file, so nothing can accidentally connect to the
 * development database and wipe it.
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { testDatabaseUrlFor } from "../../../../scripts/checkout.mjs";

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

/**
 * Per checkout, matching `scripts/db.mjs`. A second worktree running its own
 * tests against the same database deletes rows out from under this one, and
 * the failures it produces look like anything but their cause.
 */
process.env["DATABASE_URL"] = testDatabaseUrlFor(testUrl, ROOT);
process.env["NODE_ENV"] = "test";
process.env["LOG_LEVEL"] = "error";

/**
 * Uploads go to a temporary directory, never into the working tree.
 *
 * Set here rather than per test file for the same reason as the database
 * above: a suite that writes attachments into `var/` on one developer's
 * machine and not another's is a difference nobody notices until it matters.
 */
process.env["ATTACHMENT_ROOT"] = join(tmpdir(), "atarimae-test-attachments");
