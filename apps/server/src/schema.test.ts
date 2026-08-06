import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";
import { createDatabase, type Database, type DatabaseClient } from "./db.js";

let db: Database;

beforeAll(() => {
  db = createDatabase(loadConfig());
});

afterAll(async () => {
  await db.end();
});

/**
 * Runs `fn` in a transaction that is always rolled back, so cases stay
 * independent without truncating tables between them.
 *
 * `SET CONSTRAINTS ALL IMMEDIATE` matters: the owner-retention trigger is
 * DEFERRABLE INITIALLY DEFERRED, so it would normally only fire at COMMIT —
 * which never happens here. Forcing immediate evaluation is what lets a rolled
 * back transaction still prove the constraint rejects the write.
 */
async function inRollback<T>(fn: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    return await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

/** Inserts an active user and returns its id. */
async function insertUser(
  client: DatabaseClient,
  fields: { email: string; displayName?: string; role?: string },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO users (email, display_name, role)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [fields.email, fields.displayName ?? "Test User", fields.role ?? "member"],
  );
  return rows[0]!.id;
}

describe("owner retention", () => {
  /**
   * The product's central claim is that an administrator genuinely holds
   * administrative power. An organisation that locks itself out of Owner is
   * precisely the situation it exists to prevent, so this is enforced by the
   * database rather than by application code that a future refactor could
   * route around.
   */
  it("refuses to demote the last active Owner", async () => {
    await inRollback(async (client) => {
      const owner = await insertUser(client, {
        email: "owner-demote@example.test",
        role: "owner",
      });

      await expect(
        client.query("UPDATE users SET role = 'admin' WHERE id = $1", [owner]),
      ).rejects.toThrow(/At least one active Owner must remain/);
    });
  });

  it("refuses to disable the last active Owner", async () => {
    await inRollback(async (client) => {
      const owner = await insertUser(client, {
        email: "owner-disable@example.test",
        role: "owner",
      });

      await expect(
        client.query("UPDATE users SET disabled_at = now() WHERE id = $1", [owner]),
      ).rejects.toThrow(/At least one active Owner must remain/);
    });
  });

  it("allows demoting an Owner while another active Owner exists", async () => {
    await inRollback(async (client) => {
      const first = await insertUser(client, {
        email: "owner-a@example.test",
        role: "owner",
      });
      await insertUser(client, { email: "owner-b@example.test", role: "owner" });

      await client.query("UPDATE users SET role = 'admin' WHERE id = $1", [first]);

      const { rows } = await client.query<{ count: string }>(
        "SELECT count(*) FROM users WHERE role = 'owner' AND disabled_at IS NULL",
      );
      expect(Number(rows[0]!.count)).toBe(1);
    });
  });

  /**
   * Ownership transfer demotes one user and promotes another. Because the
   * trigger is deferred to COMMIT, the order of those two statements does not
   * matter — only the final state must be valid. An immediate trigger would
   * reject the demote-then-promote ordering and force awkward workarounds.
   */
  it("permits ownership transfer in either statement order within one transaction", async () => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const oldOwner = await insertUser(client, {
        email: "transfer-old@example.test",
        role: "owner",
      });
      const successor = await insertUser(client, {
        email: "transfer-new@example.test",
        role: "admin",
      });

      // Demote first — momentarily zero Owners, which deferral tolerates.
      await client.query("UPDATE users SET role = 'admin' WHERE id = $1", [oldOwner]);
      await client.query("UPDATE users SET role = 'owner' WHERE id = $1", [successor]);

      // Reaching here without an exception means the deferred check accepted
      // the end state.
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});

describe("users", () => {
  it("treats email uniqueness as case-insensitive", async () => {
    await inRollback(async (client) => {
      await insertUser(client, { email: "Tanaka@Example.test" });

      await expect(insertUser(client, { email: "tanaka@example.test" })).rejects.toThrow(
        /uq_users_email|duplicate key/,
      );
    });
  });

  it("rejects an anonymized user that is not also disabled", async () => {
    await inRollback(async (client) => {
      const user = await insertUser(client, { email: "anon@example.test" });

      await expect(
        client.query("UPDATE users SET anonymized_at = now() WHERE id = $1", [user]),
      ).rejects.toThrow(/ck_users_anonymized_implies_disabled/);
    });
  });

  it("rejects an empty display name", async () => {
    await inRollback(async (client) => {
      await expect(
        insertUser(client, { email: "blank@example.test", displayName: "   " }),
      ).rejects.toThrow(/ck_users_display_name/);
    });
  });

  it("rejects an unknown role", async () => {
    await inRollback(async (client) => {
      await expect(
        insertUser(client, { email: "role@example.test", role: "superuser" }),
      ).rejects.toThrow(/ck_users_role/);
    });
  });
});

describe("org units and membership", () => {
  async function insertOrgUnit(client: DatabaseClient, name: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      "INSERT INTO org_units (name) VALUES ($1) RETURNING id",
      [name],
    );
    return rows[0]!.id;
  }

  it("rejects two live units with the same name", async () => {
    await inRollback(async (client) => {
      await insertOrgUnit(client, "第一営業所");

      await expect(insertOrgUnit(client, "第一営業所")).rejects.toThrow(
        /uq_org_units_name|duplicate key/,
      );
    });
  });

  it("allows reusing the name of a disabled unit", async () => {
    await inRollback(async (client) => {
      const first = await insertOrgUnit(client, "総務部");
      await client.query("UPDATE org_units SET disabled_at = now() WHERE id = $1", [
        first,
      ]);

      await expect(insertOrgUnit(client, "総務部")).resolves.toBeTruthy();
    });
  });

  it("allows one user in several units but only one primary", async () => {
    await inRollback(async (client) => {
      const user = await insertUser(client, { email: "multi@example.test" });
      const sales = await insertOrgUnit(client, "営業部");
      const branch = await insertOrgUnit(client, "第一営業所");

      await client.query(
        "INSERT INTO user_org_units (user_id, org_unit_id, is_primary) VALUES ($1, $2, true)",
        [user, sales],
      );

      // A second, non-primary membership is fine.
      await client.query(
        "INSERT INTO user_org_units (user_id, org_unit_id, is_primary) VALUES ($1, $2, false)",
        [user, branch],
      );

      // A second primary is not.
      await expect(
        client.query(
          "UPDATE user_org_units SET is_primary = true WHERE user_id = $1 AND org_unit_id = $2",
          [user, branch],
        ),
      ).rejects.toThrow(/uq_user_primary_org_unit|duplicate key/);
    });
  });

  it("allows rejoining a unit the user previously left", async () => {
    await inRollback(async (client) => {
      const user = await insertUser(client, { email: "rejoin@example.test" });
      const unit = await insertOrgUnit(client, "第二営業所");

      await client.query(
        "INSERT INTO user_org_units (user_id, org_unit_id, left_at) VALUES ($1, $2, now())",
        [user, unit],
      );

      await expect(
        client.query(
          "INSERT INTO user_org_units (user_id, org_unit_id) VALUES ($1, $2)",
          [user, unit],
        ),
      ).resolves.toBeTruthy();
    });
  });

  it("rejects a unit that is its own parent", async () => {
    await inRollback(async (client) => {
      const unit = await insertOrgUnit(client, "自己参照");

      await expect(
        client.query("UPDATE org_units SET parent_id = id WHERE id = $1", [unit]),
      ).rejects.toThrow(/ck_org_units_not_own_parent/);
    });
  });
});

