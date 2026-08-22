import { expect, test, type APIRequestContext } from "@playwright/test";

import { query, resetDatabase } from "../fixtures/database.js";

/**
 * Administrator-management acceptance scenario.
 *
 * This is the sequence the whole project is an argument for, run end to end
 * against a real server and a real database:
 *
 *   empty database
 *     -> create the Owner
 *     -> Owner creates 第一営業所
 *     -> Owner creates an Admin
 *     -> that Admin signs in with no activation step
 *     -> that Admin creates a Member
 *     -> Member joins 第一営業所
 *     -> Member signs in on a different device
 *     -> Owner disables the Member
 *     -> the Member can no longer sign in, and their history survives
 *
 * It doubles as the script for the demo recording, so the steps are ordered
 * the way they would be narrated.
 *
 * Runs API-first so the server contract and the interface remain independently
 * verified over the same scenario.
 */

const API = "/api/v1";

const OWNER = {
  email: "owner@atarimae.test",
  displayName: "山田 太郎",
  password: "owner-password-strong",
};

const ADMIN = {
  email: "admin@atarimae.test",
  displayName: "佐藤 花子",
  password: "admin-password-strong",
};

const MEMBER = {
  email: "member@atarimae.test",
  displayName: "田中 一郎",
  password: "member-password-strong",
};

const BRANCH_NAME = "第一営業所";

/** A signed-in API client. Each one keeps its own cookie jar, like a browser. */
async function signIn(
  playwright: { request: { newContext: (o: object) => Promise<APIRequestContext> } },
  baseURL: string,
  email: string,
  password: string,
  deviceToken: string,
): Promise<APIRequestContext> {
  const context = await playwright.request.newContext({ baseURL });
  const response = await context.post(`${API}/auth/login`, {
    data: { email, password, deviceToken },
  });
  expect(response.status(), `sign-in for ${email}`).toBe(200);
  return context;
}

// API-only, so viewport is irrelevant. The mobile project excludes this file
// via `testIgnore` — running it twice would repeat identical assertions against
// one shared database, which is a race waiting to happen.
test.describe.configure({ mode: "serial" });

