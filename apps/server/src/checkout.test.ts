import { describe, expect, it } from "vitest";

import {
  checkoutPortOffset,
  checkoutTag,
  testDatabaseUrlFor,
} from "../../../scripts/checkout.mjs";

/**
 * The derivation that keeps two checkouts off one test database.
 *
 * Tested from here because `scripts/` has no runner of its own and this is the
 * suite that would suffer: `apps/server/src/test/setup-env.ts` is one of the
 * three callers, and all three must agree exactly. If they ever disagree, the
 * symptom is not a clear error — it is one process creating tables in a
 * database another process is not looking at, reported as "relation does not
 * exist" somewhere unrelated.
 *
 * The bug this closes: a git worktree copies `.env`, so its E2E run and the
 * main checkout's unit tests shared one database and deleted each other's rows
 * — 25 failures across four unrelated areas, then a clean run a minute later.
 */

const ROOT = "F:/Claude/Atarimae";
const WORKTREE = "F:/Claude/Atarimae/.claude/worktrees/zen-merkle-991a84";
const BASE = "postgresql://atarimae:secret@localhost:5432/atarimae_test";

describe("testDatabaseUrlFor", () => {
  it("gives two checkouts two different databases", () => {
    expect(testDatabaseUrlFor(BASE, ROOT)).not.toBe(testDatabaseUrlFor(BASE, WORKTREE));
  });

  /** Same checkout, same database — or `db:test:reset` prepares the wrong one. */
  it("is stable for one checkout", () => {
    expect(testDatabaseUrlFor(BASE, ROOT)).toBe(testDatabaseUrlFor(BASE, ROOT));
  });

  /** Windows hands back either case for the same directory. */
  it("does not treat a change of case as a different checkout", () => {
    expect(testDatabaseUrlFor(BASE, "F:/Claude/Atarimae")).toBe(
      testDatabaseUrlFor(BASE, "f:/claude/atarimae"),
    );
  });

  it("does not treat a backslash path as a different checkout", () => {
    expect(testDatabaseUrlFor(BASE, "F:\\Claude\\Atarimae")).toBe(
      testDatabaseUrlFor(BASE, "F:/Claude/Atarimae"),
    );
  });

  it("ignores a trailing separator", () => {
    expect(testDatabaseUrlFor(BASE, "F:/Claude/Atarimae/")).toBe(
      testDatabaseUrlFor(BASE, "F:/Claude/Atarimae"),
    );
  });

  it("keeps the configured name as the prefix, so it is recognisable", () => {
    expect(new URL(testDatabaseUrlFor(BASE, ROOT)).pathname).toMatch(/^\/atarimae_test_/);
  });

  it("changes only the database name", () => {
    const url = new URL(testDatabaseUrlFor(BASE, ROOT));

    expect(url.protocol).toBe("postgresql:");
    expect(url.username).toBe("atarimae");
    expect(url.password).toBe("secret");
    expect(url.host).toBe("localhost:5432");
  });

  it("preserves a query string", () => {
    const withSsl = `${BASE}?sslmode=require`;
    expect(testDatabaseUrlFor(withSsl, ROOT)).toContain("sslmode=require");
  });

  /**
   * PostgreSQL truncates an over-long name silently, and two names truncated
   * to the same 63 bytes is exactly the shared database this exists to
   * prevent. The base is trimmed; the tag never is.
   */
  it("stays inside PostgreSQL's identifier limit", () => {
    const long = `postgresql://localhost:5432/${"a".repeat(120)}`;
    const name = decodeURIComponent(
      new URL(testDatabaseUrlFor(long, ROOT)).pathname.slice(1),
    );

    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
    expect(name).toContain(checkoutTag(ROOT));
  });

  it("keeps two long-named checkouts apart despite the limit", () => {
    const long = `postgresql://localhost:5432/${"a".repeat(120)}`;
    expect(testDatabaseUrlFor(long, ROOT)).not.toBe(testDatabaseUrlFor(long, WORKTREE));
  });
});

describe("checkoutTag", () => {
  /** Readable on purpose: `\l` in psql should say which database is whose. */
  it("carries the directory name so a human can tell them apart", () => {
    expect(checkoutTag(WORKTREE)).toContain("zen_merkle_991a84");
    expect(checkoutTag(ROOT)).toContain("atarimae");
  });

  it("produces something usable as an identifier", () => {
    for (const root of [ROOT, WORKTREE, "/var/lib/a-b.c/d e"]) {
      expect(checkoutTag(root)).toMatch(/^[a-z0-9_]+$/);
    }
  });

  /** Two checkouts of the same name in different places are still two. */
  it("distinguishes same-named directories in different places", () => {
    expect(checkoutTag("/home/a/atarimae")).not.toBe(checkoutTag("/home/b/atarimae"));
  });
});

/**
 * The more dangerous half. Playwright runs with `reuseExistingServer` outside
 * CI, so two checkouts on one port do not collide loudly — the second one
 * attaches to the first one's API server and reports a result about a tree it
 * never read.
 */
describe("checkoutPortOffset", () => {
  it("gives two checkouts different ports", () => {
    expect(checkoutPortOffset(ROOT)).not.toBe(checkoutPortOffset(WORKTREE));
  });

  /** Or `reuseExistingServer` would not find this checkout's own server. */
  it("is stable for one checkout", () => {
    expect(checkoutPortOffset(ROOT)).toBe(checkoutPortOffset(ROOT));
  });

  it("agrees with the database on what counts as the same checkout", () => {
    expect(checkoutPortOffset("F:\\Claude\\Atarimae")).toBe(
      checkoutPortOffset("f:/claude/atarimae/"),
    );
  });

  /** The bases are 3100, 5273 and 5373; anything wider walks into real services. */
  it("stays within a small, predictable range", () => {
    for (const root of [ROOT, WORKTREE, "/home/x/y", "/", "C:/a"]) {
      const offset = checkoutPortOffset(root);
      expect(Number.isInteger(offset)).toBe(true);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(100);
    }
  });
});
