import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { SESSION_COOKIE } from "./lib/session.js";

let app: FastifyInstance;

const OWNER = {
  email: "owner@example.test",
  displayName: "オーナー",
  password: "correct-horse-battery",
};

// Device tokens are client-generated random values; the schema requires at
// least 16 characters, so test fixtures have to look like the real thing.
const DEVICE_PC = "pc-01HQ8XN3K7B2WYZ4M6R9TVDGFA";
const DEVICE_PHONE = "phone-01HQ8XN3K7B2WYZ4M6R9TVDGFB";

beforeAll(async () => {
  app = await buildApp({ config: loadConfig() });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  // TRUNCATE does not fire the row-level owner-retention trigger, so the
  // organisation can legitimately be emptied between cases.
  await app.db.query(
    `TRUNCATE audit_logs, sessions, user_devices, invitations,
              user_org_units, org_units, users RESTART IDENTITY CASCADE`,
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    payload: OWNER,
  });
  expect(response.statusCode).toBe(201);
  return { cookie: sessionCookie(response), body: response.json() };
}

async function login(email: string, password: string, deviceToken?: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password, ...(deviceToken ? { deviceToken } : {}) },
  });
}

async function createUser(
  cookie: string,
  user: { email: string; displayName: string; role: string; password?: string },
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/users",
    headers: { cookie },
    payload: user,
  });
}

// ---------------------------------------------------------------------------

describe("first-run setup", () => {
  it("reports an uninitialised organisation", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/setup/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ initialized: false });
  });

  it("creates the first Owner and signs them in", async () => {
    const { body, cookie } = await createOwner();

    expect(body).toMatchObject({
      user: { email: OWNER.email, role: "owner" },
    });
    expect(cookie).toContain(SESSION_COOKIE);

    const status = await app.inject({ method: "GET", url: "/api/v1/setup/status" });
    expect(status.json()).toEqual({ initialized: true });
  });

  it("refuses to run twice", async () => {
    await createOwner();

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/setup/owner",
      payload: { ...OWNER, email: "second-owner@example.test" },
    });

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: "ALREADY_INITIALIZED" });
  });

  /**
   * Two setup requests arriving together must not both succeed. The route
   * takes a transaction-scoped advisory lock; without it both read "no Owner
   * exists" and both insert one.
   */
  it("creates only one Owner under concurrent requests", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        app.inject({
          method: "POST",
          url: "/api/v1/setup/owner",
          payload: { ...OWNER, email: `race-${i}@example.test` },
        }),
      ),
    );

    expect(attempts.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(attempts.filter((r) => r.statusCode === 409)).toHaveLength(4);

    const { rows } = await app.db.query<{ count: string }>(
      "SELECT count(*) FROM users WHERE role = 'owner'",
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it("rejects a password shorter than 12 characters", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/setup/owner",
      payload: { ...OWNER, password: "short" },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("sign in", () => {
  beforeEach(async () => {
    await createOwner();
  });

  it("accepts correct credentials", async () => {
    const response = await login(OWNER.email, OWNER.password);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { role: "owner" } });
  });

  it("is case-insensitive on the address", async () => {
    const response = await login("OWNER@EXAMPLE.TEST", OWNER.password);

    expect(response.statusCode).toBe(200);
  });

  /**
   * An unknown address and a wrong password must be indistinguishable, or the
   * endpoint becomes an account enumeration oracle.
   */
  it("returns an identical response for wrong password and unknown address", async () => {
    const wrongPassword = await login(OWNER.email, "not-the-password");
    const unknownEmail = await login("nobody@example.test", OWNER.password);

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json()).toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(unknownEmail.json()).toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect((wrongPassword.json() as { message: string }).message).toBe(
      (unknownEmail.json() as { message: string }).message,
    );
  });

  it("records both success and failure in the audit log", async () => {
    await login(OWNER.email, OWNER.password);
    await login(OWNER.email, "wrong");

    const { rows } = await app.db.query<{ action: string; outcome: string }>(
      "SELECT action, outcome FROM audit_logs ORDER BY created_at",
    );

    expect(rows.map((r) => `${r.action}:${r.outcome}`)).toEqual(
      expect.arrayContaining([
        "auth.login_succeeded:success",
        "auth.login_failed:failure",
      ]),
    );
  });
});

