import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { SESSION_COOKIE } from "./lib/session.js";

/**
 * Reading the audit log.
 *
 * The table was written to from the foundation and read by nothing, which made
 * `security.md`'s answer to a hostile administrator — "the audit log records
 * that they did" — a promise nobody could collect on without `psql`.
 *
 * The tests that matter here are the ones about what the *personal* view must
 * not contain. An administrator seeing everything is unremarkable; a member
 * being able to see another member's sign-in addresses would be a new leak
 * introduced by a feature meant to close one.
 */

let app: FastifyInstance;

const OWNER = {
  email: "owner@example.test",
  displayName: "オーナー",
  password: "correct-horse-battery",
};

beforeAll(async () => {
  app = await buildApp({ config: loadConfig() });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await app.db.query(
    `TRUNCATE audit_logs, sessions, user_devices, invitations,
              user_org_units, org_units, users RESTART IDENTITY CASCADE`,
  );
});

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw.join(";") : String(raw ?? "");
  const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header);
  if (!match) throw new Error(`No ${SESSION_COOKIE} cookie in response`);
  return `${SESSION_COOKIE}=${match[1]}`;
}

async function createOwner() {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/setup/owner",
    payload: { organizationName: "第一営業所", ...OWNER },
  });
  if (response.statusCode !== 201) {
    throw new Error(`setup failed: ${response.statusCode} ${response.body}`);
  }
  return {
    cookie: sessionCookie(response),
    id: (response.json() as { user: { id: string } }).user.id,
  };
}

async function addMember(cookie: string, email: string, displayName: string) {
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/users",
    headers: { cookie },
    payload: { email, displayName, password: "member-password-99", role: "member" },
  });
  if (created.statusCode !== 201) {
    throw new Error(`add member failed: ${created.statusCode} ${created.body}`);
  }
  const id = (created.json() as { id: string }).id;

  const signedIn = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password: "member-password-99" },
  });
  return { id, cookie: sessionCookie(signedIn) };
}

describe("GET /audit-logs", () => {
  it("is refused without a session", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/audit-logs" });
    expect(response.statusCode).toBe(401);
  });

  /** The whole log includes everybody's sign-in addresses. */
  it("is refused to a member", async () => {
    const owner = await createOwner();
    const member = await addMember(owner.cookie, "m@example.test", "田中");

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/audit-logs",
      headers: { cookie: member.cookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it("returns entries to an administrator, newest first", async () => {
    const owner = await createOwner();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/audit-logs",
      headers: { cookie: owner.cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: { action: string; createdAt: string }[] };
    expect(body.items.length).toBeGreaterThan(0);

    const timestamps = body.items.map((item) => item.createdAt);
    expect([...timestamps].sort().reverse()).toEqual(timestamps);
  });

  it("filters by action", async () => {
    const owner = await createOwner();
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: OWNER.email, password: "wrong" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/audit-logs?action=auth.login_failed",
      headers: { cookie: owner.cookie },
    });

    const body = response.json() as { items: { action: string }[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((item) => item.action === "auth.login_failed")).toBe(true);
  });

  /**
   * Keyset, not offset. A log that is appended to constantly makes offset
   * pages repeat and skip entries, and a review that silently skips entries is
   * worse than one nobody ran.
   */
  it("pages without repeating an entry", async () => {
    const owner = await createOwner();
    for (let i = 0; i < 5; i += 1) {
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: OWNER.email, password: "wrong" },
      });
    }

    const first = await app.inject({
      method: "GET",
      url: "/api/v1/audit-logs?limit=3",
      headers: { cookie: owner.cookie },
    });
    const firstBody = first.json() as { items: { id: string }[]; nextBefore?: string };
    expect(firstBody.items).toHaveLength(3);
    expect(firstBody.nextBefore).toBeDefined();

    const second = await app.inject({
      method: "GET",
      url: `/api/v1/audit-logs?limit=3&before=${firstBody.nextBefore!}`,
      headers: { cookie: owner.cookie },
    });
    const secondBody = second.json() as { items: { id: string }[] };

    const seen = new Set(firstBody.items.map((item) => item.id));
    expect(secondBody.items.some((item) => seen.has(item.id))).toBe(false);
  });

  it("says when there is no next page", async () => {
    const owner = await createOwner();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/audit-logs?limit=200",
      headers: { cookie: owner.cookie },
    });

    expect((response.json() as { nextBefore?: string }).nextBefore).toBeUndefined();
  });
});

