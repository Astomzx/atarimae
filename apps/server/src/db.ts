import pg from "pg";

import type { Config } from "./config.js";

export type Database = pg.Pool;
export type DatabaseClient = pg.PoolClient;

/**
 * `timestamptz` arrives as a JS Date by default, which silently reinterprets
 * through the server's local timezone on the way back out. Everything in this
 * system is UTC; keep the raw string and let the boundary decide.
 */
const TIMESTAMPTZ_OID = 1184;
const TIMESTAMP_OID = 1114;
pg.types.setTypeParser(TIMESTAMPTZ_OID, (value) => value);
pg.types.setTypeParser(TIMESTAMP_OID, (value) => value);

/** `bigint` would otherwise lose precision above 2^53. */
const INT8_OID = 20;
pg.types.setTypeParser(INT8_OID, (value) => BigInt(value));

export function createDatabase(config: Config): Database {
  return new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "atarimae",
  });
}

/**
 * Runs `fn` inside a transaction, rolling back on any throw.
 *
 * Most of the announcement model depends on this: creating recipients,
 * personalizations, obligations and outbox events must either all land or none
 * of them. A partially applied publish is the one failure this system must
 * never produce.
 */
export async function withTransaction<T>(
  db: Database,
  fn: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is already broken; the pool will discard it.
    }
    throw error;
  } finally {
    client.release();
  }
}
