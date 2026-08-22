import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { SESSION_COOKIE } from "./lib/session.js";
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  verifySignature,
} from "./lib/webhook-signature.js";
import { deliverPendingWebhooks } from "./services/webhooks.js";

/**
 * Outbound webhooks.
 *
 * The claims: an event is queued in the same transaction as the change it
 * describes, the signature we send is one a receiver can verify, a failure is
 * retried rather than dropped, and a URL pointing inside the network is
 * refused before anything is stored.
 */

let app: FastifyInstance;
let ownerCookie: string;

const OWNER = {
  email: "owner@example.test",
  displayName: "オーナー",
  password: "correct-horse-battery",
};

const ENDPOINT = "https://hooks.example.test/atarimae";

beforeAll(async () => {
  app = await buildApp({ config: loadConfig() });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await app.db.query(
    `TRUNCATE webhook_deliveries, webhooks, api_tokens,
              announcement_events, announcement_acknowledgements,
              announcement_ack_obligations, announcement_user_due_overrides,
              announcement_personalizations, announcement_recipient_sources,
              announcement_recipients, announcement_targets,
              announcement_target_versions, announcement_content_revisions,
              announcements,
              notification_outbox, notification_deliveries, notifications,
              push_subscriptions, notification_preferences,
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

async function registerWebhook(
  events: string[] = ["announcement.published"],
  url = ENDPOINT,
): Promise<{ id: string; secret: string }> {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/webhooks",
    headers: as(ownerCookie),
    payload: { url, events, description: "配車システム" },
  });
  if (r.statusCode !== 201) throw new Error(`register: ${r.statusCode} ${r.body}`);
  return { id: r.json().webhook.id, secret: r.json().secret };
}

/** A receiver that records what it was sent and answers however it is told. */
function recordingEndpoint(status = 200) {
  const calls: { url: string; headers: Headers; body: string }[] = [];

  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ""),
    });
    return Promise.resolve(new Response("", { status }));
  }) as unknown as typeof fetch;

  return { calls, impl };
}

async function publishAnnouncement(): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/announcements",
    headers: as(ownerCookie),
    payload: { title: "明日の予定", body: "朝礼は8時30分から。" },
  });
  const id = created.json().id;

  await app.inject({
    method: "PUT",
    url: `/api/v1/announcements/${id}/targets`,
    headers: as(ownerCookie),
    payload: { targets: [{ kind: "all" }] },
  });

  const published = await app.inject({
    method: "POST",
    url: `/api/v1/announcements/${id}/publish`,
    headers: as(ownerCookie),
  });
  if (published.statusCode !== 200) {
    throw new Error(`publish: ${published.statusCode} ${published.body}`);
  }

  return id;
}

describe("registering", () => {
  it("returns the signing secret once", async () => {
    const { secret } = await registerWebhook();

    expect(secret.startsWith("whsec_")).toBe(true);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/webhooks",
      headers: as(ownerCookie),
    });

    expect(list.body).not.toContain(secret);
  });

  /**
   * Encrypted rather than hashed, and the exception needs to hold: signing
   * needs the plaintext back on every delivery.
   */
  it("stores the secret encrypted, not in the clear", async () => {
    const { id, secret } = await registerWebhook();

    const { rows } = await app.db.query<{ secret_encrypted: string }>(
      "SELECT secret_encrypted FROM webhooks WHERE id = $1",
      [id],
    );

    expect(rows[0]!.secret_encrypted).not.toContain(secret);
    expect(app.secrets.isEncrypted(rows[0]!.secret_encrypted)).toBe(true);
    expect(await app.secrets.decrypt(rows[0]!.secret_encrypted)).toBe(secret);
  });

  /**
   * A webhook URL is input the server then fetches on its own network. This is
   * the difference between a webhook and a request forger.
   */
  it("refuses an address inside the network", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost:5432/",
      "http://10.0.0.1/hook",
      "http://[::1]/hook",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/webhooks",
        headers: as(ownerCookie),
        payload: { url, events: ["announcement.published"] },
      });

      expect(response.statusCode, url).toBe(422);
      expect(response.json().code, url).toBe("WEBHOOK_URL_NOT_REACHABLE");
    }

    const { rows } = await app.db.query("SELECT id FROM webhooks");
    expect(rows).toHaveLength(0);
  });

  it("refuses a scheme that is not http", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: as(ownerCookie),
      payload: { url: "file:///etc/passwd", events: ["announcement.published"] },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("WEBHOOK_URL_INVALID");
  });

  it("requires an administrator, and refuses an API token", async () => {
    const account = await app.inject({
      method: "POST",
      url: "/api/v1/service-accounts",
      headers: as(ownerCookie),
      payload: { displayName: "配車システム", role: "admin" },
    });
    const token = await app.inject({
      method: "POST",
      url: `/api/v1/service-accounts/${account.json().id}/tokens`,
      headers: as(ownerCookie),
      payload: { name: "t" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: { authorization: `Bearer ${token.json().plaintext}` },
      payload: { url: ENDPOINT, events: ["announcement.published"] },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("TOKEN_AUTH_NOT_ALLOWED");
  });
});

describe("queueing", () => {
  it("queues a delivery when an announcement is published", async () => {
    await registerWebhook();
    await publishAnnouncement();

    const { rows } = await app.db.query<{ event: string; payload: { data: unknown } }>(
      "SELECT event, payload FROM webhook_deliveries",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toBe("announcement.published");
    expect(rows[0]!.payload.data).toMatchObject({
      title: "明日の予定",
      recipientsCreated: 1,
    });
  });

  it("queues nothing for an event nobody subscribed to", async () => {
    await registerWebhook(["user.disabled"]);
    await publishAnnouncement();

    const { rows } = await app.db.query("SELECT id FROM webhook_deliveries");
    expect(rows).toHaveLength(0);
  });

  it("queues nothing to a disabled webhook", async () => {
    const { id } = await registerWebhook();
    await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/${id}/disable`,
      headers: as(ownerCookie),
    });

    await publishAnnouncement();

    const { rows } = await app.db.query("SELECT id FROM webhook_deliveries");
    expect(rows).toHaveLength(0);
  });

  /**
   * One row per subscriber. Sharing one would mean a slow endpoint delaying
   * the other, and one permanent failure abandoning both.
   */
  it("queues one delivery per subscriber", async () => {
    await registerWebhook(["announcement.published"], "https://one.example.test/hook");
    await registerWebhook(["announcement.published"], "https://two.example.test/hook");

    await publishAnnouncement();

    const { rows } = await app.db.query("SELECT id FROM webhook_deliveries");
    expect(rows).toHaveLength(2);
  });

  it("queues an acknowledgement, and only for the tap that recorded one", async () => {
    await registerWebhook(["announcement.acknowledged"]);
    const announcementId = await publishAnnouncementRequiringAck();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await app.inject({
        method: "POST",
        url: `/api/v1/my/announcements/${announcementId}/acknowledge`,
        headers: as(ownerCookie),
        payload: { clientType: "web" },
      });
    }

    const { rows } = await app.db.query(
      "SELECT id FROM webhook_deliveries WHERE event = 'announcement.acknowledged'",
    );
    expect(rows).toHaveLength(1);
  });

  it("queues when a member is created", async () => {
    await registerWebhook(["user.created"]);

    await app.inject({
      method: "POST",
      url: "/api/v1/users",
      headers: as(ownerCookie),
      payload: {
        email: "tanaka@example.test",
        displayName: "田中",
        role: "member",
        password: "member-password-here",
      },
    });

    const { rows } = await app.db.query<{ payload: { data: { email: string } } }>(
      "SELECT payload FROM webhook_deliveries WHERE event = 'user.created'",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.data.email).toBe("tanaka@example.test");
  });
});

