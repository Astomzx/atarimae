import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { SESSION_COOKIE } from "./lib/session.js";

/**
 * The three obligation commands.
 *
 * They exist as separate commands with complementary filters because merging
 * them produces the failure this whole model is built to prevent: an
 * administrator clicks, the interface says success, and nobody is asked.
 */

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
    `TRUNCATE notification_outbox, notification_deliveries, notifications,
              push_subscriptions, notification_preferences,
              announcement_events, announcement_acknowledgements,
              announcement_ack_obligations, announcement_user_due_overrides,
              announcement_personalizations, announcement_recipient_sources,
              announcement_recipients, announcement_targets,
              announcement_target_versions, announcement_content_revisions,
              announcements,
              audit_logs, sessions, user_devices, invitations,
              user_org_units, org_units, users
       RESTART IDENTITY CASCADE`,
  );

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/setup/owner",
    payload: OWNER,
  });
  const header = String(response.headers["set-cookie"] ?? "");
  ownerCookie = `${SESSION_COOKIE}=${new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header)![1]}`;
});

// ---------------------------------------------------------------------------

const as = (cookie: string) => ({ cookie });

async function createUnit(name: string): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/org-units",
    headers: as(ownerCookie),
    payload: { name },
  });
  return r.json().id;
}

async function createMember(email: string, name: string, unitId?: string) {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/users",
    headers: as(ownerCookie),
    payload: {
      email,
      displayName: name,
      role: "member",
      password: "member-password-here",
      ...(unitId ? { primaryOrgUnitId: unitId } : {}),
    },
  });
  return r.json().id as string;
}

async function signIn(email: string): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password: "member-password-here" },
  });
  const header = String(r.headers["set-cookie"] ?? "");
  return `${SESSION_COOKIE}=${new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header)![1]}`;
}

async function createAndPublish(options: {
  requiresAcknowledgement: boolean;
  unitId: string;
}): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/announcements",
    headers: as(ownerCookie),
    payload: {
      title: "明日の予定",
      body: "朝礼は8時30分から",
      requiresAcknowledgement: options.requiresAcknowledgement,
    },
  });
  const id = created.json().id as string;

  const targets = await app.inject({
    method: "PUT",
    url: `/api/v1/announcements/${id}/targets`,
    headers: as(ownerCookie),
    payload: { targets: [{ kind: "org_unit", orgUnitId: options.unitId }] },
  });
  if (targets.statusCode !== 200) throw new Error(`setTargets: ${targets.body}`);

  const published = await app.inject({
    method: "POST",
    url: `/api/v1/announcements/${id}/publish`,
    headers: as(ownerCookie),
  });
  if (published.statusCode !== 200) throw new Error(`publish: ${published.body}`);

  return id;
}

const command = (id: string, name: string, payload: object = {}) =>
  app.inject({
    method: "POST",
    url: `/api/v1/announcements/${id}/${name}`,
    headers: as(ownerCookie),
    payload,
  });

const statistics = async (id: string) =>
  (
    await app.inject({
      method: "GET",
      url: `/api/v1/announcements/${id}/statistics`,
      headers: as(ownerCookie),
    })
  ).json();

async function acknowledge(id: string, email: string) {
  const cookie = await signIn(email);
  return app.inject({
    method: "POST",
    url: `/api/v1/my/announcements/${id}/acknowledge`,
    headers: as(cookie),
    payload: { clientType: "web" },
  });
}

const outboxCount = async (eventType: string) =>
  Number(
    (
      await app.db.query<{ count: string }>(
        "SELECT count(*) FROM notification_outbox WHERE event_type = $1",
        [eventType],
      )
    ).rows[0]!.count,
  );

// ---------------------------------------------------------------------------

