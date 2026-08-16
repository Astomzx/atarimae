import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { testDatabaseUrlFor } from "../../scripts/checkout.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The same database `playwright.config.ts` gave the API server.
 *
 * Derived once, here, rather than read from the environment at each call site.
 * Reading `TEST_DATABASE_URL` directly is what these two functions used to do,
 * and when the config started deriving a per-checkout name they carried on
 * truncating the old one — so every spec that begins by setting up an
 * organisation failed, because the database it had just "reset" was not the
 * database the server was using. 122 tests did not run and none of the errors
 * mentioned a database.
 */
function connectionString(): string {
  const configured = process.env["TEST_DATABASE_URL"];
  if (!configured) throw new Error("TEST_DATABASE_URL is not set");
  return testDatabaseUrlFor(configured, ROOT);
}

/**
 * Truncates every business table so a spec can start from a genuinely empty
 * organisation — which is the only way to exercise first-run setup.
 *
 * TRUNCATE does not fire row-level triggers, so emptying `users` is legitimate
 * here even though deleting the last Owner is forbidden through every normal
 * path.
 */
export async function resetDatabase(): Promise<void> {
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  try {
    await client.query(
      `TRUNCATE call_participants, calls, call_providers,
                webhook_deliveries, webhooks,
                api_tokens, audit_logs, sessions, user_devices, invitations,
                message_mentions, message_attachments, messages,
                direct_conversations, channel_members, channels,
                user_org_units, org_units, users RESTART IDENTITY CASCADE`,
    );
  } finally {
    await client.end();
  }
}

/** Reads rows back for assertions the API deliberately does not expose. */
export async function query<T extends pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  try {
    const { rows } = await client.query<T>(sql, params);
    return rows;
  } finally {
    await client.end();
  }
}
