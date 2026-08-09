import pg from "pg";

/**
 * Truncates every business table so a spec can start from a genuinely empty
 * organisation — which is the only way to exercise first-run setup.
 *
 * TRUNCATE does not fire row-level triggers, so emptying `users` is legitimate
 * here even though deleting the last Owner is forbidden through every normal
 * path.
 */
export async function resetDatabase(): Promise<void> {
  const connectionString = process.env["TEST_DATABASE_URL"];
  if (!connectionString) throw new Error("TEST_DATABASE_URL is not set");

  const client = new pg.Client({ connectionString });
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
  const connectionString = process.env["TEST_DATABASE_URL"];
  if (!connectionString) throw new Error("TEST_DATABASE_URL is not set");

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<T>(sql, params);
    return rows;
  } finally {
    await client.end();
  }
}
