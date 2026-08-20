/**
 * One of everything per checkout — test database and ports — derived rather
 * than configured.
 *
 * A git worktree — an agent's, or your own second copy — starts life with the
 * same `.env` as the checkout it came from. So `TEST_DATABASE_URL` names the
 * same database in both, and the moment two of them run tests at once they are
 * deleting each other's rows.
 *
 * That failure does not look like what it is. It produced 25 failures scattered
 * across org units, invitations, reminders and identity, and then a clean
 * 369/369 a minute later — every symptom of a flaky suite and none of the
 * cause. Worse, it makes measurement itself untrustworthy: an afternoon of
 * "does this reproduce without my change" is worthless if a second checkout is
 * dropping the database in between.
 *
 * The fix is deliberately not a new setting. A setting somebody must remember
 * to change in each worktree is the same trap with an extra step, and worktrees
 * are usually created by tooling that copies `.env` verbatim. Deriving the name
 * from where the checkout *is* cannot be forgotten.
 *
 * Every consumer must agree exactly, so there is one implementation and three
 * callers: `scripts/db.mjs`, `apps/server/src/test/setup-env.ts` and
 * `e2e/playwright.config.ts`. Two of those are TypeScript, which is why this
 * file ships a hand-written `.d.mts` beside it.
 *
 * Ports are here for the same reason and are, if anything, worse. Playwright
 * is configured with `reuseExistingServer` outside CI, so a second checkout's
 * E2E run does not fail on a port already in use — it quietly attaches to the
 * *first* checkout's API server, tests that one's code against that one's
 * database, and reports a result about a tree it never read.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

/** PostgreSQL's NAMEDATALEN - 1. A longer name is silently truncated. */
const MAX_IDENTIFIER_BYTES = 63;

/** Enough that two checkouts colliding is not a thing that happens. */
const HASH_CHARS = 8;

/** Keeps the readable half from eating the whole budget. */
const MAX_LABEL_CHARS = 20;

/**
 * The checkout's path, in a form that hashes the same every time.
 *
 * `realpath` because a worktree may be reached through a symlink or a
 * mapped drive, and lower case because Windows will hand back `F:\Claude` one
 * day and `f:\claude` the next for the same directory. Either would produce a
 * second database for a checkout that already had one — not dangerous, but it
 * would quietly undo the "one per checkout" property this file exists for.
 */
function canonicalPath(root) {
  let resolved = root;
  try {
    resolved = realpathSync(root);
  } catch {
    // A path that does not exist yet still has to hash to something stable.
  }
  return resolved.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * A short, human-readable label for a checkout, plus a hash that makes it
 * unique.
 *
 * The label is there for the moment somebody types `\l` in psql and needs to
 * know which of six databases is theirs. The hash is there because two
 * checkouts can perfectly well both be called `atarimae`.
 */
export function checkoutTag(root) {
  const path = canonicalPath(root);
  const hash = createHash("sha256").update(path).digest("hex").slice(0, HASH_CHARS);

  const label = (path.split("/").pop() ?? "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_LABEL_CHARS);

  return label ? `${label}_${hash}` : hash;
}

/**
 * `postgresql://…/atarimae_test` in, `postgresql://…/atarimae_test_<tag>` out —
 * or `atarimae_test_e2e_<tag>` when a suite is named.
 *
 * Everything else about the URL is preserved, including a `sslmode` query and
 * credentials — only the database name changes.
 *
 * **The suite matters as much as the checkout.** One checkout runs two suites
 * that both empty every table: the server's unit tests truncate and create an
 * Owner in a `beforeEach`, several hundred times a run, and each E2E spec
 * truncates in its `beforeAll`. `pnpm check` runs the first and `pnpm test:e2e`
 * the second, and CLAUDE.md asks you to run both — in two terminals they empty
 * each other's tables mid-test. The damage never surfaces where it happens: a
 * browser three tests into a spec finds itself on the first-run setup screen,
 * or the two TRUNCATEs deadlock and PostgreSQL kills one.
 *
 * Derived rather than a second environment variable, for the reason at the top
 * of this file: a `.env` that has to gain a line is a `.env` that some checkout
 * will not have.
 */
export function testDatabaseUrlFor(baseUrl, root, suite = "") {
  const url = new URL(baseUrl);
  const base = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const tag = checkoutTag(root);

  /*
   * The name is trimmed from the *base*, never from the tag or the suite.
   * Truncating either is how two checkouts — or two suites — end up sharing a
   * database again, which is the one outcome this whole file exists to
   * prevent, and PostgreSQL truncates silently, so it would come back as the
   * same unexplainable flakiness.
   */
  const suffix = suite ? `${suite}_${tag}` : tag;
  const room = MAX_IDENTIFIER_BYTES - suffix.length - 1;
  if (room < 1) {
    throw new Error(`Checkout tag "${suffix}" leaves no room for a database name.`);
  }

  url.pathname = `/${encodeURIComponent(`${base.slice(0, room)}_${suffix}`)}`;
  return url.toString();
}

/**
 * How many distinct port slots a machine can hand out before two checkouts
 * land on the same one.
 *
 * Deliberately small. The E2E ports are picked to sit in quiet parts of the
 * range, and spreading them over thousands of numbers would eventually walk
 * into whatever else the developer is running. Twenty checkouts on one machine
 * is already an unusual day; a hundred is not a case worth pessimising for.
 */
const PORT_SLOTS = 100;

/**
 * A per-checkout offset to add to a base port.
 *
 * Derived from the same tag as the database, so a checkout's ports and its
 * database move together and `reuseExistingServer` still finds *this*
 * checkout's server on a second run.
 *
 * This does not make a collision impossible — two checkouts 100 apart in the
 * hash still meet — but it turns "always collides" into "essentially never",
 * and a genuine collision fails loudly as a port already in use rather than
 * silently as a passing test against somebody else's tree.
 */
export function checkoutPortOffset(root) {
  const hash = createHash("sha256").update(canonicalPath(root)).digest();
  return hash.readUInt16BE(0) % PORT_SLOTS;
}