describe("invitations", () => {
  async function insertInvitation(
    client: DatabaseClient,
    email: string,
    token: string,
    invitedBy: string,
  ) {
    return client.query(
      `INSERT INTO invitations (email, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, now() + interval '7 days')`,
      [email, token, invitedBy],
    );
  }

  it("allows only one outstanding invitation per address", async () => {
    await inRollback(async (client) => {
      const admin = await insertUser(client, {
        email: "inviter@example.test",
        role: "admin",
      });

      await insertInvitation(client, "new@example.test", "hash-1", admin);

      // Otherwise resending produces several live links, and revoking one
      // leaves the rest working.
      await expect(
        insertInvitation(client, "New@Example.test", "hash-2", admin),
      ).rejects.toThrow(/uq_invitations_pending_email|duplicate key/);
    });
  });

  it("rejects an invitation that is both accepted and revoked", async () => {
    await inRollback(async (client) => {
      const admin = await insertUser(client, {
        email: "inviter2@example.test",
        role: "admin",
      });
      const invitee = await insertUser(client, { email: "invitee@example.test" });

      await insertInvitation(client, "invitee@example.test", "hash-3", admin);

      await expect(
        client.query(
          `UPDATE invitations
              SET accepted_at = now(), accepted_user_id = $1, revoked_at = now()
            WHERE token_hash = 'hash-3'`,
          [invitee],
        ),
      ).rejects.toThrow(/ck_invitations_not_accepted_and_revoked/);
    });
  });
});

