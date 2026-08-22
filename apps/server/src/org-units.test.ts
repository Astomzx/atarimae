import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { SESSION_COOKIE } from "./lib/session.js";

let app: FastifyInstance;
let ownerCookie: string;

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

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/setup/owner",
    payload: OWNER,
  });
  const header = String(response.headers["set-cookie"] ?? "");
  ownerCookie = `${SESSION_COOKIE}=${new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header)![1]}`;
});

async function createUnit(name: string, cookie = ownerCookie, kind?: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/org-units",
    headers: { cookie },
    payload: { name, ...(kind ? { kind } : {}) },
  });
}

async function createMember(email: string, displayName: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/users",
    headers: { cookie: ownerCookie },
    payload: { email, displayName, role: "member", password: "member-password-here" },
  });
  return response.json().id as string;
}

async function assign(userId: string, orgUnitId: string, isPrimary?: boolean) {
  return app.inject({
    method: "POST",
    url: `/api/v1/users/${userId}/org-units`,
    headers: { cookie: ownerCookie },
    payload: { orgUnitId, ...(isPrimary === undefined ? {} : { isPrimary }) },
  });
}

describe("organisation units", () => {
  it("creates a unit and defaults its kind to department", async () => {
    const response = await createUnit("第一営業所");

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      name: "第一営業所",
      kind: "department",
      memberCount: 0,
      disabledAt: null,
    });
  });

  it("supports branches and teams", async () => {
    expect((await createUnit("神奈川支店", ownerCookie, "branch")).json()).toMatchObject({
      kind: "branch",
    });
    expect((await createUnit("改善チーム", ownerCookie, "team")).json()).toMatchObject({
      kind: "team",
    });
  });

  it("rejects a duplicate active name", async () => {
    await createUnit("総務部");
    const duplicate = await createUnit("総務部");

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: "ORG_UNIT_NAME_TAKEN" });
  });

  it("frees the name once a unit is disabled", async () => {
    const first = (await createUnit("営業部")).json().id as string;

    await app.inject({
      method: "POST",
      url: `/api/v1/org-units/${first}/disable`,
      headers: { cookie: ownerCookie },
    });

    expect((await createUnit("営業部")).statusCode).toBe(201);
  });

  it("does not let a member create a unit", async () => {
    await createMember("member@example.test", "社員");

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "member@example.test", password: "member-password-here" },
    });
    const header = String(login.headers["set-cookie"] ?? "");
    const memberCookie = `${SESSION_COOKIE}=${new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header)![1]}`;

    expect((await createUnit("勝手な部署", memberCookie)).statusCode).toBe(403);
  });

  /**
   * Renaming must not disturb history: announcement targets reference the unit
   * by id, so past acknowledgement statistics stay intact.
   */
  it("renames without changing the id", async () => {
    const id = (await createUnit("旧名称")).json().id as string;

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/v1/org-units/${id}`,
      headers: { cookie: ownerCookie },
      payload: { name: "新名称" },
    });

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ id, name: "新名称" });
  });
});

describe("membership", () => {
  it("keeps the department chat membership identical to the unit", async () => {
    const unitId = (await createUnit("営業部")).json().id as string;
    const userId = await createMember("tanaka@example.test", "田中");

    const { rows: channels } = await app.db.query<{ id: string }>(
      "SELECT id FROM channels WHERE org_unit_id = $1",
      [unitId],
    );
    expect(channels).toHaveLength(1);

    await assign(userId, unitId);
    const { rows: joined } = await app.db.query<{ user_id: string }>(
      `SELECT user_id FROM channel_members
        WHERE channel_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [channels[0]!.id, userId],
    );
    expect(joined).toHaveLength(1);

    await app.inject({
      method: "DELETE",
      url: `/api/v1/users/${userId}/org-units/${unitId}`,
      headers: { cookie: ownerCookie },
    });
    const { rows: left } = await app.db.query<{ left_at: string | null }>(
      `SELECT left_at FROM channel_members
        WHERE channel_id = $1 AND user_id = $2 ORDER BY joined_at DESC LIMIT 1`,
      [channels[0]!.id, userId],
    );
    expect(left[0]?.left_at).not.toBeNull();
  });

  it("archives and restores the same department chat with its history", async () => {
    const unitId = (await createUnit("総務部")).json().id as string;
    const { rows: before } = await app.db.query<{ id: string }>(
      "SELECT id FROM channels WHERE org_unit_id = $1",
      [unitId],
    );

    await app.inject({
      method: "POST",
      url: `/api/v1/org-units/${unitId}/disable`,
      headers: { cookie: ownerCookie },
    });
    const { rows: disabled } = await app.db.query<{ archived_at: string | null }>(
      "SELECT archived_at FROM channels WHERE id = $1",
      [before[0]!.id],
    );
    expect(disabled[0]?.archived_at).not.toBeNull();

    await app.inject({
      method: "POST",
      url: `/api/v1/org-units/${unitId}/restore`,
      headers: { cookie: ownerCookie },
    });
    const { rows: restored } = await app.db.query<{
      id: string;
      archived_at: string | null;
    }>("SELECT id, archived_at FROM channels WHERE org_unit_id = $1", [unitId]);
    expect(restored).toEqual([{ id: before[0]!.id, archived_at: null }]);
  });

  it("adds a member and counts them", async () => {
    const unitId = (await createUnit("第一営業所")).json().id as string;
    const userId = await createMember("tanaka@example.test", "田中");

    const assigned = await assign(userId, unitId, true);

    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().orgUnits).toEqual([
      { id: unitId, name: "第一営業所", isPrimary: true },
    ]);

    const unit = await app.inject({
      method: "GET",
      url: `/api/v1/org-units/${unitId}`,
      headers: { cookie: ownerCookie },
    });
    expect(unit.json()).toMatchObject({ memberCount: 1 });
  });

  it("allows several units but demotes the previous primary", async () => {
    const sales = (await createUnit("営業部")).json().id as string;
    const branch = (await createUnit("第一営業所")).json().id as string;
    const userId = await createMember("tanaka@example.test", "田中");

    await assign(userId, sales, true);
    const result = await assign(userId, branch, true);

    const units = result.json().orgUnits as {
      id: string;
      isPrimary: boolean;
    }[];

    expect(units).toHaveLength(2);
    expect(units.filter((u) => u.isPrimary)).toHaveLength(1);
    expect(units.find((u) => u.isPrimary)?.id).toBe(branch);
  });

  it("rejects adding the same member twice", async () => {
    const unitId = (await createUnit("総務部")).json().id as string;
    const userId = await createMember("sato@example.test", "佐藤");

    await assign(userId, unitId);
    const again = await assign(userId, unitId);

    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "ALREADY_ASSIGNED" });
  });

  it("refuses to add anyone to a disabled unit", async () => {
    const unitId = (await createUnit("廃止部署")).json().id as string;
    const userId = await createMember("suzuki@example.test", "鈴木");

    await app.inject({
      method: "POST",
      url: `/api/v1/org-units/${unitId}/disable`,
      headers: { cookie: ownerCookie },
    });

    const attempt = await assign(userId, unitId);
    expect(attempt.statusCode).toBe(422);
    expect(attempt.json()).toMatchObject({ code: "ORG_UNIT_DISABLED" });
  });

  /**
   * Departure is recorded, not deleted. It must stay possible to explain why
   * somebody was included in a past announcement.
   */
  it("records a departure date instead of deleting the row", async () => {
    const unitId = (await createUnit("営業部")).json().id as string;
    const userId = await createMember("tanaka@example.test", "田中");
    await assign(userId, unitId);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/users/${userId}/org-units/${unitId}`,
      headers: { cookie: ownerCookie },
    });
    expect(removed.statusCode).toBe(204);

    const { rows } = await app.db.query<{ left_at: string | null }>(
      "SELECT left_at FROM user_org_units WHERE user_id = $1 AND org_unit_id = $2",
      [userId, unitId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.left_at).not.toBeNull();
  });

  it("lets a departed member rejoin", async () => {
    const unitId = (await createUnit("営業部")).json().id as string;
    const userId = await createMember("tanaka@example.test", "田中");

    await assign(userId, unitId);
    await app.inject({
      method: "DELETE",
      url: `/api/v1/users/${userId}/org-units/${unitId}`,
      headers: { cookie: ownerCookie },
    });

    expect((await assign(userId, unitId)).statusCode).toBe(200);
  });

  it("filters the member list by unit", async () => {
    const sales = (await createUnit("営業部")).json().id as string;
    const admin = (await createUnit("総務部")).json().id as string;

    const tanaka = await createMember("tanaka@example.test", "田中");
    await createMember("sato@example.test", "佐藤");
    await assign(tanaka, sales, true);

    const inSales = await app.inject({
      method: "GET",
      url: `/api/v1/users?orgUnitId=${sales}`,
      headers: { cookie: ownerCookie },
    });
    expect(inSales.json().items).toHaveLength(1);
    expect(inSales.json().items[0]).toMatchObject({ displayName: "田中" });

    const inAdmin = await app.inject({
      method: "GET",
      url: `/api/v1/users?orgUnitId=${admin}`,
      headers: { cookie: ownerCookie },
    });
    expect(inAdmin.json().items).toHaveLength(0);
  });

  it("excludes disabled members from the unit count", async () => {
    const unitId = (await createUnit("営業部")).json().id as string;
    const userId = await createMember("tanaka@example.test", "田中");
    await assign(userId, unitId);

    await app.inject({
      method: "POST",
      url: `/api/v1/users/${userId}/disable`,
      headers: { cookie: ownerCookie },
    });

    const unit = await app.inject({
      method: "GET",
      url: `/api/v1/org-units/${unitId}`,
      headers: { cookie: ownerCookie },
    });
    expect(unit.json()).toMatchObject({ memberCount: 0 });
  });

  it("writes an audit entry for every membership change", async () => {
    const unitId = (await createUnit("営業部")).json().id as string;
    const userId = await createMember("tanaka@example.test", "田中");
    await assign(userId, unitId, true);

    const { rows } = await app.db.query<{ action: string }>(
      "SELECT action FROM audit_logs ORDER BY created_at",
    );

    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        "setup.owner_created",
        "org_unit.created",
        "user.created",
        "user.org_unit_changed",
      ]),
    );
  });
});
