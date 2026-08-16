/**
 * Types for `checkout.mjs`, hand-written.
 *
 * The implementation is plain JavaScript because `scripts/db.mjs` runs before
 * anything is built — it is what creates the database the build's tests need —
 * and its two other callers are TypeScript. This is the seam between them.
 */

/** A short, unique, human-readable name for the checkout at `root`. */
export function checkoutTag(root: string): string;

/**
 * Returns `baseUrl` with its database name suffixed by the checkout's tag, so
 * two checkouts never share one test database. Everything else about the URL
 * is preserved.
 */
export function testDatabaseUrlFor(baseUrl: string, root: string): string;

/**
 * A per-checkout offset to add to a base port, so a second checkout's E2E run
 * cannot silently attach to the first one's server.
 */
export function checkoutPortOffset(root: string): number;