test.describe("an administrator can add an administrator", () => {
  test.beforeAll(async () => {
    await resetDatabase();
  });

  let ownerContext: APIRequestContext;
  let adminContext: APIRequestContext;
  let branchId: string;
  let memberId: string;

  test("1. the organisation starts empty", async ({ request }) => {
    const status = await request.get(`${API}/setup/status`);

    expect(status.status()).toBe(200);
    expect(await status.json()).toEqual({ initialized: false });
  });

  test("2. the first Owner is created and signed in immediately", async ({
    playwright,
    baseURL,
  }) => {
    const context = await playwright.request.newContext({ baseURL: baseURL! });
    const response = await context.post(`${API}/setup/owner`, { data: OWNER });

    expect(response.status()).toBe(201);
    expect(await response.json()).toMatchObject({
      user: { email: OWNER.email, role: "owner" },
    });

    // No separate sign-in step: the session cookie is already set.
    const me = await context.get(`${API}/auth/me`);
    expect(me.status()).toBe(200);

    ownerContext = context;
  });

  test("3. setup refuses to run a second time", async ({ request }) => {
    const response = await request.post(`${API}/setup/owner`, {
      data: { ...OWNER, email: "impostor@atarimae.test" },
    });

    expect(response.status()).toBe(409);
    expect(await response.json()).toMatchObject({ code: "ALREADY_INITIALIZED" });
  });

  test(`4. the Owner creates ${BRANCH_NAME}`, async () => {
    const response = await ownerContext.post(`${API}/org-units`, {
      data: { name: BRANCH_NAME, kind: "branch" },
    });

    expect(response.status()).toBe(201);
    const unit = await response.json();
    expect(unit).toMatchObject({ name: BRANCH_NAME, kind: "branch", memberCount: 0 });

    branchId = unit.id;
  });

  /**
   * The central claim. One ordinary endpoint, one ordinary permission check.
   */
  test("5. the Owner creates an Admin", async () => {
    const response = await ownerContext.post(`${API}/users`, {
      data: { ...ADMIN, role: "admin" },
    });

    expect(response.status()).toBe(201);
    expect(await response.json()).toMatchObject({ email: ADMIN.email, role: "admin" });
  });

  test("6. that Admin signs in with no activation step and no vendor", async ({
    playwright,
    baseURL,
  }) => {
    adminContext = await signIn(
      playwright,
      baseURL!,
      ADMIN.email,
      ADMIN.password,
      "admin-device-01HQ8XN3K7B2WYZ4",
    );

    const me = await adminContext.get(`${API}/auth/me`);
    expect(await me.json()).toMatchObject({ email: ADMIN.email, role: "admin" });
  });

  test("7. the Admin creates a Member", async () => {
    const response = await adminContext.post(`${API}/users`, {
      data: { ...MEMBER, role: "member" },
    });

    expect(response.status()).toBe(201);
    memberId = (await response.json()).id;
  });

  test(`8. the Admin adds the Member to ${BRANCH_NAME}`, async () => {
    const response = await adminContext.post(`${API}/users/${memberId}/org-units`, {
      data: { orgUnitId: branchId, isPrimary: true },
    });

    expect(response.status()).toBe(200);
    expect((await response.json()).orgUnits).toEqual([
      { id: branchId, name: BRANCH_NAME, isPrimary: true },
    ]);

    const unit = await adminContext.get(`${API}/org-units/${branchId}`);
    expect(await unit.json()).toMatchObject({ memberCount: 1 });
  });

  test("9. the Member signs in on their own device and sees their unit", async ({
    playwright,
    baseURL,
  }) => {
    const memberContext = await signIn(
      playwright,
      baseURL!,
      MEMBER.email,
      MEMBER.password,
      "member-phone-01HQ8XN3K7B2WY",
    );

    const me = await memberContext.get(`${API}/auth/me`);
    expect(await me.json()).toMatchObject({ email: MEMBER.email, role: "member" });

    const self = await memberContext.get(`${API}/users/${memberId}`);
    expect((await self.json()).orgUnits).toEqual([
      { id: branchId, name: BRANCH_NAME, isPrimary: true },
    ]);

    await memberContext.dispose();
  });

  test("10. the same account works on a second device simultaneously", async ({
    playwright,
    baseURL,
  }) => {
    const phone = await signIn(
      playwright,
      baseURL!,
      MEMBER.email,
      MEMBER.password,
      "member-phone-01HQ8XN3K7B2WY",
    );
    const desktop = await signIn(
      playwright,
      baseURL!,
      MEMBER.email,
      MEMBER.password,
      "member-desktop-01HQ8XN3K7B",
    );

    // An account belongs to a person, not to a device.
    expect((await phone.get(`${API}/auth/me`)).status()).toBe(200);
    expect((await desktop.get(`${API}/auth/me`)).status()).toBe(200);

    const sessions = await desktop.get(`${API}/auth/sessions`);
    expect((await sessions.json()).items.length).toBeGreaterThanOrEqual(2);

    await phone.dispose();
    await desktop.dispose();
  });

  test("11. a Member cannot create users", async ({ playwright, baseURL }) => {
    const memberContext = await signIn(
      playwright,
      baseURL!,
      MEMBER.email,
      MEMBER.password,
      "member-phone-01HQ8XN3K7B2WY",
    );

    const attempt = await memberContext.post(`${API}/users`, {
      data: {
        email: "escalation@atarimae.test",
        displayName: "Escalation",
        role: "admin",
        password: "should-not-work-here",
      },
    });

    expect(attempt.status()).toBe(403);
    await memberContext.dispose();
  });

  test("12. an Admin cannot grant the Owner role", async () => {
    const attempt = await adminContext.post(`${API}/users`, {
      data: {
        email: "usurper@atarimae.test",
        displayName: "Usurper",
        role: "owner",
        password: "should-not-be-owner",
      },
    });

    expect(attempt.status()).toBe(403);
    expect(await attempt.json()).toMatchObject({ code: "OWNER_ROLE_REQUIRED" });
  });

  test("13. the Owner disables the Member", async () => {
    const response = await ownerContext.post(`${API}/users/${memberId}/disable`);

    expect(response.status()).toBe(200);
    expect((await response.json()).disabledAt).not.toBeNull();
  });

  test("14. the disabled Member can no longer sign in", async ({ request }) => {
    const response = await request.post(`${API}/auth/login`, {
      data: { email: MEMBER.email, password: MEMBER.password },
    });

    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({ code: "ACCOUNT_DISABLED" });
  });

  /**
   * Disabled is not deleted. Every historical relationship survives, which is
   * what later lets an acknowledgement statistic stay explainable.
   */
  test("15. the disabled Member's history survives intact", async () => {
    const users = await query<{ id: string; disabled_at: string | null }>(
      "SELECT id, disabled_at FROM users WHERE id = $1",
      [memberId],
    );
    expect(users).toHaveLength(1);
    expect(users[0]!.disabled_at).not.toBeNull();

    // The membership row is still there, so "why was this person included in
    // that announcement" remains answerable.
    const memberships = await query<{ left_at: string | null }>(
      "SELECT left_at FROM user_org_units WHERE user_id = $1",
      [memberId],
    );
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.left_at).toBeNull();

    // And every administrative action was recorded.
    const audit = await query<{ action: string }>(
      "SELECT action FROM audit_logs ORDER BY created_at",
    );
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "setup.owner_created",
        "org_unit.created",
        "user.created",
        "user.org_unit_changed",
        "user.disabled",
      ]),
    );
  });

  test("16. the Owner restores the Member, who can sign in again", async () => {
    const restored = await ownerContext.post(`${API}/users/${memberId}/restore`);
    expect(restored.status()).toBe(200);
    expect((await restored.json()).disabledAt).toBeNull();
  });

  test.afterAll(async () => {
    await ownerContext?.dispose();
    await adminContext?.dispose();
  });
});
