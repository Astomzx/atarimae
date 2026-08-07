import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { SESSION_COOKIE } from "./lib/session.js";
import type { MailMessage, Mailer } from "./services/mailer.js";
import { drainOutbox, reclaimStaleLocks } from "./services/notification-worker.js";

let app: FastifyInstance;
let ownerCookie: string;

const OWNER = {
  email: "owner@example.test",
  displayName: "オーナー",
  password: "correct-horse-battery",
};

/** Records what would have been sent, and can be told to fail. */
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

// ---------------------------------------------------------------------------

const as = (cookie: string) => ({ cookie });

async function publishTo(members: [string, string][]): Promise<string> {
  const unit = await app.inject({
    method: "POST",
    url: "/api/v1/org-units",
    headers: as(ownerCookie),
    payload: { name: "第一営業所" },
  });
  const unitId = unit.json().id as string;

  for (const [email, name] of members) {
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
    },
  });
  const id = created.json().id as string;

  await app.inject({
    method: "PUT",
    url: `/api/v1/announcements/${id}/targets`,
    headers: as(ownerCookie),
    payload: { targets: [{ kind: "org_unit", orgUnitId: unitId }] },
  });
  const published = await app.inject({
    method: "POST",
    url: `/api/v1/announcements/${id}/publish`,
    headers: as(ownerCookie),
  });
  if (published.statusCode !== 200) throw new Error(`publish: ${published.body}`);

  return id;
}

const drain = (mailer: Mailer) =>
  drainOutbox(app.db, mailer, { publicOrigin: "https://atarimae.test" });

const countOf = async (sql: string, params: unknown[] = []) =>
  Number((await app.db.query<{ count: string }>(sql, params)).rows[0]!.count);

// ---------------------------------------------------------------------------

