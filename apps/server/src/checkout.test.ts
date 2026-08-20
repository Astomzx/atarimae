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

/*
 * Fixture paths, not anybody's actual checkout. The derivation only ever sees a
 * string, and a repository does not carry the machine it was written on.
 */
const ROOT = "D:/work/atarimae";
const WORKTREE = "D:/work/atarimae/.claude/worktrees/zen-merkle-991a84";
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
    expect(testDatabaseUrlFor(BASE, "D:/work/atarimae")).toBe(
      testDatabaseUrlFor(BASE, "d:/WORK/Atarimae"),
    );
  });

  it("does not treat a backslash path as a different checkout", () => {
    expect(testDatabaseUrlFor(BASE, "D:\\work\\atarimae")).toBe(
      testDatabaseUrlFor(BASE, "D:/work/atarimae"),
    );
  });

  it("ignores a trailing separator", () => {
    expect(testDatabaseUrlFor(BASE, "D:/work/atarimae/")).toBe(
      testDatabaseUrlFor(BASE, "D:/work/atarimae"),
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

/**
 * The second dimension, and the one that bit inside a single checkout: the
 * server's unit tests and the Playwright suite both truncate every table, and
 * this project asks you to run both. Sharing one database, they emptied each
 * other's tables mid-test — and the failure appeared as a browser three tests
 * into a spec finding itself on the first-run setup screen.
 */
describe("testDatabaseUrlFor, per suite", () => {
  it("gives the E2E suite a database of its own", () => {
    expect(testDatabaseUrlFor(BASE, ROOT, "e2e")).not.toBe(
      testDatabaseUrlFor(BASE, ROOT),
    );
  });

  it("is stable, so every caller derives the same one", () => {
    expect(testDatabaseUrlFor(BASE, ROOT, "e2e")).toBe(
      testDatabaseUrlFor(BASE, ROOT, "e2e"),
    );
  });

  it("still separates two checkouts within one suite", () => {
    expect(testDatabaseUrlFor(BASE, ROOT, "e2e")).not.toBe(
      testDatabaseUrlFor(BASE, WORKTREE, "e2e"),
    );
  });

  it("says which suite it belongs to, for the moment somebody types \\l", () => {
    const name = new URL(testDatabaseUrlFor(BASE, ROOT, "e2e")).pathname;

    expect(name).toContain("_e2e_");
    expect(name).toContain(checkoutTag(ROOT));
  });

  /**
   * Neither the suite nor the tag may be trimmed away by the length limit.
   * Losing either brings back a shared database, silently, because PostgreSQL
   * truncates without saying so.
   */
  it("keeps the suites apart even at the identifier limit", () => {
    const long = `postgresql://localhost:5432/${"a".repeat(120)}`;
    const unit = decodeURIComponent(new URL(testDatabaseUrlFor(long, ROOT)).pathname);
    const e2e = decodeURIComponent(
      new URL(testDatabaseUrlFor(long, ROOT, "e2e")).pathname,
    );

    expect(Buffer.byteLength(e2e.slice(1))).toBeLessThanOrEqual(63);
    expect(e2e).not.toBe(unit);
    expect(e2e).toContain("_e2e_");
  });

  /** An empty suite is the unit-test database, so existing callers are unchanged. */
  it("treats no suite as the plain test database", () => {
    expect(testDatabaseUrlFor(BASE, ROOT, "")).toBe(testDatabaseUrlFor(BASE, ROOT));
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
    expect(checkoutPortOffset("D:\\work\\atarimae")).toBe(
      checkoutPortOffset("d:/WORK/Atarimae/"),
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
