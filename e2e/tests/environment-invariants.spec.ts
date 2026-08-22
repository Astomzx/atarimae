import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { connectionString } from "../fixtures/database.js";
import { PREVIEW_PORT, WEB_PORT } from "../fixtures/ports.js";
import { assertServersUseDatabase } from "../fixtures/server-identity.js";

/**
 * Regression guards for environment-level failures found during foundation work.
 *
 * These assert on repository configuration rather than on application
 * behaviour, which is unusual for a Playwright spec — but this is exactly the
 * layer they broke at, and both failures presented as "the app is down" rather
 * than as anything a unit test would notice.
 */

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const read = (relative: string) => readFileSync(join(ROOT, relative), "utf8");

test.describe("environment invariants", () => {
  /**
   * Vite left to its default binds ::1 on Windows while tooling connects to
   * 127.0.0.1. Playwright's port probe tries both, so it reports the server as
   * ready, and then every test fails with ERR_CONNECTION_REFUSED — which looks
   * like an application fault rather than an address-family mismatch.
   */
  test("Vite binds IPv4 explicitly", () => {
    const config = read("apps/web/vite.config.ts");

    expect(config).toContain('host: "127.0.0.1"');
  });

  test("Playwright and Vite agree on the address family", () => {
    const config = read("e2e/playwright.config.ts");

    expect(config).toContain("http://127.0.0.1:");
    expect(config).not.toContain("http://localhost:");
  });

  /**
   * PowerShell 5.1 writes UTF-8 *with* a BOM. A BOM at the head of .env becomes
   * part of the first variable's name, so DATABASE_URL silently reads as
   * undefined while the file looks perfectly correct in an editor.
   * scripts/setup-env.mjs writes through Node for this reason.
   */
  test(".env has no byte order mark", () => {
    const path = join(ROOT, ".env");
    test.skip(!existsSync(path), ".env not present in this environment");

    const bytes = readFileSync(path);

    expect([bytes[0], bytes[1], bytes[2]]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.subarray(0, 1).toString("utf8")).not.toBe("﻿");
  });

  test("setup-env.mjs writes .env through Node, not a shell redirect", () => {
    const script = read("scripts/setup-env.mjs");

    expect(script).toContain("writeFileSync");
    expect(script).toContain('encoding: "utf8"');
  });

  /**
   * `reuseExistingServer` adopts whatever is on the port, whatever environment
   * it was started with. A server left over from an earlier session serves a
   * different database to the same browser, and the specs then truncate one
   * while the browser reads the other.
   *
   * The per-checkout port offset makes another *checkout's* server unlikely to
   * be there. It does nothing about this checkout's own server started before
   * the E2E database existed, which is pointed at the unit tests' database.
   */
  const probeUrls = [
    `http://127.0.0.1:${String(WEB_PORT)}/api/v1/health`,
    `http://127.0.0.1:${String(PREVIEW_PORT)}/api/v1/health`,
  ];

  test("the servers on these ports are serving this suite's database", async () => {
    const url = connectionString();

    // For real, through the same chain the specs use — browser port, Vite
    // proxy, Fastify, PostgreSQL. The global setup already made this check;
    // asserting it here is what fails visibly if the wiring is ever removed
    // from playwright.config.ts.
    await expect(
      assertServersUseDatabase({
        connectionString: url,
        databaseName: databaseNameOf(url),
        probeUrls,
      }),
    ).resolves.toBeUndefined();
  });

  test("a server on the right port but the wrong database is refused", async () => {
    const url = connectionString();

    // The servers answer — that half is real — but nothing of theirs is
    // connected here. That is exactly what a leftover looks like, and it has to
    // stop the run rather than be adopted.
    await expect(
      assertServersUseDatabase({
        connectionString: url,
        databaseName: databaseNameOf(url),
        probeUrls,
        countServerConnections: () => Promise.resolve(0),
      }),
    ).rejects.toThrow(/is not using atarimae_test_e2e/);
  });
});

function databaseNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}