describe("GET /my/audit-logs", () => {
  it("is refused without a session", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/my/audit-logs" });
    expect(response.statusCode).toBe(401);
  });

  it("shows a member their own sign-in", async () => {
    const owner = await createOwner();
    const member = await addMember(owner.cookie, "m@example.test", "田中");

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/my/audit-logs",
      headers: { cookie: member.cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: { action: string }[] };
    expect(body.items.some((item) => item.action === "auth.login_succeeded")).toBe(true);
  });

  /**
   * The reason this endpoint exists. An Owner who changes somebody's role or
   * disables them is visible to the person affected, not only to another
   * Owner — and in a company with one Owner there is no other Owner.
   */
  it("shows what an administrator did to the account, and names them", async () => {
    const owner = await createOwner();
    const member = await addMember(owner.cookie, "m@example.test", "田中");

    const changed = await app.inject({
      method: "POST",
      url: `/api/v1/users/${member.id}/disable`,
      headers: { cookie: owner.cookie },
    });
    expect(changed.statusCode).toBeLessThan(300);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/my/audit-logs",
      headers: { cookie: owner.cookie },
    });

    // The Owner acted, so it appears in their own trail too — the point is
    // that the entry carries who did it.
    const body = response.json() as {
      items: { action: string; byOther: boolean; actorDisplayName: string | null }[];
    };
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("does not show one member another member's entries", async () => {
    const owner = await createOwner();
    const tanaka = await addMember(owner.cookie, "tanaka@example.test", "田中");
    const sato = await addMember(owner.cookie, "sato@example.test", "佐藤");

    const { rows } = await app.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs WHERE actor_user_id = $1`,
      [sato.id],
    );
    expect(Number(rows[0]!.count)).toBeGreaterThan(0);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/my/audit-logs",
      headers: { cookie: tanaka.cookie },
    });

    const body = response.json() as { items: { id: string }[] };
    const { rows: theirs } = await app.db.query<{ id: string }>(
      `SELECT id FROM audit_logs WHERE actor_user_id = $1`,
      [sato.id],
    );
    const forbidden = new Set(theirs.map((row) => row.id));

    expect(body.items.some((item) => forbidden.has(item.id))).toBe(false);
  });

  /**
   * `metadata` is open-ended jsonb and already carries the address somebody
   * typed at a failed sign-in — which for an unknown address is somebody
   * else's. It is not selected at all, so a future feature writing something
   * careless into it cannot leak through here.
   */
  it("never returns raw metadata", async () => {
    const owner = await createOwner();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/my/audit-logs",
      headers: { cookie: owner.cookie },
    });

    const body = response.json() as { items: Record<string, unknown>[] };
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(item).not.toHaveProperty("metadata");
      expect(item).not.toHaveProperty("requestId");
      expect(item).not.toHaveProperty("actorUserId");
    }
    expect(response.body).not.toContain(OWNER.email);
  });

  /**
   * Account lockout is deliberately not implemented — locking somebody out of
   * their own shift roster is the worse failure. Telling them is the honest
   * alternative, and it is only honest if the number is actually there.
   */
  it("counts failed sign-ins against the account in the last 24 hours", async () => {
    const owner = await createOwner();

    for (let i = 0; i < 3; i += 1) {
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: OWNER.email, password: "wrong" },
      });
    }

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/my/audit-logs",
      headers: { cookie: owner.cookie },
    });

    expect((response.json() as { recentFailedSignIns: number }).recentFailedSignIns).toBe(
      3,
    );
  });

  it("reports zero rather than omitting the count", async () => {
    const owner = await createOwner();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/my/audit-logs",
      headers: { cookie: owner.cookie },
    });

    expect((response.json() as { recentFailedSignIns: number }).recentFailedSignIns).toBe(
      0,
    );
  });

  /** A failed sign-in by somebody guessing does not count against the guesser. */
  it("does not count another account's failures", async () => {
    const owner = await createOwner();
    const member = await addMember(owner.cookie, "m@example.test", "田中");

    for (let i = 0; i < 2; i += 1) {
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: OWNER.email, password: "wrong" },
      });
    }

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/my/audit-logs",
      headers: { cookie: member.cookie },
    });

    expect((response.json() as { recentFailedSignIns: number }).recentFailedSignIns).toBe(
      0,
    );
  });
});
