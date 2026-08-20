import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { connectionString } from "./database.js";
import { PREVIEW_PORT, WEB_PORT } from "./ports.js";
import { assertServersUseDatabase } from "./server-identity.js";

/**
 * Runs once, before any test and after the servers are up.
 *
 * It fails the whole run with one message naming the cause, which is the point:
 * what it replaces is a random test in a random project failing several minutes
 * later, for a reason that has nothing to do with it.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENV_FILE = join(ROOT, ".env");

export default async function globalSetup(): Promise<void> {
  // Playwright loads this file in its own process, which has not read `.env`.
  if (existsSync(ENV_FILE)) {
    process.loadEnvFile(ENV_FILE);
  }

  const url = connectionString();

  await assertServersUseDatabase({
    connectionString: url,
    databaseName: decodeURIComponent(new URL(url).pathname.replace(/^\//, "")),
    // Both of the servers the specs talk to: `vite dev` for desktop and mobile,
    // `vite preview` for the PWA project. Either can be a leftover.
    probeUrls: [
      `http://127.0.0.1:${String(WEB_PORT)}/api/v1/health`,
      `http://127.0.0.1:${String(PREVIEW_PORT)}/api/v1/health`,
    ],
  });
}
