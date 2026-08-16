import { createECDH, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { SESSION_COOKIE } from "./lib/session.js";
import type { MailMessage, Mailer } from "./services/mailer.js";
import { drainOutbox } from "./services/notification-worker.js";
import type { PushOutcome, PushPayload, PushSender } from "./services/push.js";
import { loadVapidKeys } from "./services/push.js";
import type { PushSubscription } from "./lib/web-push.js";

/**
 * Push as a delivery channel.
 *
 * The tests that matter are about the two channels being independent. Before
 * this, the worker treated "email is disabled" as "this outbox row is done" —
 * so adding push to that shape would have let one preference silently disable
 * a channel it does not name. That is the failure this file is written
 * against, and it is invisible from the outside: the person simply never hears
 * anything, and the queue reports success.
 */

let app: FastifyInstance;
let ownerCookie: string;

const OWNER = {
  email: "owner@example.test",
  displayName: "オーナー",
  password: "correct-horse-battery",
};

function fakeMailer(options: { failWith?: string } = {}) {
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    configured: true,
    send(message) {
      if (options.failWith) return Promise.reject(new Error(options.failWith));
      sent.push(message);
      return Promise.resolve();
    },
  };
  return { mailer, sent };
}

/** A push sender that records rather than sending, and can be told to fail. */
function fakePush(outcomes: PushOutcome[] = []) {
  const sent: { subscription: PushSubscription; payload: PushPayload }[] = [];
  let call = 0;

  const sender: PushSender = {
    publicKey: "test-public-key",
    send(subscription, payload) {
      sent.push({ subscription, payload });
      const outcome = outcomes[call] ?? outcomes[outcomes.length - 1];
      call += 1;
      return Promise.resolve(outcome ?? { status: "sent" });
    },
  };

  return { sender, sent };
}

beforeAll(async () => {
  app = await buildApp({ config: loadConfig() });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await app.db.query(
    `TRUNCATE push_subscriptions, notification_deliveries, notifications,
              notification_outbox, notification_preferences,
              announcement_ack_obligations, announcement_recipients,
              announcement_targets, announcement_target_versions,
              announcement_recipient_sources, announcement_content_revisions,
              announcement_events, announcements,
              system_settings, audit_logs, sessions, user_devices, invitations,
              user_org_units, org_units, users RESTART IDENTITY CASCADE`,
  );

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/setup/owner",
    payload: { organizationName: "第一営業所", ...OWNER },
  });
  const header = String(response.headers["set-cookie"] ?? "");
  ownerCookie = `${SESSION_COOKIE}=${new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header)![1]}`;
});

const as = (cookie: string) => ({ cookie });

/** Publishes to one member and returns their user id. */
async function publishToOneMember(): Promise<string> {
  const unit = await app.inject({
    method: "POST",
    url: "/api/v1/org-units",
    headers: as(ownerCookie),
    payload: { name: "運行課" },
  });
  const unitId = unit.json().id as string;

  const member = await app.inject({
    method: "POST",
    url: "/api/v1/users",
    headers: as(ownerCookie),
    payload: {
      email: "tanaka@example.test",
      displayName: "田中",
      role: "member",
      password: "member-password-here",
      primaryOrgUnitId: unitId,
    },
  });
  const userId = member.json().id as string;

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
    url: `/api/v1/announcements/${id}/targets`,
    headers: as(ownerCookie),
    payload: { targets: [{ kind: "org_unit", orgUnitId: unitId }] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/announcements/${id}/publish`,
    headers: as(ownerCookie),
  });

  return userId;
}

/** Gives a user a device with a live push subscription. */
async function subscribe(userId: string): Promise<string> {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();

  const { rows: device } = await app.db.query<{ id: string }>(
    `INSERT INTO user_devices (user_id, device_token, device_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [userId, `dev-${randomBytes(12).toString("hex")}`, "田中のスマホ"],
  );

  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO push_subscriptions (user_device_id, endpoint, p256dh_key, auth_key)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      device[0]!.id,
      `https://push.example.test/${randomBytes(8).toString("hex")}`,
      ecdh.getPublicKey().toString("base64url"),
      randomBytes(16).toString("base64url"),
    ],
  );
  return rows[0]!.id;
}

