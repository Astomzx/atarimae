import pg from "pg";

/**
 * Checks that the servers on the suite's ports are serving the suite's database.
 *
 * `reuseExistingServer: !isCI` decides by port and nothing else. A server left
 * running by an earlier session — a different branch, a different `.env`, this
 * project before the E2E database existed — answers on 3100 and is adopted, and
 * then every spec truncates one database while the browser reads another. The
 * symptom is once again a test failing for reasons that are not about it, which
 * is the failure this whole area was fixed to stop producing.
 *
 * The check is deliberately cheap. It asks the server a question through the
 * same chain the tests use — browser port, Vite proxy, Fastify, PostgreSQL —
 * and then looks in *this suite's* database for the connection that question
 * must have made. A server pointed anywhere else leaves no trace here.
 *
 * It does not prove the server is on the right commit or has the right
 * attachment directory. It proves the one thing that has actually gone wrong.
 */

/** Set by `createDatabase` on every connection the server opens. */
const SERVER_APPLICATION_NAME = "atarimae";

export interface ServerIdentityOptions {
  connectionString: string;
  databaseName: string;
  /**
   * Health URLs, one per server the suite talks to. Each is fetched, so each
   * server is made to touch the database before the check looks for it.
   */
  probeUrls: string[];
  /** Injected by tests. Defaults to asking the database itself. */
  countServerConnections?: (connectionString: string) => Promise<number>;
}

export async function assertServersUseDatabase(
  options: ServerIdentityOptions,
): Promise<void> {
  for (const url of options.probeUrls) {
    let body: { checks?: { database?: string } };
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`answered ${String(response.status)}`);
      }
      body = (await response.json()) as { checks?: { database?: string } };
    } catch (error) {
      throw new Error(
        `${url} did not answer.\n\n` +
          `  ${error instanceof Error ? error.message : String(error)}\n\n` +
          "  The suite's servers should have been started by Playwright before\n" +
          "  this ran. If something else is holding the port, stop it.",
        { cause: error },
      );
    }

    if (body.checks?.database !== "ok") {
      throw new Error(
        `${url} answered, but reports its database as ` +
          `${String(body.checks?.database)} rather than ok.`,
      );
    }
  }

  const count = await (options.countServerConnections ?? countServerConnections)(
    options.connectionString,
  );

  if (count === 0) {
    throw new Error(
      `The server answering on these ports is not using ${options.databaseName}.\n\n` +
        `  ${options.probeUrls.join("\n  ")}\n\n` +
        "  It answered a health check, and that check reached some database —\n" +
        "  just not this one. Almost always a server left running by an earlier\n" +
        "  session: Playwright reuses whatever is on the port, whatever\n" +
        "  environment it was started with.\n\n" +
        "  Stop it and run again. Every spec here truncates this database, so a\n" +
        "  server reading a different one fails tests for reasons that have\n" +
        "  nothing to do with them.",
    );
  }
}

/** How many connections the API server currently holds to this database. */
async function countServerConnections(connectionString: string): Promise<number> {
  const client = new pg.Client({
    connectionString,
    application_name: "atarimae-e2e-identity",
  });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = $1`,
      [SERVER_APPLICATION_NAME],
    );
    return rows[0]?.n ?? 0;
  } finally {
    await client.end();
  }
}
