import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { SESSION_COOKIE } from "./lib/session.js";

let app: FastifyInstance;
let ownerCookie: string;
let ownerId: string;

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
  ownerId = response.json().user.id;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const as = (cookie: string) => ({ cookie });

async function createUnit(name: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/org-units",
    headers: as(ownerCookie),
    payload: { name },
  });
  return response.json().id;
}

async function createMember(
  email: string,
  displayName: string,
  orgUnitId?: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/users",
    headers: as(ownerCookie),
    payload: {
      email,
      displayName,
      role: "member",
      password: "member-password-here",
      ...(orgUnitId ? { primaryOrgUnitId: orgUnitId } : {}),
    },
  });
  return response.json().id;
}

async function signIn(email: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password: "member-password-here" },
  });
  const header = String(response.headers["set-cookie"] ?? "");
  return `${SESSION_COOKIE}=${new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header)![1]}`;
}

async function createDraft(
  options: { requiresAcknowledgement?: boolean; dueAt?: string } = {},
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/announcements",
    headers: as(ownerCookie),
    payload: {
      title: "明日の予定",
      body: "朝礼は8時30分から。全員参加してください。",
      requiresAcknowledgement: options.requiresAcknowledgement ?? true,
      ...(options.dueAt ? { acknowledgementDueAt: options.dueAt } : {}),
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id;
}

async function setTargets(id: string, targets: unknown[]) {
  const response = await app.inject({
    method: "PUT",
    url: `/api/v1/announcements/${id}/targets`,
    headers: as(ownerCookie),
    payload: { targets },
  });
  // Fail here rather than three assertions later with a confusing NO_TARGETS.
  if (response.statusCode !== 200) {
    throw new Error(`setTargets failed: ${response.statusCode} ${response.body}`);
  }
  return response;
}

async function publish(id: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/announcements/${id}/publish`,
    headers: as(ownerCookie),
  });
}

async function statistics(id: string) {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/announcements/${id}/statistics`,
    headers: as(ownerCookie),
  });
  return response.json();
}

const countOf = async (sql: string, params: unknown[] = []) =>
  Number((await app.db.query<{ count: string }>(sql, params)).rows[0]!.count);

// ---------------------------------------------------------------------------