describe("assign-obligations", () => {
  /**
   * The gap that the two commands existing separately is meant to close: an
   * announcement published without acknowledgement, later needing it. Nobody
   * holds an obligation, so re-acknowledgement would reach zero people —
   * silently, since its filter requires an existing one.
   */
  it("opens acknowledgement on an announcement published without it", async () => {
    const unitId = await createUnit("第一営業所");
    await createMember("tanaka@example.test", "田中", unitId);
    await createMember("sato@example.test", "佐藤", unitId);

    const id = await createAndPublish({ requiresAcknowledgement: false, unitId });
    expect(await statistics(id)).toMatchObject({ obligationCount: 0 });

    const response = await command(id, "assign-obligations");
    expect(response.statusCode).toBe(200);
    expect(response.json().summary).toMatchObject({ eligibleCount: 2, createdCount: 2 });

    // 0/2, not 0/0 — the difference between "nobody has confirmed yet" and
    // "nobody was ever asked".
    expect(await statistics(id)).toMatchObject({
      obligationCount: 2,
      acknowledgedCount: 0,
    });
    expect(await outboxCount("obligation.assigned")).toBe(2);
  });

  it("skips people who already hold a live obligation", async () => {
    const unitId = await createUnit("営業部");
    await createMember("tanaka@example.test", "田中", unitId);

    const id = await createAndPublish({ requiresAcknowledgement: true, unitId });

    // Everyone already has one from publishing, so this affects nobody.
    const response = await command(id, "assign-obligations");
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: "NO_ELIGIBLE_RECIPIENTS",
      details: { createdCount: 0, skippedExistingActiveCount: 1 },
    });
  });

  it("reports what it skipped rather than succeeding quietly", async () => {
    const unitId = await createUnit("営業部");
    await createMember("tanaka@example.test", "田中", unitId);
    const id = await createAndPublish({ requiresAcknowledgement: true, unitId });

    const body = (await command(id, "assign-obligations")).json();

    // The confirmation dialog needs this breakdown *before* execution, so an
    // administrator can see the operation would do nothing.
    expect(body.details).toMatchObject({
      eligibleCount: 0,
      createdCount: 0,
      skippedExistingActiveCount: 1,
      skippedDisabledCount: 0,
    });
  });

  it("refuses when the announcement is not published", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/announcements",
      headers: as(ownerCookie),
      payload: { title: "下書き", body: "本文", requiresAcknowledgement: true },
    });

    const response = await command(created.json().id, "assign-obligations");
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "ANNOUNCEMENT_NOT_PUBLISHED" });
  });

  it("can re-arm one person after their obligation was waived", async () => {
    const unitId = await createUnit("営業部");
    const tanakaId = await createMember("tanaka@example.test", "田中", unitId);
    await createMember("sato@example.test", "佐藤", unitId);
    const id = await createAndPublish({ requiresAcknowledgement: true, unitId });

    await command(id, "waive-obligations", {
      reason: "temporary_absence",
      userId: tanakaId,
    });
    expect(await statistics(id)).toMatchObject({ obligationCount: 1, waivedCount: 1 });

    const response = await command(id, "assign-obligations", { userId: tanakaId });
    expect(response.statusCode).toBe(200);
    expect(response.json().summary).toMatchObject({ createdCount: 1 });

    expect(await statistics(id)).toMatchObject({ obligationCount: 2 });
  });
});