const countOf = async (sql: string, params: unknown[] = []) =>
  Number((await app.db.query<{ count: string }>(sql, params)).rows[0]!.count);

describe("push as a second channel", () => {
  it("sends to a subscribed device", async () => {
    const userId = await publishToOneMember();
    await subscribe(userId);

    const { mailer } = fakeMailer();
    const push = fakePush();

    await drainOutbox(app.db, mailer, {
      publicOrigin: "https://atarimae.test",
      push: push.sender,
    });

    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.payload.body).toContain("明日の予定");
  });

  /**
   * The failure this file exists for. Turning email off must not turn push off
   * — one preference silently disabling a channel it does not name is the kind
   * of thing nobody notices until somebody misses a shift.
   */
  it("still pushes when email is disabled", async () => {
    const userId = await publishToOneMember();
    await subscribe(userId);

    await app.db.query(
      `INSERT INTO notification_preferences
         (user_id, event_type, email_enabled, push_enabled)
       VALUES ($1, 'obligation.assigned', false, true)`,
      [userId],
    );

    const { mailer, sent } = fakeMailer();
    const push = fakePush();

    await drainOutbox(app.db, mailer, {
      publicOrigin: "https://atarimae.test",
      push: push.sender,
    });

    expect(sent).toHaveLength(0);
    expect(push.sent).toHaveLength(1);
  });

  it("still emails when push is disabled", async () => {
    const userId = await publishToOneMember();
    await subscribe(userId);

    await app.db.query(
      `INSERT INTO notification_preferences
         (user_id, event_type, email_enabled, push_enabled)
       VALUES ($1, 'obligation.assigned', true, false)`,
      [userId],
    );

    const { mailer, sent } = fakeMailer();
    const push = fakePush();

    await drainOutbox(app.db, mailer, {
      publicOrigin: "https://atarimae.test",
      push: push.sender,
    });

    expect(sent).toHaveLength(1);
    expect(push.sent).toHaveLength(0);
  });

  /** Somebody who never granted permission is not owed a push, or a failure. */
  it("is not a failure when the person has no subscription", async () => {
    await publishToOneMember();

    const { mailer } = fakeMailer();
    const push = fakePush();

    const result = await drainOutbox(app.db, mailer, {
      publicOrigin: "https://atarimae.test",
      push: push.sender,
    });

    expect(push.sent).toHaveLength(0);
    expect(result.failed).toBe(0);
  });

  /**
   * A browser discards subscriptions when an application is uninstalled or a
   * profile is cleared, and the push service says 410 forever after. Retrying
   * those is how a queue fills with work that can never succeed.
   */
  it("revokes a subscription the push service says is gone", async () => {
    const userId = await publishToOneMember();
    const subscriptionId = await subscribe(userId);

    const { mailer } = fakeMailer();
    const push = fakePush([{ status: "gone", reason: "push service returned 410" }]);

    const result = await drainOutbox(app.db, mailer, {
      publicOrigin: "https://atarimae.test",
      push: push.sender,
    });

    expect(result.failed).toBe(0);
    expect(
      await countOf(
        "SELECT count(*)::text AS count FROM push_subscriptions WHERE id = $1 AND revoked_at IS NOT NULL",
        [subscriptionId],
      ),
    ).toBe(1);
  });

  it("retries when the push service is merely unavailable", async () => {
    const userId = await publishToOneMember();
    const subscriptionId = await subscribe(userId);

    const { mailer } = fakeMailer();
    const push = fakePush([{ status: "failed", reason: "push service returned 503" }]);

    const result = await drainOutbox(app.db, mailer, {
      publicOrigin: "https://atarimae.test",
      push: push.sender,
    });

    expect(result.failed).toBe(1);
    // Not revoked — a service that is down is not a subscription that is gone.
    expect(
      await countOf(
        "SELECT count(*)::text AS count FROM push_subscriptions WHERE id = $1 AND revoked_at IS NULL",
        [subscriptionId],
      ),
    ).toBe(1);
  });

  /**
   * A phone that has been wiped must not hold up the notification that
   * reached the person's other device.
   */
  it("counts one device out of two as delivered", async () => {
    const userId = await publishToOneMember();
    await subscribe(userId);
    await subscribe(userId);

    const { mailer } = fakeMailer();
    const push = fakePush([{ status: "gone", reason: "410" }, { status: "sent" }]);

    const result = await drainOutbox(app.db, mailer, {
      publicOrigin: "https://atarimae.test",
      push: push.sender,
    });

    expect(result.failed).toBe(0);
    expect(
      await countOf(
        "SELECT count(*)::text AS count FROM notification_deliveries WHERE channel = 'push' AND status = 'sent'",
      ),
    ).toBe(1);
  });

  /**
   * One notification, one email. A person asked twice to confirm the same
   * thing has been given a reason to distrust the system.
   */
  it("does not resend the email when only push needs retrying", async () => {
    const userId = await publishToOneMember();
    await subscribe(userId);

    const { mailer, sent } = fakeMailer();
    const push = fakePush([{ status: "failed", reason: "503" }]);

    await drainOutbox(app.db, mailer, {
      publicOrigin: "https://atarimae.test",
      push: push.sender,
    });
    expect(sent).toHaveLength(1);

    // Make the row available again, as the retry schedule eventually would.
    await app.db.query(
      "UPDATE notification_outbox SET available_at = now(), locked_at = NULL",
    );

    await drainOutbox(app.db, mailer, {
      publicOrigin: "https://atarimae.test",
      push: push.sender,
    });

    expect(sent).toHaveLength(1);
  });

  /** Push simply not configured must not change how email behaves. */
  it("delivers email normally when no push sender is configured", async () => {
    const userId = await publishToOneMember();
    await subscribe(userId);

    const { mailer, sent } = fakeMailer();

    const result = await drainOutbox(app.db, mailer, {
      publicOrigin: "https://atarimae.test",
    });

    expect(sent).toHaveLength(1);
    expect(result.failed).toBe(0);
  });
});