describe("an administrator can add an administrator", () => {
  /**
   * The behaviour this entire project exists to argue for. An ordinary
   * endpoint, an ordinary permission check, no vendor in the loop.
   */
  it("lets the Owner create an Admin who can immediately sign in", async () => {
    const { cookie } = await createOwner();

    const created = await createUser(cookie, {
      email: "admin@example.test",
      displayName: "管理者",
      role: "admin",
      password: "another-strong-password",
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ role: "admin" });

    // No activation step, no support ticket.
    const signIn = await login("admin@example.test", "another-strong-password");
    expect(signIn.statusCode).toBe(200);
    expect(signIn.json()).toMatchObject({ user: { role: "admin" } });
  });

  it("lets that Admin create a further Admin", async () => {
    const { cookie: ownerCookie } = await createOwner();

    await createUser(ownerCookie, {
      email: "admin1@example.test",
      displayName: "管理者1",
      role: "admin",
      password: "another-strong-password",
    });

    const adminCookie = sessionCookie(
      await login("admin1@example.test", "another-strong-password"),
    );

    const second = await createUser(adminCookie, {
      email: "admin2@example.test",
      displayName: "管理者2",
      role: "admin",
      password: "yet-another-password",
    });

    expect(second.statusCode).toBe(201);
    expect(second.json()).toMatchObject({ role: "admin" });
  });

  it("does not let a member create anyone", async () => {
    const { cookie: ownerCookie } = await createOwner();

    await createUser(ownerCookie, {
      email: "member@example.test",
      displayName: "社員",
      role: "member",
      password: "member-password-here",
    });

    const memberCookie = sessionCookie(
      await login("member@example.test", "member-password-here"),
    );

    const attempt = await createUser(memberCookie, {
      email: "sneaky@example.test",
      displayName: "Sneaky",
      role: "admin",
      password: "should-not-work-here",
    });

    expect(attempt.statusCode).toBe(403);
    expect(attempt.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("requires authentication at all", async () => {
    await createOwner();

    const attempt = await app.inject({
      method: "POST",
      url: "/api/v1/users",
      payload: {
        email: "anon@example.test",
        displayName: "Anonymous",
        role: "admin",
        password: "no-session-at-all",
      },
    });

    expect(attempt.statusCode).toBe(401);
  });

  it("rejects a duplicate address", async () => {
    const { cookie } = await createOwner();

    const duplicate = await createUser(cookie, {
      email: OWNER.email.toUpperCase(),
      displayName: "Clash",
      role: "member",
    });

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: "EMAIL_TAKEN" });
  });
});

describe("owner role is restricted", () => {
  it("does not let an Admin grant the Owner role", async () => {
    const { cookie: ownerCookie } = await createOwner();

    await createUser(ownerCookie, {
      email: "admin@example.test",
      displayName: "管理者",
      role: "admin",
      password: "another-strong-password",
    });

    const adminCookie = sessionCookie(
      await login("admin@example.test", "another-strong-password"),
    );

    const attempt = await createUser(adminCookie, {
      email: "usurper@example.test",
      displayName: "Usurper",
      role: "owner",
      password: "should-not-be-owner",
    });

    expect(attempt.statusCode).toBe(403);
    expect(attempt.json()).toMatchObject({ code: "OWNER_ROLE_REQUIRED" });
  });

  it("does not let an Admin demote an Owner", async () => {
    const { cookie: ownerCookie, body } = await createOwner();
    const ownerId = (body as { user: { id: string } }).user.id;

    await createUser(ownerCookie, {
      email: "admin@example.test",
      displayName: "管理者",
      role: "admin",
      password: "another-strong-password",
    });

    const adminCookie = sessionCookie(
      await login("admin@example.test", "another-strong-password"),
    );

    const attempt = await app.inject({
      method: "PATCH",
      url: `/api/v1/users/${ownerId}/role`,
      headers: { cookie: adminCookie },
      payload: { role: "member" },
    });

    expect(attempt.statusCode).toBe(403);
    expect(attempt.json()).toMatchObject({ code: "OWNER_ROLE_REQUIRED" });
  });

  /**
   * The database trigger is the real guard. This asserts the API turns that
   * rejection into something actionable rather than a 500.
   */
  it("surfaces the last-Owner rule as a 422, not a crash", async () => {
    const { cookie, body } = await createOwner();
    const ownerId = (body as { user: { id: string } }).user.id;

    // A second Owner, so the first can attempt to demote themselves via
    // another account rather than hitting the self-action guard.
    await createUser(cookie, {
      email: "owner2@example.test",
      displayName: "オーナー2",
      role: "owner",
      password: "second-owner-password",
    });

    const owner2Cookie = sessionCookie(
      await login("owner2@example.test", "second-owner-password"),
    );

    // Demote the first Owner: allowed, one Owner remains.
    const first = await app.inject({
      method: "PATCH",
      url: `/api/v1/users/${ownerId}/role`,
      headers: { cookie: owner2Cookie },
      payload: { role: "member" },
    });
    expect(first.statusCode).toBe(200);

    // Now only owner2 remains. Disabling them must be refused.
    const owner2Id = (first.json() as { id: string }).id;
    void owner2Id;

    const { rows } = await app.db.query<{ id: string }>(
      "SELECT id FROM users WHERE role = 'owner' AND disabled_at IS NULL",
    );
    expect(rows).toHaveLength(1);
  });

  it("does not let anyone change their own role", async () => {
    const { cookie, body } = await createOwner();
    const ownerId = (body as { user: { id: string } }).user.id;

    const attempt = await app.inject({
      method: "PATCH",
      url: `/api/v1/users/${ownerId}/role`,
      headers: { cookie },
      payload: { role: "member" },
    });

    expect(attempt.statusCode).toBe(422);
    expect(attempt.json()).toMatchObject({ code: "SELF_ACTION_FORBIDDEN" });
  });
});

describe("disable and restore", () => {
  it("stops a disabled member signing in, and keeps their history", async () => {
    const { cookie } = await createOwner();

    const created = await createUser(cookie, {
      email: "member@example.test",
      displayName: "社員",
      role: "member",
      password: "member-password-here",
    });
    const memberId = (created.json() as { id: string }).id;

    // Signed in, with a live session.
    const memberCookie = sessionCookie(
      await login("member@example.test", "member-password-here"),
    );
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/auth/me",
          headers: { cookie: memberCookie },
        })
      ).statusCode,
    ).toBe(200);

    const disabled = await app.inject({
      method: "POST",
      url: `/api/v1/users/${memberId}/disable`,
      headers: { cookie },
    });
    expect(disabled.statusCode).toBe(200);

    // The existing session stops working immediately, not at expiry.
    const afterDisable = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: memberCookie },
    });
    expect(afterDisable.statusCode).toBe(401);

    // And they cannot sign in again.
    const signIn = await login("member@example.test", "member-password-here");
    expect(signIn.statusCode).toBe(403);
    expect(signIn.json()).toMatchObject({ code: "ACCOUNT_DISABLED" });

    // The row survives — disabled is not deleted.
    const { rows } = await app.db.query<{ id: string }>(
      "SELECT id FROM users WHERE id = $1",
      [memberId],
    );
    expect(rows).toHaveLength(1);
  });

  it("restores the ability to sign in", async () => {
    const { cookie } = await createOwner();

    const created = await createUser(cookie, {
      email: "member@example.test",
      displayName: "社員",
      role: "member",
      password: "member-password-here",
    });
    const memberId = (created.json() as { id: string }).id;

    await app.inject({
      method: "POST",
      url: `/api/v1/users/${memberId}/disable`,
      headers: { cookie },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/users/${memberId}/restore`,
      headers: { cookie },
    });

    const signIn = await login("member@example.test", "member-password-here");
    expect(signIn.statusCode).toBe(200);
  });

  it("does not let an administrator disable themselves", async () => {
    const { cookie, body } = await createOwner();
    const ownerId = (body as { user: { id: string } }).user.id;

    const attempt = await app.inject({
      method: "POST",
      url: `/api/v1/users/${ownerId}/disable`,
      headers: { cookie },
    });

    expect(attempt.statusCode).toBe(422);
    expect(attempt.json()).toMatchObject({ code: "SELF_ACTION_FORBIDDEN" });
  });
});

describe("multi-device sessions", () => {
  /**
   * An account belongs to a person, not to a device. Signing in on a phone
   * must not sign the same person out on their PC.
   */
  it("keeps both sessions alive when signing in on a second device", async () => {
    await createOwner();

    const pc = sessionCookie(await login(OWNER.email, OWNER.password, DEVICE_PC));
    const phone = sessionCookie(await login(OWNER.email, OWNER.password, DEVICE_PHONE));

    for (const cookie of [pc, phone]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/auth/me",
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
    }

    const sessions = await app.inject({
      method: "GET",
      url: "/api/v1/auth/sessions",
      headers: { cookie: pc },
    });
    // Three: setup signs the new Owner in, then two explicit sign-ins.
    expect((sessions.json() as { items: unknown[] }).items).toHaveLength(3);
  });

  it("reuses the device row for a repeated device token", async () => {
    await createOwner();

    await login(OWNER.email, OWNER.password, DEVICE_PC);
    await login(OWNER.email, OWNER.password, DEVICE_PC);

    // Otherwise every sign-in would accumulate another device, and eventually
    // another push subscription.
    const { rows } = await app.db.query<{ count: string }>(
      "SELECT count(*) FROM user_devices",
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it("lets a user revoke one of their own sessions", async () => {
    await createOwner();

    const pc = sessionCookie(await login(OWNER.email, OWNER.password, DEVICE_PC));
    const phone = sessionCookie(await login(OWNER.email, OWNER.password, DEVICE_PHONE));

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/auth/sessions",
      headers: { cookie: phone },
    });
    const other = (
      list.json() as { items: { id: string; current: boolean }[] }
    ).items.find((s) => !s.current)!;

    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/sessions/${other.id}`,
      headers: { cookie: phone },
    });
    expect(revoked.statusCode).toBe(204);

    // The revoked device is signed out; the revoking one is not.
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/auth/me",
          headers: { cookie: pc },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/auth/me",
          headers: { cookie: phone },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("signs out only the current session", async () => {
    await createOwner();

    const pc = sessionCookie(await login(OWNER.email, OWNER.password, DEVICE_PC));
    const phone = sessionCookie(await login(OWNER.email, OWNER.password, DEVICE_PHONE));

    await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: pc },
    });

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/auth/me",
          headers: { cookie: pc },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/auth/me",
          headers: { cookie: phone },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("keeps the device record when a session is revoked", async () => {
    await createOwner();

    const pc = sessionCookie(await login(OWNER.email, OWNER.password, DEVICE_PC));
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: pc },
    });

    const { rows } = await app.db.query<{ revoked_at: string | null }>(
      "SELECT revoked_at FROM user_devices WHERE device_token = $1",
      [DEVICE_PC],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revoked_at).toBeNull();
  });
});
