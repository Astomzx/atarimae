import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";
import { createDatabase, withTransaction, type Database } from "./db.js";

let db: Database;

beforeAll(() => {
  db = createDatabase(loadConfig());
});

afterAll(async () => {
  await db.end();
});

/**
 * M0 regression: a database created without an explicit locale gets
 * `Japanese_Japan.936` (CP932) on a Japanese Windows host and something else
 * inside a Linux container. Collation decides ORDER BY results, index
 * behaviour, and which values a unique index treats as equal — so development
 * and production silently disagreeing about it is a correctness bug, not a
 * cosmetic one.
 */
describe("database locale", () => {
  it("uses the builtin C.UTF-8 provider so every platform agrees", async () => {
    const { rows } = await db.query<{
      encoding: string;
      provider: string;
      locale: string | null;
    }>(
      `SELECT pg_encoding_to_char(encoding) AS encoding,
              datlocprovider                AS provider,
              datlocale                     AS locale
         FROM pg_database
        WHERE datname = current_database()`,
    );

    expect(rows[0]?.encoding).toBe("UTF8");
    // 'b' = builtin provider. 'c' (libc) or 'i' (ICU) would be host-dependent.
    expect(rows[0]?.provider).toBe("b");
    expect(rows[0]?.locale).toBe("C.UTF-8");
  });

  it("provides uuidv7(), which the schema depends on for primary keys", async () => {
    const { rows } = await db.query<{ id: string }>("SELECT uuidv7() AS id");

    expect(rows[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("returns timestamptz as a string, not a Date reinterpreted through local time", async () => {
    const { rows } = await db.query<{ t: unknown }>("SELECT now() AS t");

    expect(typeof rows[0]?.t).toBe("string");
  });
});

describe("withTransaction", () => {
  it("commits when the callback resolves", async () => {
    const result = await withTransaction(db, async (client) => {
      const { rows } = await client.query<{ n: number }>("SELECT 1::int AS n");
      return rows[0]?.n;
    });

    expect(result).toBe(1);
  });

  it("rolls back every statement when the callback throws", async () => {
    await withTransaction(db, async (client) => {
      await client.query("CREATE TEMP TABLE tx_probe (id int)");
      await client.query("INSERT INTO tx_probe VALUES (1)");
    }).catch(() => undefined);

    // Publishing an announcement writes recipients, obligations and the
    // notification outbox in one transaction. A partial publish — recipients
    // created but the outbox row missing — would mean an announcement nobody
    // is told about, which is the one failure this system must never produce.
    await expect(
      withTransaction(db, async (client) => {
        await client.query("CREATE TEMP TABLE rollback_probe (id int)");
        await client.query("INSERT INTO rollback_probe VALUES (1)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const { rows } = await db.query<{ exists: boolean }>(
      "SELECT to_regclass('rollback_probe') IS NOT NULL AS exists",
    );
    expect(rows[0]?.exists).toBe(false);
  });
});

/**
 * The pool must survive PostgreSQL closing a connection.
 *
 * A pooled connection that fails while idle — checked in, no query running —
 * has no caller to reject, so `pg` reports it by emitting `error` on the pool
 * itself. `error` is Node's one special event: unhandled, it is rethrown as an
 * uncaught exception and takes the process with it. Without a listener, every
 * ordinary reason PostgreSQL ends a connection was fatal to the whole server —
 * a failover, a restart, an idle-session timeout, an administrator running
 * `pg_terminate_backend`.
 *
 * Run against the old `createDatabase` first, where terminating a pooled
 * connection ends the vitest process with an uncaught exception rather than
 * failing a test.
 */
describe("an idle connection failing", () => {
  const pools: Database[] = [];

  afterEach(async () => {
    while (pools.length > 0) await pools.pop()!.end();
  });

  /** Its own pool per case, so a terminated connection cannot disturb the rest. */
  function poolWith(onIdleError: (error: Error) => void): Database {
    const created = createDatabase(loadConfig(), { onIdleError });
    pools.push(created);
    return created;
  }

  /** Kills `pid` from a separate connection, the way an administrator would. */
  async function terminate(pid: number): Promise<void> {
    const client = new pg.Client({ connectionString: loadConfig().DATABASE_URL });
    await client.connect();
    try {
      await client.query("SELECT pg_terminate_backend($1)", [pid]);
    } finally {
      await client.end();
    }
  }

  /** Checks a connection out, learns its pid, and releases it back to the pool. */
  async function idleBackendPid(pool: Database): Promise<number> {
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      return rows[0]!.pid;
    } finally {
      client.release();
    }
  }

  it("is reported rather than thrown at nobody", async () => {
    const failures: Error[] = [];
    const pool = poolWith((error) => failures.push(error));

    await terminate(await idleBackendPid(pool));

    await expect.poll(() => failures.length, { timeout: 5_000 }).toBeGreaterThan(0);

    // 57P01 — terminating connection due to administrator command. The code is
    // asserted rather than the message, which PostgreSQL localises.
    expect((failures[0] as { code?: string }).code).toBe("57P01");
  });

  it("leaves the pool able to answer the next query", async () => {
    const pool = poolWith(() => undefined);

    await terminate(await idleBackendPid(pool));

    // The pool discards the dead connection and opens another. Retried because
    // the terminated one may still be handed out before the pool notices.
    let result: number | undefined;
    for (let attempt = 0; attempt < 3 && result === undefined; attempt++) {
      try {
        const { rows } = await pool.query<{ n: number }>("SELECT 1 AS n");
        result = rows[0]!.n;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    expect(result).toBe(1);
  });

  it("always has a listener, whoever built the pool", () => {
    // createDatabase attaches one even with no options, so a pool built outside
    // Fastify — by a script, or a test — is not a way to kill the process.
    const bare = createDatabase(loadConfig());
    pools.push(bare);

    expect(bare.listenerCount("error")).toBeGreaterThan(0);
  });
});