describe("request-reacknowledgement", () => {
  it("supersedes live obligations and asks again", async () => {
    const unitId = await createUnit("第一営業所");
    await createMember("tanaka@example.test", "田中", unitId);
    await createMember("sato@example.test", "佐藤", unitId);
    const id = await createAndPublish({ requiresAcknowledgement: true, unitId });

    await acknowledge(id, "tanaka@example.test");
    expect(await statistics(id)).toMatchObject({ acknowledgedCount: 1 });

    await app.inject({
      method: "POST",
      url: `/api/v1/announcements/${id}/content`,
      headers: as(ownerCookie),
      payload: {
        title: "明日の予定",
        body: "朝礼は9時からに変更",
        changeKind: "content_major",
        requiresReacknowledgement: true,
      },
    });

    const response = await command(id, "request-reacknowledgement");
    expect(response.json().summary).toMatchObject({ eligibleCount: 2, createdCount: 2 });

    // The count resets because everyone must confirm the new time — but the
    // old acknowledgement still exists as history.
    expect(await statistics(id)).toMatchObject({
      obligationCount: 2,
      acknowledgedCount: 0,
      supersededCount: 2,
    });
    expect(await outboxCount("obligation.reassigned")).toBe(2);
  });

  /**
   * A disabled person cannot sign in, so putting them back in the denominator
   * would make 100% permanently unreachable. Their waived obligation is left
   * alone, and only an explicit assign-obligations can re-arm them.
   */
  it("does not drag a waived or disabled person back into the denominator", async () => {
    const unitId = await createUnit("営業部");
    const tanakaId = await createMember("tanaka@example.test", "田中", unitId);
    await createMember("sato@example.test", "佐藤", unitId);
    const id = await createAndPublish({ requiresAcknowledgement: true, unitId });

    // Disabling waives the outstanding obligation.
    await app.inject({
      method: "POST",
      url: `/api/v1/users/${tanakaId}/disable`,
      headers: as(ownerCookie),
    });

    const response = await command(id, "request-reacknowledgement");
    expect(response.json().summary).toMatchObject({ createdCount: 1 });

    expect(await statistics(id)).toMatchObject({ obligationCount: 1 });
    expect(
      (await statistics(id)).pendingUsers.map(
        (u: { displayName: string }) => u.displayName,
      ),
    ).toEqual(["佐藤"]);
  });

  it("refuses when nobody holds a live obligation", async () => {
    const unitId = await createUnit("営業部");
    await createMember("tanaka@example.test", "田中", unitId);
    const id = await createAndPublish({ requiresAcknowledgement: false, unitId });

    // Nobody has one, so this command reaches zero people — reported rather
    // than succeeding with a count of nothing.
    const response = await command(id, "request-reacknowledgement");
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: "NO_ELIGIBLE_RECIPIENTS",
      details: { skippedNoActiveObligationCount: 1 },
    });
  });

  /**
   * Changing one person's paragraph must not disturb anyone else's confirmed
   * state.
   */
  it("re-asks only the named person, carrying their current paragraph forward", async () => {
    const unitId = await createUnit("第一営業所");
    const tanakaId = await createMember("tanaka@example.test", "田中", unitId);
    await createMember("sato@example.test", "佐藤", unitId);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/announcements",
      headers: as(ownerCookie),
      payload: {
        title: "明日の予定",
        body: "朝礼は8時30分から",
        requiresAcknowledgement: true,
      },
    });
    const id = created.json().id as string;

    await app.inject({
      method: "PUT",
      url: `/api/v1/announcements/${id}/personalizations/${tanakaId}`,
      headers: as(ownerCookie),
      payload: { personalBody: "8:30 第一営業所集合" },
    });
    await app.inject({
      method: "PUT",
      url: `/api/v1/announcements/${id}/targets`,
      headers: as(ownerCookie),
      payload: { targets: [{ kind: "org_unit", orgUnitId: unitId }] },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/announcements/${id}/publish`,
      headers: as(ownerCookie),
    });

    await acknowledge(id, "tanaka@example.test");
    await acknowledge(id, "sato@example.test");
    expect(await statistics(id)).toMatchObject({ acknowledgedCount: 2 });

    // 田中's assignment changes.
    await app.inject({
      method: "PUT",
      url: `/api/v1/announcements/${id}/personalizations/${tanakaId}`,
      headers: as(ownerCookie),
      payload: { personalBody: "9:00 大阪センターへ直行", changeKind: "personal_major" },
    });

    const response = await command(id, "request-reacknowledgement", {
      userId: tanakaId,
    });
    expect(response.json().summary).toMatchObject({ createdCount: 1 });

    // Only 田中 is pending; 佐藤's confirmation is untouched.
    const stats = await statistics(id);
    expect(stats).toMatchObject({ obligationCount: 2, acknowledgedCount: 1 });
    expect(stats.pendingUsers.map((u: { displayName: string }) => u.displayName)).toEqual(
      ["田中"],
    );

    // The successor carries the new paragraph, not a null.
    const { rows } = await app.db.query<{ personal_body: string }>(
      `SELECT p.personal_body
         FROM announcement_ack_obligations o
         JOIN announcement_recipients r ON r.id = o.recipient_id
         JOIN announcement_personalizations p ON p.id = o.personalization_revision_id
        WHERE r.announcement_id = $1 AND r.user_id = $2
          AND o.waived_at IS NULL AND o.superseded_at IS NULL`,
      [id, tanakaId],
    );
    expect(rows[0]?.personal_body).toBe("9:00 大阪センターへ直行");

    expect(await outboxCount("obligation.reassigned")).toBe(1);
  });
});

describe("waive-obligations", () => {
  it("releases outstanding obligations and shrinks the denominator", async () => {
    const unitId = await createUnit("営業部");
    const tanakaId = await createMember("tanaka@example.test", "田中", unitId);
    await createMember("sato@example.test", "佐藤", unitId);
    const id = await createAndPublish({ requiresAcknowledgement: true, unitId });

    const response = await command(id, "waive-obligations", {
      reason: "long_term_leave",
      userId: tanakaId,
    });
    expect(response.json().summary).toMatchObject({ createdCount: 1 });

    expect(await statistics(id)).toMatchObject({ obligationCount: 1, waivedCount: 1 });

    const { rows } = await app.db.query<{ waived_reason: string }>(
      `SELECT o.waived_reason FROM announcement_ack_obligations o
         JOIN announcement_recipients r ON r.id = o.recipient_id
        WHERE r.announcement_id = $1 AND r.user_id = $2`,
      [id, tanakaId],
    );
    expect(rows[0]?.waived_reason).toBe("long_term_leave");
  });

  /**
   * The rule that keeps every reported figure falsifiable. If an administrator
   * could waive a completed acknowledgement, any statistic could be edited
   * after the fact.
   */
  it("never touches an obligation that has been acknowledged", async () => {
    const unitId = await createUnit("営業部");
    await createMember("tanaka@example.test", "田中", unitId);
    const id = await createAndPublish({ requiresAcknowledgement: true, unitId });

    await acknowledge(id, "tanaka@example.test");

    const response = await command(id, "waive-obligations", { reason: "cleanup" });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: "NO_ELIGIBLE_RECIPIENTS",
      details: { skippedAlreadyAcknowledgedCount: 1 },
    });

    // The acknowledgement is still counted.
    expect(await statistics(id)).toMatchObject({
      acknowledgedCount: 1,
      obligationCount: 1,
      waivedCount: 0,
    });
  });

  it("requires a reason", async () => {
    const unitId = await createUnit("営業部");
    await createMember("tanaka@example.test", "田中", unitId);
    const id = await createAndPublish({ requiresAcknowledgement: true, unitId });

    const response = await command(id, "waive-obligations", { reason: "" });
    expect(response.statusCode).toBe(400);
  });
});

describe("the two assignment commands are complementary", () => {
  /**
   * The same population, split by whether a live obligation exists. Neither
   * command can reach the other's people — which is precisely why they are two
   * commands and not one.
   */
  it("cover disjoint sets of people", async () => {
    const unitId = await createUnit("第一営業所");
    const tanakaId = await createMember("tanaka@example.test", "田中", unitId);
    await createMember("sato@example.test", "佐藤", unitId);
    const id = await createAndPublish({ requiresAcknowledgement: true, unitId });

    // 田中 is released, so only 佐藤 holds a live obligation.
    await command(id, "waive-obligations", { reason: "absence", userId: tanakaId });

    // Re-acknowledgement reaches 佐藤 only.
    const reack = await command(id, "request-reacknowledgement");
    expect(reack.json().summary).toMatchObject({
      createdCount: 1,
      skippedNoActiveObligationCount: 1,
    });

    // Assignment reaches 田中 only.
    const assign = await command(id, "assign-obligations");
    expect(assign.json().summary).toMatchObject({
      createdCount: 1,
      skippedExistingActiveCount: 1,
    });

    expect(await statistics(id)).toMatchObject({ obligationCount: 2 });
  });

  it("records every command on the announcement timeline", async () => {
    const unitId = await createUnit("営業部");
    const tanakaId = await createMember("tanaka@example.test", "田中", unitId);
    const id = await createAndPublish({ requiresAcknowledgement: true, unitId });

    await command(id, "waive-obligations", { reason: "absence", userId: tanakaId });
    await command(id, "assign-obligations", { userId: tanakaId });

    const { rows } = await app.db.query<{ event_type: string }>(
      "SELECT event_type FROM announcement_events WHERE announcement_id = $1 ORDER BY created_at",
      [id],
    );

    expect(rows.map((r) => r.event_type)).toEqual(
      expect.arrayContaining([
        "created",
        "targets_changed",
        "published",
        "obligations_waived",
        "obligations_assigned",
      ]),
    );
  });
});
