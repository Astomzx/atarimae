import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV_FILE = join(ROOT, ".env");

if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

/**
 * E2E runs against the *test* database, never the development one — these
 * tests create and delete data freely.
 */
const testDatabaseUrl = process.env["TEST_DATABASE_URL"];
if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is not set. Run `node scripts/setup-env.mjs`, then `pnpm db:test:reset`.",
  );
}

const WEB_PORT = 5273;
const API_PORT = 3100;
const isCI = !!process.env["CI"];

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,

  // Artifacts here double as promotional material: the acceptance scenario is
  // also the demo recording. See docs/architecture for the M1/M2 script.
  reporter: isCI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  },

  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // The product rule is that phone and PC are not two different products.
      // Running the same specs at phone width is how that stays true.
      name: "mobile",
      use: { ...devices["Pixel 7"] },
      // Pure API scenarios are viewport-independent. Running them under both
      // projects would repeat identical assertions against one shared database.
      testIgnore: /acceptance\.spec\.ts$/,
    },
  ],

  webServer: [
    {
      command: "pnpm --filter @atarimae/server dev",
      port: API_PORT,
      cwd: ROOT,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      env: {
        DATABASE_URL: testDatabaseUrl,
        PORT: String(API_PORT),
        HOST: "127.0.0.1",
        NODE_ENV: "test",
        LOG_LEVEL: "warn",
        PUBLIC_ORIGIN: `http://127.0.0.1:${WEB_PORT}`,
        // Uploads land in their own directory, never in the one a development
        // session is using.
        ATTACHMENT_ROOT: join(ROOT, "e2e", "var", "attachments"),
      },
    },
    {
      command: "pnpm --filter @atarimae/web dev",
      port: WEB_PORT,
      cwd: ROOT,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      env: {
        VITE_PORT: String(WEB_PORT),
        VITE_API_TARGET: `http://127.0.0.1:${API_PORT}`,
      },
    },
  ],
});