describe("draining the outbox", () => {
  it("sends one email per queued obligation and marks the rows processed", async () => {
    await publishTo([
      ["tanaka@example.test", "田中"],
      ["sato@example.test", "佐藤"],
    ]);

    expect(await countOf("SELECT count(*) FROM notification_outbox")).toBe(2);

    const { mailer, sent } = fakeMailer();
    const result = await drain(mailer);

    expect(result).toMatchObject({ claimed: 2, delivered: 2, failed: 0 });
    expect(sent).toHaveLength(2);
    expect(sent.map((m) => m.to).sort()).toEqual([
      "sato@example.test",
      "tanaka@example.test",
    ]);
    expect(sent[0]!.subject).toBe("確認が必要なお知らせがあります");
    // The body names the announcement and links back, in Japanese.
    expect(sent[0]!.text).toContain("明日の予定");
    expect(sent[0]!.text).toContain("https://atarimae.test");

    expect(
      await countOf(
        "SELECT count(*) FROM notification_outbox WHERE processed_at IS NULL",
      ),
    ).toBe(0);
    expect(
      await countOf("SELECT count(*) FROM notification_deliveries WHERE status = 'sent'"),
    ).toBe(2);
  });

  it("does nothing on a second pass", async () => {
    await publishTo([["tanaka@example.test", "田中"]]);

    const first = fakeMailer();
    await drain(first.mailer);

    const second = fakeMailer();
    const result = await drain(second.mailer);

    expect(result.claimed).toBe(0);
    expect(second.sent).toHaveLength(0);
  });

  /**
   * The property the whole outbox exists for. SMTP being unreachable must
   * delay the message, never discard it — the person is still owed a
   * notification, and an administrator who fixes SMTP tomorrow should see it
   * go out.
   */
  it("keeps the message when SMTP fails, and retries it later", async () => {
    await publishTo([["tanaka@example.test", "田中"]]);

    const broken = fakeMailer({ failWith: "ECONNREFUSED 10.0.0.1:587" });
    const failure = await drain(broken.mailer);

    expect(failure).toMatchObject({ claimed: 1, delivered: 0, failed: 1 });

    // Still owed, unlocked for another attempt, and the reason is recorded.
    const { rows } = await app.db.query<{
      processed_at: string | null;
      locked_at: string | null;
      attempt_count: number;
      last_error: string;
      available_at: string;
    }>(
      "SELECT processed_at, locked_at, attempt_count, last_error, available_at FROM notification_outbox",
    );

    expect(rows[0]!.processed_at).toBeNull();
    expect(rows[0]!.locked_at).toBeNull();
    expect(rows[0]!.attempt_count).toBe(1);
    expect(rows[0]!.last_error).toContain("ECONNREFUSED");

    // Backed off, so an immediate retry does not hammer a dead server.
    expect(new Date(rows[0]!.available_at).getTime()).toBeGreaterThan(Date.now());

    // Once it becomes due again and SMTP works, it is delivered.
    await app.db.query("UPDATE notification_outbox SET available_at = now()");
    const working = fakeMailer();
    expect(await drain(working.mailer)).toMatchObject({ delivered: 1 });
    expect(working.sent).toHaveLength(1);
  });

  /**
   * A retry must not send a second copy. The unique index on
   * (obligation_id, event_type) is what makes that structural rather than
   * a matter of the worker being careful.
   */
  it("does not duplicate the in-app notification across retries", async () => {
    await publishTo([["tanaka@example.test", "田中"]]);

    const broken = fakeMailer({ failWith: "temporary failure" });
    await drain(broken.mailer);

    await app.db.query("UPDATE notification_outbox SET available_at = now()");
    const working = fakeMailer();
    await drain(working.mailer);

    expect(await countOf("SELECT count(*) FROM notifications")).toBe(1);
    expect(await countOf("SELECT count(*) FROM notification_deliveries")).toBe(1);
    expect(working.sent).toHaveLength(1);
  });

  it("gives up after the retry limit rather than looping forever", async () => {
    await publishTo([["tanaka@example.test", "田中"]]);

    const broken = fakeMailer({ failWith: "permanent failure" });
    for (let i = 0; i < 12; i++) {
      await app.db.query("UPDATE notification_outbox SET available_at = now()");
      await drain(broken.mailer);
    }

    const { rows } = await app.db.query<{ attempt_count: number }>(
      "SELECT attempt_count FROM notification_outbox",
    );
    expect(rows[0]!.attempt_count).toBe(10);

    // Visible to an administrator rather than silently stuck.
    const status = await app.inject({
      method: "GET",
      url: "/api/v1/settings/notification-queue",
      headers: as(ownerCookie),
    });
    expect(status.json()).toMatchObject({ abandoned: 1 });
  });

  it("respects a user who turned email off, while still recording the notification", async () => {
    await publishTo([["tanaka@example.test", "田中"]]);

    const { rows } = await app.db.query<{ id: string }>(
      "SELECT id FROM users WHERE email = 'tanaka@example.test'",
    );
    await app.db.query(
      `INSERT INTO notification_preferences (user_id, event_type, email_enabled)
       VALUES ($1, 'obligation.assigned', false)`,
      [rows[0]!.id],
    );

    const { mailer, sent } = fakeMailer();
    const result = await drain(mailer);

    expect(result).toMatchObject({ delivered: 0, skipped: 1 });
    expect(sent).toHaveLength(0);

    // They were still asked; only the email channel was suppressed.
    expect(await countOf("SELECT count(*) FROM notifications")).toBe(1);
  });

  it("skips an event whose obligation no longer exists", async () => {
    await publishTo([["tanaka@example.test", "田中"]]);

    await app.db.query(
      `UPDATE notification_outbox
          SET payload = jsonb_set(payload, '{obligationId}',
                                  '"00000000-0000-7000-8000-000000000000"')`,
    );

    const { mailer, sent } = fakeMailer();
    const result = await drain(mailer);

    // Not an error worth retrying forever: mark it done and move on.
    expect(result).toMatchObject({ skipped: 1, failed: 0 });
    expect(sent).toHaveLength(0);
    expect(
      await countOf(
        "SELECT count(*) FROM notification_outbox WHERE processed_at IS NULL",
      ),
    ).toBe(0);
  });
});

