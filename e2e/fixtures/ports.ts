import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { checkoutPortOffset } from "../../scripts/checkout.mjs";

/**
 * The ports this suite's own servers listen on.
 *
 * In one place because more than the Playwright config needs them: the global
 * setup checks, before any test runs, that the servers answering on these ports
 * are the ones this run started.
 *
 * The offset is per checkout, and that is the dangerous half.
 * `reuseExistingServer` is on outside CI, so a second checkout does not fail on
 * a port already in use — it attaches to the *first* checkout's API server, runs
 * against that tree's code and that tree's database, and reports a result about
 * a repository it never read. A green run that proves nothing about your
 * changes is worse than a red one.
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const PORT_OFFSET = checkoutPortOffset(ROOT);

export const WEB_PORT = 5273 + PORT_OFFSET;
export const API_PORT = 3100 + PORT_OFFSET;
/** `vite preview`, serving the production build the PWA spec needs. */
export const PREVIEW_PORT = 5373 + PORT_OFFSET;