describe("delivering", () => {
  it("sends a signature the receiver can verify", async () => {
    const { secret } = await registerWebhook();
    await publishAnnouncement();

    const endpoint = recordingEndpoint();
    const result = await deliverPendingWebhooks(app.db, app.secrets, {
      fetchImpl: endpoint.impl,
    });

    expect(result).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });

    const call = endpoint.calls[0]!;
    expect(call.url).toBe(ENDPOINT);
    expect(call.headers.get(EVENT_HEADER)).toBe("announcement.published");
    expect(call.headers.get(DELIVERY_HEADER)).toBeTruthy();

    // The verification a receiver performs, against the body it received.
    expect(verifySignature(secret, call.headers.get(SIGNATURE_HEADER)!, call.body)).toBe(
      true,
    );
  });

  it("does not verify under a different secret", async () => {
    await registerWebhook();
    await publishAnnouncement();

    const endpoint = recordingEndpoint();
    await deliverPendingWebhooks(app.db, app.secrets, { fetchImpl: endpoint.impl });

    const call = endpoint.calls[0]!;
    expect(
      verifySignature("whsec_wrong", call.headers.get(SIGNATURE_HEADER)!, call.body),
    ).toBe(false);
  });

  it("marks a delivered row so it is never sent twice", async () => {
    await registerWebhook();
    await publishAnnouncement();

    const endpoint = recordingEndpoint();
    await deliverPendingWebhooks(app.db, app.secrets, { fetchImpl: endpoint.impl });
    const second = await deliverPendingWebhooks(app.db, app.secrets, {
      fetchImpl: endpoint.impl,
    });

    expect(second.claimed).toBe(0);
    expect(endpoint.calls).toHaveLength(1);
  });

  /**
   * The row is written in a committed transaction, so it describes something
   * that definitely happened. An endpoint being down delays delivery; it must
   * never lose it.
   */
  it("retries rather than dropping when the endpoint fails", async () => {
    await registerWebhook();
    await publishAnnouncement();

    const failing = recordingEndpoint(500);
    const result = await deliverPendingWebhooks(app.db, app.secrets, {
      fetchImpl: failing.impl,
    });

    expect(result).toMatchObject({ delivered: 0, failed: 1 });

    const { rows } = await app.db.query<{
      delivered_at: string | null;
      attempt_count: number;
      last_status: number | null;
      available_at: string;
    }>(
      "SELECT delivered_at, attempt_count, last_status, available_at FROM webhook_deliveries",
    );

    expect(rows[0]).toMatchObject({
      delivered_at: null,
      attempt_count: 1,
      last_status: 500,
    });
    // Backed off, not abandoned.
    expect(new Date(rows[0]!.available_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("treats a redirect as a failure rather than following it", async () => {
    await registerWebhook();
    await publishAnnouncement();

    const redirecting = recordingEndpoint(302);
    const result = await deliverPendingWebhooks(app.db, app.secrets, {
      fetchImpl: redirecting.impl,
    });

    expect(result).toMatchObject({ delivered: 0, failed: 1 });
  });

  it("survives an endpoint that throws", async () => {
    await registerWebhook();
    await publishAnnouncement();

    const exploding = (() =>
      Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;

    const result = await deliverPendingWebhooks(app.db, app.secrets, {
      fetchImpl: exploding,
    });

    expect(result).toMatchObject({ delivered: 0, failed: 1 });

    const { rows } = await app.db.query<{ last_error: string }>(
      "SELECT last_error FROM webhook_deliveries",
    );
    expect(rows[0]!.last_error).toContain("ECONNREFUSED");
  });

  it("records health on the webhook, so a dead endpoint is visible", async () => {
    const { id } = await registerWebhook();
    await publishAnnouncement();

    await deliverPendingWebhooks(app.db, app.secrets, {
      fetchImpl: recordingEndpoint(500).impl,
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/webhooks",
      headers: as(ownerCookie),
    });

    expect(list.json().items[0]).toMatchObject({
      id,
      consecutiveFailures: 1,
      lastSuccessAt: null,
    });
    expect(list.json().items[0].lastError).toContain("500");
  });

  it("resets the failure count on a success, so flaky is not fatal", async () => {
    const { id } = await registerWebhook();
    await publishAnnouncement();

    await app.db.query("UPDATE webhooks SET consecutive_failures = 5 WHERE id = $1", [
      id,
    ]);
    await deliverPendingWebhooks(app.db, app.secrets, {
      fetchImpl: recordingEndpoint(200).impl,
    });

    const { rows } = await app.db.query<{ consecutive_failures: number }>(
      "SELECT consecutive_failures FROM webhooks WHERE id = $1",
      [id],
    );
    expect(rows[0]!.consecutive_failures).toBe(0);
  });

  /**
   * A receiver decommissioned months ago must not leave a queue growing
   * forever — and being switched off has to be visible, not silent.
   */
  it("switches off an endpoint that has failed too many times in a row", async () => {
    const { id } = await registerWebhook();
    await publishAnnouncement();

    await app.db.query("UPDATE webhooks SET consecutive_failures = 19 WHERE id = $1", [
      id,
    ]);
    await deliverPendingWebhooks(app.db, app.secrets, {
      fetchImpl: recordingEndpoint(500).impl,
    });

    const { rows } = await app.db.query<{ disabled_at: string | null }>(
      "SELECT disabled_at FROM webhooks WHERE id = $1",
      [id],
    );
    expect(rows[0]!.disabled_at).not.toBeNull();
  });

  it("gives a re-enabled endpoint a full allowance again", async () => {
    const { id } = await registerWebhook();
    await app.db.query(
      "UPDATE webhooks SET consecutive_failures = 20, disabled_at = now() WHERE id = $1",
      [id],
    );

    await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/${id}/restore`,
      headers: as(ownerCookie),
    });

    const { rows } = await app.db.query<{
      consecutive_failures: number;
      disabled_at: string | null;
    }>("SELECT consecutive_failures, disabled_at FROM webhooks WHERE id = $1", [id]);

    expect(rows[0]).toMatchObject({ consecutive_failures: 0, disabled_at: null });
  });
});

describe("the delivery log", () => {
  it("shows what happened, without anybody reading a server log", async () => {
    const { id } = await registerWebhook();
    await publishAnnouncement();
    await deliverPendingWebhooks(app.db, app.secrets, {
      fetchImpl: recordingEndpoint(500).impl,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/webhooks/${id}/deliveries`,
      headers: as(ownerCookie),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items[0]).toMatchObject({
      event: "announcement.published",
      attemptCount: 1,
      lastStatus: 500,
      deliveredAt: null,
    });
  });
});

async function publishAnnouncementRequiringAck(): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/announcements",
    headers: as(ownerCookie),
    payload: { title: "確認事項", body: "本文", requiresAcknowledgement: true },
  });
  const id = created.json().id;

  await app.inject({
    method: "PUT",
    url: `/api/v1/announcements/${id}/targets`,
    headers: as(ownerCookie),
    payload: { targets: [{ kind: "all" }] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/announcements/${id}/publish`,
    headers: as(ownerCookie),
  });

  return id;
}