describe("stale locks", () => {
  /**
   * A worker that dies mid-batch leaves rows locked. Without reclaiming them,
   * the notification is owed but never sent — reintroducing the exact failure
   * the outbox prevents, one step later.
   */
  it("releases rows locked by a worker that died", async () => {
    await publishTo([["tanaka@example.test", "田中"]]);

    await app.db.query(
      `UPDATE notification_outbox
          SET locked_at = now() - interval '10 minutes', locked_by = 'dead-worker'`,
    );

    // Locked rows are invisible to a claim.
    const ignored = fakeMailer();
    expect(await drain(ignored.mailer)).toMatchObject({ claimed: 0 });

    expect(await reclaimStaleLocks(app.db, 300)).toBe(1);

    const working = fakeMailer();
    expect(await drain(working.mailer)).toMatchObject({ delivered: 1 });
  });

  it("leaves a freshly locked row alone", async () => {
    await publishTo([["tanaka@example.test", "田中"]]);
    await app.db.query(
      "UPDATE notification_outbox SET locked_at = now(), locked_by = 'busy-worker'",
    );

    expect(await reclaimStaleLocks(app.db, 300)).toBe(0);
  });
});

describe("SMTP configuration", () => {
  it("reports unconfigured before anything is set", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/settings/smtp",
      headers: as(ownerCookie),
    });

    expect(response.json()).toMatchObject({ configured: false, hasPassword: false });
  });

  it("stores the password encrypted and never returns it", async () => {
    const update = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/smtp",
      headers: as(ownerCookie),
      payload: {
        host: "smtp.example.test",
        port: 587,
        secure: false,
        username: "atarimae",
        password: "super-secret-smtp-password",
        fromAddress: "noreply@example.test",
        fromName: "Atarimae",
      },
    });

    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({ configured: true, hasPassword: true });
    // No field anywhere in the response carries the plaintext.
    expect(update.body).not.toContain("super-secret-smtp-password");

    const stored = await app.db.query<{ value: { passwordCiphertext: string } }>(
      "SELECT value FROM system_settings WHERE key = 'smtp'",
    );
    const ciphertext = stored.rows[0]!.value.passwordCiphertext;

    expect(ciphertext).not.toContain("super-secret-smtp-password");
    expect(ciphertext.startsWith("enc:v1:")).toBe(true);
    // And it round-trips, so the worker can actually authenticate.
    expect(await app.secrets.decrypt(ciphertext)).toBe("super-secret-smtp-password");

    const read = await app.inject({
      method: "GET",
      url: "/api/v1/settings/smtp",
      headers: as(ownerCookie),
    });
    expect(read.body).not.toContain("super-secret-smtp-password");
  });

  it("keeps the stored password when the field is omitted", async () => {
    const base = {
      host: "smtp.example.test",
      port: 587,
      secure: false,
      username: "atarimae",
      fromAddress: "noreply@example.test",
      fromName: "Atarimae",
    };

    await app.inject({
      method: "PUT",
      url: "/api/v1/settings/smtp",
      headers: as(ownerCookie),
      payload: { ...base, password: "original-password-x" },
    });

    // Changing the sender name must not silently wipe the credential.
    await app.inject({
      method: "PUT",
      url: "/api/v1/settings/smtp",
      headers: as(ownerCookie),
      payload: { ...base, fromName: "社内掲示板" },
    });

    const stored = await app.db.query<{ value: { passwordCiphertext: string } }>(
      "SELECT value FROM system_settings WHERE key = 'smtp'",
    );
    expect(await app.secrets.decrypt(stored.rows[0]!.value.passwordCiphertext)).toBe(
      "original-password-x",
    );
  });

  it("only lets an Owner change it", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/users",
      headers: as(ownerCookie),
      payload: {
        email: "admin@example.test",
        displayName: "管理者",
        role: "admin",
        password: "admin-password-here",
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@example.test", password: "admin-password-here" },
    });
    const header = String(login.headers["set-cookie"] ?? "");
    const adminCookie = `${SESSION_COOKIE}=${new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header)![1]}`;

    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/smtp",
      headers: as(adminCookie),
      payload: {
        host: "evil.example.test",
        port: 25,
        secure: false,
        fromAddress: "spoof@example.test",
        fromName: "x",
      },
    });

    // An admin can read the configuration and test it, but sending mail as the
    // organisation is an Owner-level capability.
    expect(response.statusCode).toBe(403);
  });

  it("refuses to test an unconfigured server", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/settings/smtp/test",
      headers: as(ownerCookie),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "SMTP_NOT_CONFIGURED" });
  });
});
