import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

import { checkoutPortOffset, testDatabaseUrlFor } from "../scripts/checkout.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV_FILE = join(ROOT, ".env");

if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

/**
 * E2E runs against the *test* database, never the development one — these
 * tests create and delete data freely.
 */
const configuredTestUrl = process.env["TEST_DATABASE_URL"];
if (!configuredTestUrl) {
  throw new Error(
    "TEST_DATABASE_URL is not set. Run `node scripts/setup-env.mjs`, then `pnpm db:test:reset`.",
  );
}

/**
 * Per checkout *and* per suite, matching `scripts/db.mjs` and `fixtures/database.ts`.
 *
 * This is the caller that made the checkout half necessary: an E2E run starts a
 * real API server with a notification worker, and it keeps polling and draining
 * for as long as the suite lasts. Pointed at a database another checkout is
 * also using, it corrupts that one's unit tests continuously and invisibly.
 *
 * The suite half is why `pnpm check` and `pnpm test:e2e` can be run at the same
 * time. They used to share one database and empty each other's tables mid-test.
 */
const testDatabaseUrl = testDatabaseUrlFor(configuredTestUrl, ROOT, "e2e");

/**
 * Ports are per checkout too, and this is the more dangerous half.
 *
 * `reuseExistingServer` is on outside CI, which is what makes a second checkout
 * silent rather than merely broken: it does not fail on a port already in use,
 * it attaches to the *first* checkout's API server, runs against that tree's
 * code and that tree's database, and reports a result about a repository it
 * never read. A green run that proves nothing about your changes is worse than
 * a red one.
 */
const PORT_OFFSET = checkoutPortOffset(ROOT);

const WEB_PORT = 5273 + PORT_OFFSET;
const API_PORT = 3100 + PORT_OFFSET;
/** `vite preview`, serving the production build the PWA spec needs. */
const PREVIEW_PORT = 5373 + PORT_OFFSET;
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
      // The PWA has its own project below, against the production build.
      testIgnore: /pwa\.spec\.ts$/,
    },
    {
      // The product rule is that phone and PC are not two different products.
      // Running the same specs at phone width is how that stays true.
      name: "mobile",
      use: { ...devices["Pixel 7"] },
      // Pure API scenarios are viewport-independent. Running them under both
      // projects would repeat identical assertions against one shared database.
      testIgnore: /acceptance\.spec\.ts$|pwa\.spec\.ts$/,
    },
    {
      /**
       * The PWA, against `vite preview` rather than `vite dev`.
       *
       * The service worker only registers in a production build — a worker
       * that pins the shell fights hot reload — so this is the only mode where
       * there is anything to test. It gets its own project rather than its own
       * width: what is being proved is offline behaviour, not layout.
       */
      name: "pwa",
      testMatch: /pwa\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${PREVIEW_PORT}` },
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
      /**
       * The production build, for the PWA spec only.
       *
       * Built here rather than assumed: the service worker caches whatever the
       * build produced, so testing a stale `dist` would be testing yesterday's
       * assets.
       */
      command: "pnpm --filter @atarimae/web build && pnpm --filter @atarimae/web preview",
      port: PREVIEW_PORT,
      cwd: ROOT,
      reuseExistingServer: !isCI,
      timeout: 180_000,
      env: {
        VITE_PORT: String(PREVIEW_PORT),
        VITE_API_TARGET: `http://127.0.0.1:${API_PORT}`,
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