describe("authoring", () => {
  it("creates a draft that nobody can see yet", async () => {
    const id = await createDraft();

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/announcements/${id}`,
      headers: as(ownerCookie),
    });
    expect(detail.json()).toMatchObject({ status: "draft", resolvedUserCount: 0 });

    // A member's own list is empty: nothing is published.
    const memberId = await createMember("tanaka@example.test", "田中");
    void memberId;
    const memberCookie = await signIn("tanaka@example.test");
    const mine = await app.inject({
      method: "GET",
      url: "/api/v1/my/announcements",
      headers: as(memberCookie),
    });
    expect(mine.json().items).toHaveLength(0);
  });

  it("refuses to publish with no targets", async () => {
    const id = await createDraft();

    const response = await publish(id);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "NO_TARGETS" });
  });

  /**
   * Publishing to an empty department is always a mistake. Refusing is far
   * kinder than a published announcement showing 0/0 forever.
   */
  it("refuses to publish when the targets contain nobody", async () => {
    const unitId = await createUnit("空の部署");
    const id = await createDraft();
    await setTargets(id, [{ kind: "org_unit", orgUnitId: unitId }]);

    const response = await publish(id);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "NO_RESOLVED_RECIPIENTS" });
  });

  it("refuses to publish twice", async () => {
    const unitId = await createUnit("営業部");
    await createMember("tanaka@example.test", "田中", unitId);
    const id = await createDraft();
    await setTargets(id, [{ kind: "org_unit", orgUnitId: unitId }]);

    expect((await publish(id)).statusCode).toBe(200);

    const second = await publish(id);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: "ANNOUNCEMENT_ALREADY_PUBLISHED" });
  });
});

describe("publishing", () => {
  it("creates a recipient snapshot, obligations and queued notifications together", async () => {
    const unitId = await createUnit("第一営業所");
    await createMember("tanaka@example.test", "田中", unitId);
    await createMember("sato@example.test", "佐藤", unitId);

    const id = await createDraft({ requiresAcknowledgement: true });
    await setTargets(id, [{ kind: "org_unit", orgUnitId: unitId }]);

    const response = await publish(id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      recipientsCreated: 2,
      obligations: { createdCount: 2, eligibleCount: 2 },
      notificationsQueued: 2,
    });

    // Every part landed. This is the whole point of doing it in one
    // transaction: an announcement that is published but notifies nobody must
    // be impossible.
    expect(
      await countOf(
        "SELECT count(*) FROM announcement_recipients WHERE announcement_id = $1",
        [id],
      ),
    ).toBe(2);
    expect(
      await countOf(
        `SELECT count(*) FROM announcement_ack_obligations o
           JOIN announcement_recipients r ON r.id = o.recipient_id
          WHERE r.announcement_id = $1`,
        [id],
      ),
    ).toBe(2);
    expect(
      await countOf(
        "SELECT count(*) FROM notification_outbox WHERE event_type = 'obligation.assigned'",
      ),
    ).toBe(2);
  });

  it("creates no obligations when acknowledgement is not required", async () => {
    const unitId = await createUnit("営業部");
    await createMember("tanaka@example.test", "田中", unitId);

    const id = await createDraft({ requiresAcknowledgement: false });
    await setTargets(id, [{ kind: "org_unit", orgUnitId: unitId }]);

    const response = await publish(id);
    expect(response.json()).toMatchObject({
      recipientsCreated: 1,
      obligations: { createdCount: 0 },
      notificationsQueued: 0,
    });

    // Nobody is being asked for anything, so nobody is notified. This is why
    // obligations carry no `required` flag: they simply do not exist.
    expect(await countOf("SELECT count(*) FROM notification_outbox")).toBe(0);
  });

  /**
   * Somebody covered by a department *and* named individually must produce one
   * recipient with two sources — not two recipients, which would count them
   * twice in the denominator.
   */
  it("deduplicates a person matched by several targets, keeping every source", async () => {
    const unitId = await createUnit("営業部");
    const tanakaId = await createMember("tanaka@example.test", "田中", unitId);

    const id = await createDraft();
    await setTargets(id, [
      { kind: "org_unit", orgUnitId: unitId },
      { kind: "user", userId: tanakaId },
    ]);

    const response = await publish(id);
    expect(response.json().recipientsCreated).toBe(1);

    expect(
      await countOf(
        `SELECT count(*) FROM announcement_recipient_sources s
           JOIN announcement_recipients r ON r.id = s.recipient_id
          WHERE r.announcement_id = $1`,
        [id],
      ),
    ).toBe(2);
  });

  it("excludes disabled users from the snapshot entirely", async () => {
    const unitId = await createUnit("営業部");
    await createMember("tanaka@example.test", "田中", unitId);
    const satoId = await createMember("sato@example.test", "佐藤", unitId);

    await app.inject({
      method: "POST",
      url: `/api/v1/users/${satoId}/disable`,
      headers: as(ownerCookie),
    });

    const id = await createDraft();
    await setTargets(id, [{ kind: "org_unit", orgUnitId: unitId }]);

    const response = await publish(id);
    // A disabled person can neither read nor acknowledge; putting them in the
    // denominator would make 100% unreachable forever.
    expect(response.json().recipientsCreated).toBe(1);
  });

  it("targets everyone with kind=all", async () => {
    await createMember("tanaka@example.test", "田中");
    await createMember("sato@example.test", "佐藤");

    const id = await createDraft();
    await setTargets(id, [{ kind: "all" }]);

    // Two members plus the owner.
    expect((await publish(id)).json().recipientsCreated).toBe(3);
  });

  it("freezes the per-user deadline override onto the obligation", async () => {
    const unitId = await createUnit("営業部");
    const tanakaId = await createMember("tanaka@example.test", "田中", unitId);

    const announcementDue = "2026-08-10T00:00:00.000Z";
    const personalDue = "2026-08-09T00:00:00.000Z";

    const id = await createDraft({ dueAt: announcementDue });
    await app.db.query(
      `INSERT INTO announcement_user_due_overrides
         (announcement_id, user_id, due_at, updated_by)
       VALUES ($1, $2, $3, $4)`,
      [id, tanakaId, personalDue, ownerId],
    );
    await setTargets(id, [{ kind: "org_unit", orgUnitId: unitId }]);
    await publish(id);

    const { rows } = await app.db.query<{ due_at: string }>(
      `SELECT o.due_at FROM announcement_ack_obligations o
         JOIN announcement_recipients r ON r.id = o.recipient_id
        WHERE r.announcement_id = $1 AND r.user_id = $2`,
      [id, tanakaId],
    );

    // The personal override wins, and is stored on the obligation rather than
    // derived later — so editing the announcement default cannot retroactively
    // move it.
    expect(new Date(rows[0]!.due_at).toISOString()).toBe(personalDue);
  });
});

describe("personalization", () => {
  /**
   * A shared plan for tomorrow, plus the paragraph that belongs only to this
   * person. Written while the announcement is still a draft.
   */
  it("delivers the shared body and only the reader's own paragraph", async () => {
    const unitId = await createUnit("第一営業所");
    const tanakaId = await createMember("tanaka@example.test", "田中", unitId);
    await createMember("sato@example.test", "佐藤", unitId);

    const id = await createDraft();

    await app.inject({
      method: "PUT",
      url: `/api/v1/announcements/${id}/personalizations/${tanakaId}`,
      headers: as(ownerCookie),
      payload: { personalBody: "8:30 第一営業所集合" },
    });

    await setTargets(id, [{ kind: "org_unit", orgUnitId: unitId }]);
    await publish(id);

    const tanakaCookie = await signIn("tanaka@example.test");
    const tanakaView = await app.inject({
      method: "GET",
      url: "/api/v1/my/announcements",
      headers: as(tanakaCookie),
    });
    expect(tanakaView.json().items[0]).toMatchObject({
      title: "明日の予定",
      personalBody: "8:30 第一営業所集合",
    });

    const satoCookie = await signIn("sato@example.test");
    const satoView = await app.inject({
      method: "GET",
      url: "/api/v1/my/announcements",
      headers: as(satoCookie),
    });
    // Same announcement, no personal paragraph, and crucially not 田中's.
    expect(satoView.json().items[0]).toMatchObject({ personalBody: null });
  });

  it("keeps personal content written before publish", async () => {
    const unitId = await createUnit("営業部");
    const tanakaId = await createMember("tanaka@example.test", "田中", unitId);
    const id = await createDraft();

    await app.inject({
      method: "PUT",
      url: `/api/v1/announcements/${id}/personalizations/${tanakaId}`,
      headers: as(ownerCookie),
      payload: { personalBody: "初版" },
    });
    await app.inject({
      method: "PUT",
      url: `/api/v1/announcements/${id}/personalizations/${tanakaId}`,
      headers: as(ownerCookie),
      payload: { personalBody: "改訂版", changeKind: "personal_major" },
    });

    // One live version, the earlier one superseded rather than overwritten.
    expect(
      await countOf(
        `SELECT count(*) FROM announcement_personalizations
          WHERE announcement_id = $1 AND superseded_at IS NULL`,
        [id],
      ),
    ).toBe(1);
    expect(
      await countOf(
        "SELECT count(*) FROM announcement_personalizations WHERE announcement_id = $1",
        [id],
      ),
    ).toBe(2);

    await setTargets(id, [{ kind: "org_unit", orgUnitId: unitId }]);
    await publish(id);

    const { rows } = await app.db.query<{ personal_body: string }>(
      `SELECT p.personal_body
         FROM announcement_ack_obligations o
         JOIN announcement_recipients r ON r.id = o.recipient_id
         JOIN announcement_personalizations p ON p.id = o.personalization_revision_id
        WHERE r.announcement_id = $1`,
      [id],
    );
    expect(rows[0]?.personal_body).toBe("改訂版");
  });
});

describe("acknowledgement", () => {
  async function publishedTo(unitName: string, members: [string, string][]) {
    const unitId = await createUnit(unitName);
    for (const [email, name] of members) await createMember(email, name, unitId);
    const id = await createDraft();
    await setTargets(id, [{ kind: "org_unit", orgUnitId: unitId }]);
    await publish(id);
    return id;
  }

  it("records the acknowledgement and shows it in statistics immediately", async () => {
    const id = await publishedTo("第一営業所", [
      ["tanaka@example.test", "田中"],
      ["sato@example.test", "佐藤"],
    ]);

    const before = await statistics(id);
    expect(before).toMatchObject({
      obligationCount: 2,
      acknowledgedCount: 0,
      pendingCount: 2,
    });

    const cookie = await signIn("tanaka@example.test");
    const ack = await app.inject({
      method: "POST",
      url: `/api/v1/my/announcements/${id}/acknowledge`,
      headers: as(cookie),
      payload: { clientType: "web" },
    });
    expect(ack.statusCode).toBe(204);

    const after = await statistics(id);
    expect(after).toMatchObject({
      obligationCount: 2,
      acknowledgedCount: 1,
      pendingCount: 1,
    });
    expect(after.acknowledgedUsers[0]).toMatchObject({ displayName: "田中" });
    expect(after.pendingUsers[0]).toMatchObject({ displayName: "佐藤" });
  });

  it("is idempotent when submitted twice", async () => {
    const id = await publishedTo("営業部", [["tanaka@example.test", "田中"]]);
    const cookie = await signIn("tanaka@example.test");

    const submit = () =>
      app.inject({
        method: "POST",
        url: `/api/v1/my/announcements/${id}/acknowledge`,
        headers: as(cookie),
        payload: { clientType: "web" },
      });

    expect((await submit()).statusCode).toBe(204);
    expect((await submit()).statusCode).toBe(204);

    // Evidence is recorded once. A double tap on a phone must not create two.
    expect(
      await countOf(
        `SELECT count(*) FROM announcement_acknowledgements a
           JOIN announcement_ack_obligations o ON o.id = a.obligation_id
           JOIN announcement_recipients r ON r.id = o.recipient_id
          WHERE r.announcement_id = $1`,
        [id],
      ),
    ).toBe(1);
  });

  it("refuses acknowledgement from somebody who was never a recipient", async () => {
    const id = await publishedTo("営業部", [["tanaka@example.test", "田中"]]);
    await createMember("outsider@example.test", "部外者");
    const cookie = await signIn("outsider@example.test");

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/my/announcements/${id}/acknowledge`,
      headers: as(cookie),
      payload: { clientType: "web" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "NOT_A_RECIPIENT" });
  });

  /**
   * Statistics must survive people leaving. Disabling a user waives their
   * outstanding obligation, and the denominator shrinks — but any
   * acknowledgement they already gave stays counted.
   */
  it("keeps a completed acknowledgement after the person is disabled", async () => {
    const id = await publishedTo("営業部", [
      ["tanaka@example.test", "田中"],
      ["sato@example.test", "佐藤"],
    ]);

    const cookie = await signIn("tanaka@example.test");
    await app.inject({
      method: "POST",
      url: `/api/v1/my/announcements/${id}/acknowledge`,
      headers: as(cookie),
      payload: { clientType: "web" },
    });

    const { rows } = await app.db.query<{ id: string }>(
      "SELECT id FROM users WHERE email = 'tanaka@example.test'",
    );
    await app.inject({
      method: "POST",
      url: `/api/v1/users/${rows[0]!.id}/disable`,
      headers: as(ownerCookie),
    });

    // The obligation is untouched because it was acknowledged; only unfinished
    // ones are waived when an account is disabled.
    const stats = await statistics(id);
    expect(stats.acknowledgedCount).toBe(1);
    expect(stats.obligationCount).toBe(2);
  });
});

