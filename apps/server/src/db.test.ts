import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
