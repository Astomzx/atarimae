import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { SESSION_COOKIE } from "./lib/session.js";
import { queueDueReminders } from "./services/reminders.js";

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
    `TRUNCATE system_settings, notification_outbox, notification_deliveries,
              notifications, push_subscriptions, notification_preferences,
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

const as = (cookie: string) => ({ cookie });

/** Publishes to two members with a deadline the given number of hours away. */
async function publishDueIn(hours: number): Promise<string> {
  const unit = await app.inject({
    method: "POST",
    url: "/api/v1/org-units",
    headers: as(ownerCookie),
    payload: { name: "第一営業所" },
  });
  const unitId = unit.json().id as string;

  for (const [email, name] of [
    ["tanaka@example.test", "田中"],
    ["sato@example.test", "佐藤"],
  ] as [string, string][]) {
    await app.inject({
      method: "POST",
      url: "/api/v1/users",
      headers: as(ownerCookie),
      payload: {
        email,
        displayName: name,
        role: "member",
        password: "member-password-here",
        primaryOrgUnitId: unitId,
      },
    });
  }

  const created = await app.inject({
    method: "POST",
    url: "/api/v1/announcements",
    headers: as(ownerCookie),
    payload: {
      title: "明日の予定",
      body: "朝礼は8時30分から",
      requiresAcknowledgement: true,
      acknowledgementDueAt: new Date(Date.now() + hours * 3600_000).toISOString(),
    },
  });
  const id = created.json().id as string;

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

  // Clear the publish notifications so counts below are unambiguous.
  await app.db.query("DELETE FROM notification_outbox");

  return id;
}

const reminderCount = async () =>
  Number(
    (
      await app.db.query<{ count: string }>(
        "SELECT count(*) FROM notification_outbox WHERE event_type = 'obligation.deadline_reminder_24h'",
      )
    ).rows[0]!.count,
  );

describe("deadline reminders", () => {
  it("queues one per person inside the window", async () => {
    await publishDueIn(12);

    expect(await queueDueReminders(app.db)).toBe(2);
    expect(await reminderCount()).toBe(2);
  });

  it("ignores deadlines beyond the window", async () => {
    await publishDueIn(72);

    expect(await queueDueReminders(app.db)).toBe(0);
  });

  /**
   * One reminder, not sixty. The worker runs every 30 seconds, so this has to
   * be idempotent by construction rather than by scheduling.
   */
  it("does not queue a second reminder on later passes", async () => {
    await publishDueIn(12);

    expect(await queueDueReminders(app.db)).toBe(2);
    expect(await queueDueReminders(app.db)).toBe(0);
    expect(await queueDueReminders(app.db)).toBe(0);
    expect(await reminderCount()).toBe(2);
  });

  it("skips somebody who has already acknowledged", async () => {
    const id = await publishDueIn(12);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "tanaka@example.test", password: "member-password-here" },
    });
    const header = String(login.headers["set-cookie"] ?? "");
    const cookie = `${SESSION_COOKIE}=${new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header)![1]}`;

    await app.inject({
      method: "POST",
      url: `/api/v1/my/announcements/${id}/acknowledge`,
      headers: as(cookie),
      payload: { clientType: "web" },
    });

    // Only 佐藤 still owes anything.
    expect(await queueDueReminders(app.db)).toBe(1);
  });

  /**
   * A message about a deadline that has already gone is not a reminder.
   */
  it("does not remind about a deadline that has passed", async () => {
    await publishDueIn(12);
    await app.db.query(
      "UPDATE announcement_ack_obligations SET due_at = now() - interval '1 hour'",
    );

    expect(await queueDueReminders(app.db)).toBe(0);
  });

  it("skips obligations with no deadline at all", async () => {
    await publishDueIn(12);
    await app.db.query("UPDATE announcement_ack_obligations SET due_at = NULL");

    expect(await queueDueReminders(app.db)).toBe(0);
  });

  it("skips waived obligations and disabled users", async () => {
    await publishDueIn(12);

    const { rows } = await app.db.query<{ id: string }>(
      "SELECT id FROM users WHERE email = 'tanaka@example.test'",
    );
    // Disabling waives the outstanding obligation.
    await app.inject({
      method: "POST",
      url: `/api/v1/users/${rows[0]!.id}/disable`,
      headers: as(ownerCookie),
    });

    expect(await queueDueReminders(app.db)).toBe(1);
  });

  it("re-arms after a re-acknowledgement, because the successor is a new obligation", async () => {
    const id = await publishDueIn(12);

    expect(await queueDueReminders(app.db)).toBe(2);

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
    await app.inject({
      method: "POST",
      url: `/api/v1/announcements/${id}/request-reacknowledgement`,
      headers: as(ownerCookie),
      payload: {},
    });

    // The successors carry the same deadline and have not been reminded about.
    expect(await queueDueReminders(app.db)).toBe(2);
  });
});