describe("devices and sessions", () => {
  it("requires a reason whenever a session is revoked", async () => {
    await inRollback(async (client) => {
      const user = await insertUser(client, { email: "session@example.test" });

      await client.query(
        `INSERT INTO sessions (user_id, session_token_hash, expires_at)
         VALUES ($1, 'token-hash-1', now() + interval '30 days')`,
        [user],
      );

      // An unexplained revocation is useless in an audit trail.
      await expect(
        client.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1", [user]),
      ).rejects.toThrow(/ck_sessions_revoked_reason/);
    });
  });

  /**
   * Devices outlive sessions. Revoking a session must leave the device and its
   * push subscription intact — they are separate concerns, and conflating them
   * produces duplicate push registrations after every sign-out.
   */
  it("keeps the device when its session is revoked", async () => {
    await inRollback(async (client) => {
      const user = await insertUser(client, { email: "device@example.test" });

      const { rows: deviceRows } = await client.query<{ id: string }>(
        `INSERT INTO user_devices (user_id, device_token, device_name)
         VALUES ($1, 'stable-device-token', 'Pixel 7')
         RETURNING id`,
        [user],
      );
      const deviceId = deviceRows[0]!.id;

      await client.query(
        `INSERT INTO sessions (user_id, user_device_id, session_token_hash, expires_at)
         VALUES ($1, $2, 'token-hash-2', now() + interval '30 days')`,
        [user, deviceId],
      );

      await client.query(
        "UPDATE sessions SET revoked_at = now(), revoked_reason = 'user_signed_out' WHERE user_device_id = $1",
        [deviceId],
      );

      const { rows } = await client.query<{ revoked_at: string | null }>(
        "SELECT revoked_at FROM user_devices WHERE id = $1",
        [deviceId],
      );
      expect(rows[0]?.revoked_at).toBeNull();
    });
  });

  it("rejects a duplicate device token for the same user", async () => {
    await inRollback(async (client) => {
      const user = await insertUser(client, { email: "dupdevice@example.test" });

      await client.query(
        "INSERT INTO user_devices (user_id, device_token) VALUES ($1, 'same-token')",
        [user],
      );

      await expect(
        client.query(
          "INSERT INTO user_devices (user_id, device_token) VALUES ($1, 'same-token')",
          [user],
        ),
      ).rejects.toThrow(/uq_user_device_token|duplicate key/);
    });
  });
});

describe("audit logs", () => {
  it("accepts an entry with no actor, for anonymous failures", async () => {
    await inRollback(async (client) => {
      await expect(
        client.query(
          `INSERT INTO audit_logs (action, outcome, metadata)
           VALUES ('auth.login', 'failure', '{"reason":"unknown_email"}'::jsonb)`,
        ),
      ).resolves.toBeTruthy();
    });
  });

  it("rejects an unknown outcome", async () => {
    await inRollback(async (client) => {
      await expect(
        client.query("INSERT INTO audit_logs (action, outcome) VALUES ('x', 'maybe')"),
      ).rejects.toThrow(/ck_audit_logs_outcome/);
    });
  });
});