describe("the VAPID keypair", () => {
  /**
   * The public half is an identity the browser remembers — every subscription
   * is bound to it. Regenerating on restart would silently invalidate every
   * subscription in the organisation, and the symptom would be notifications
   * quietly not arriving.
   */
  it("is generated once and then reused", async () => {
    const first = await loadVapidKeys(app.db, app.secrets, "mailto:a@example.test");
    const second = await loadVapidKeys(app.db, app.secrets, "mailto:a@example.test");

    expect(second.publicKey).toBe(first.publicKey);
    expect(second.privateKey).toBe(first.privateKey);
  });

  it("survives two workers starting at once", async () => {
    const [a, b] = await Promise.all([
      loadVapidKeys(app.db, app.secrets, "mailto:a@example.test"),
      loadVapidKeys(app.db, app.secrets, "mailto:a@example.test"),
    ]);

    expect(a.publicKey).toBe(b.publicKey);
    expect(
      await countOf(
        "SELECT count(*)::text AS count FROM system_settings WHERE key = 'vapid'",
      ),
    ).toBe(1);
  });

  /** The private half is stored the way the SMTP password is. */
  it("never stores the private key in the clear", async () => {
    await loadVapidKeys(app.db, app.secrets, "mailto:a@example.test");

    const { rows } = await app.db.query<{ value: { privateKeyCiphertext: string } }>(
      "SELECT value FROM system_settings WHERE key = 'vapid'",
    );
    const stored = rows[0]!.value;

    expect(app.secrets.isEncrypted(stored.privateKeyCiphertext)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(
      (await loadVapidKeys(app.db, app.secrets, "mailto:a@example.test")).privateKey,
    );
  });
});