describe("statistics are explainable", () => {
  it("counts only live obligations, and lists exactly who is in each figure", async () => {
    const unitId = await createUnit("第一営業所");
    const names: [string, string][] = [
      ["a@example.test", "青木"],
      ["b@example.test", "井上"],
      ["c@example.test", "上田"],
    ];
    for (const [email, name] of names) await createMember(email, name, unitId);

    const id = await createDraft();
    await setTargets(id, [{ kind: "org_unit", orgUnitId: unitId }]);
    await publish(id);

    // 青木 acknowledges.
    const cookie = await signIn("a@example.test");
    await app.inject({
      method: "POST",
      url: `/api/v1/my/announcements/${id}/acknowledge`,
      headers: as(cookie),
      payload: { clientType: "web" },
    });

    // 上田 is waived directly, standing in for a disabled account.
    await app.db.query(
      `UPDATE announcement_ack_obligations o
          SET waived_at = now(), waived_reason = 'user_disabled'
        FROM announcement_recipients r, users u
       WHERE o.recipient_id = r.id AND r.user_id = u.id
         AND r.announcement_id = $1 AND u.email = 'c@example.test'`,
      [id],
    );

    const stats = await statistics(id);

    // Denominator is 2, not 3: the waived person is in neither figure.
    expect(stats).toMatchObject({
      obligationCount: 2,
      acknowledgedCount: 1,
      pendingCount: 1,
      waivedCount: 1,
    });

    expect(
      stats.acknowledgedUsers.map((u: { displayName: string }) => u.displayName),
    ).toEqual(["青木"]);
    expect(stats.pendingUsers.map((u: { displayName: string }) => u.displayName)).toEqual(
      ["井上"],
    );
  });
});

describe("permissions", () => {
  it("does not let a member author or publish", async () => {
    await createMember("tanaka@example.test", "田中");
    const cookie = await signIn("tanaka@example.test");

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/announcements",
      headers: as(cookie),
      payload: { title: "勝手な公告", body: "本文" },
    });
    expect(create.statusCode).toBe(403);
  });

  it("does not let a member read the administrative list or statistics", async () => {
    const id = await createDraft();
    await createMember("tanaka@example.test", "田中");
    const cookie = await signIn("tanaka@example.test");

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/announcements",
          headers: as(cookie),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/announcements/${id}/statistics`,
          headers: as(cookie),
        })
      ).statusCode,
    ).toBe(403);
  });
});
