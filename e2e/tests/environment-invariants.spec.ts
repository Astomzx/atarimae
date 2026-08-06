import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

/**
 * Regression guards for environment-level failures found during M0.
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
});
