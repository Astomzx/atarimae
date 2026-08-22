import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { bearerToken, generateApiToken, hashApiToken } from "./lib/api-token.js";
import { SESSION_COOKIE } from "./lib/session.js";

/**
 * Service accounts and API tokens.
 *
 * The claims being proved: a token is stored as a hash and never recoverable,
 * revoking or disabling takes effect on the next request, a token cannot mint
 * another token or become a person, and a service account is not a colleague —
 * it must never appear in a member list or in an announcement's denominator.
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
    `TRUNCATE api_tokens, message_mentions, message_attachments, messages,
              direct_conversations, channel_members, channels,
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
const withToken = (token: string) => ({ authorization: `Bearer ${token}` });

async function createServiceAccount(
  displayName = "配車システム",
  role: "member" | "admin" = "admin",
): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/service-accounts",
    headers: as(ownerCookie),
    payload: { displayName, role, description: "毎朝の配車表を取り込みます" },
  });
  if (r.statusCode !== 201) throw new Error(`create: ${r.statusCode} ${r.body}`);
  return r.json().id;
}

async function issueToken(
  serviceAccountId: string,
  name = "夜間取り込み",
  expiresInDays?: number,
): Promise<{ id: string; plaintext: string; prefix: string }> {
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/service-accounts/${serviceAccountId}/tokens`,
    headers: as(ownerCookie),
    payload: { name, ...(expiresInDays ? { expiresInDays } : {}) },
  });
  if (r.statusCode !== 201) throw new Error(`issue: ${r.statusCode} ${r.body}`);
  const body = r.json();
  return {
    id: body.token.id,
    plaintext: body.plaintext,
    prefix: body.token.tokenPrefix,
  };
}

describe("token generation", () => {
  it("is prefixed so a leak is recognisable by a secret scanner", () => {
    expect(generateApiToken().plaintext.startsWith("atk_")).toBe(true);
  });

  it("never produces the same token twice", () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateApiToken().plaintext));

    expect(seen.size).toBe(100);
  });

  it("stores a hash that cannot be turned back into the token", () => {
    const { plaintext, hash } = generateApiToken();

    expect(hash).not.toContain(plaintext);
    expect(plaintext).not.toContain(hash);
    expect(hashApiToken(plaintext)).toBe(hash);
  });

  it("shows a prefix that identifies a token without being usable as one", () => {
    const { plaintext, prefix } = generateApiToken();

    expect(plaintext.startsWith(prefix)).toBe(true);
    expect(prefix.length).toBeLessThan(plaintext.length / 2);
  });
});

describe("reading the Authorization header", () => {
  it("accepts a Bearer token of ours", () => {
    const { plaintext } = generateApiToken();

    expect(bearerToken(`Bearer ${plaintext}`)).toBe(plaintext);
  });

  it("is case-insensitive about the scheme", () => {
    const { plaintext } = generateApiToken();

    expect(bearerToken(`bearer ${plaintext}`)).toBe(plaintext);
  });

  /**
   * Anything that is not one of ours never reaches the database as a hash
   * lookup — including a session cookie value pasted into the wrong header.
   */
  it("refuses a header that is not one of ours", () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("Basic dXNlcjpwYXNz")).toBeNull();
    expect(bearerToken("Bearer short")).toBeNull();
    expect(
      bearerToken("Bearer notours_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ).toBeNull();
  });
});

describe("issuing", () => {
  it("returns the token once, and never again", async () => {
    const id = await createServiceAccount();
    const issued = await issueToken(id);

    expect(issued.plaintext.startsWith("atk_")).toBe(true);

    // Every later view of the same token carries the prefix and no secret.
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/service-accounts/${id}/tokens`,
      headers: as(ownerCookie),
    });

    expect(list.json().items).toHaveLength(1);
    expect(list.body).not.toContain(issued.plaintext);
    expect(list.json().items[0]).toMatchObject({
      name: "夜間取り込み",
      tokenPrefix: issued.prefix,
      revokedAt: null,
    });
  });

  it("stores only the hash", async () => {
    const id = await createServiceAccount();
    const issued = await issueToken(id);

    const { rows } = await app.db.query<{ token_hash: string }>(
      "SELECT token_hash FROM api_tokens WHERE id = $1",
      [issued.id],
    );

    expect(rows[0]!.token_hash).toBe(hashApiToken(issued.plaintext));
    expect(rows[0]!.token_hash).not.toBe(issued.plaintext);
  });

  /** An audit trail that records credentials is a second place to steal them. */
  it("records the issue in the audit log without the token in it", async () => {
    const id = await createServiceAccount();
    const issued = await issueToken(id);

    const { rows } = await app.db.query<{ action: string; metadata: unknown }>(
      "SELECT action, metadata FROM audit_logs WHERE action = 'api_token.issued'",
    );

    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain(issued.plaintext);
    expect(JSON.stringify(rows[0]!.metadata)).toContain(issued.prefix);
  });

  it("refuses to issue against somebody who is a person", async () => {
    const person = await app.inject({
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

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/service-accounts/${person.json().id}/tokens`,
      headers: as(ownerCookie),
      payload: { name: "こっそり" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("NOT_A_SERVICE_ACCOUNT");
  });

  it("refuses to issue to a disabled account rather than handing out a dead credential", async () => {
    const id = await createServiceAccount();
    await app.inject({
      method: "POST",
      url: `/api/v1/service-accounts/${id}/disable`,
      headers: as(ownerCookie),
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/service-accounts/${id}/tokens`,
      headers: as(ownerCookie),
      payload: { name: "無駄" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("TOKEN_INVALID");
  });

  it("requires an administrator", async () => {
    const id = await createServiceAccount();
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
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "tanaka@example.test", password: "member-password-here" },
    });
    const memberCookie = `${SESSION_COOKIE}=${
      new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(
        String(login.headers["set-cookie"] ?? ""),
      )![1]
    }`;

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/service-accounts/${id}/tokens`,
      headers: as(memberCookie),
      payload: { name: "権限なし" },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("authenticating with a token", () => {
  it("acts as the service account, at its role", async () => {
    const id = await createServiceAccount("配車システム", "admin");
    const { plaintext } = await issueToken(id);

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: withToken(plaintext),
    });

    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id, displayName: "配車システム", role: "admin" });
  });

  it("can do the work it exists for", async () => {
    const id = await createServiceAccount();
    const { plaintext } = await issueToken(id);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/announcements",
      headers: withToken(plaintext),
      payload: { title: "明日の配車", body: "8時30分出発です。" },
    });

    expect(created.statusCode).toBe(201);
  });

  it("records when it was last used, so a dead integration is visible", async () => {
    const id = await createServiceAccount();
    const { plaintext } = await issueToken(id);

    await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: withToken(plaintext),
    });

    // The update is deliberately not awaited by the request that triggers it.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const { rows } = await app.db.query<{ last_used_at: string | null }>(
      "SELECT last_used_at FROM api_tokens WHERE user_id = $1",
      [id],
    );
    expect(rows[0]!.last_used_at).not.toBeNull();
  });

  it("refuses a token that was never issued", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: withToken(generateApiToken().plaintext),
    });

    expect(response.statusCode).toBe(401);
  });

  /** Revocation is a database row, consulted on every request and never cached. */
  it("stops working the moment it is revoked", async () => {
    const id = await createServiceAccount();
    const token = await issueToken(id);

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/auth/me",
          headers: withToken(token.plaintext),
        })
      ).statusCode,
    ).toBe(200);

    await app.inject({
      method: "DELETE",
      url: `/api/v1/service-accounts/${id}/tokens/${token.id}`,
      headers: as(ownerCookie),
    });

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/auth/me",
          headers: withToken(token.plaintext),
        })
      ).statusCode,
    ).toBe(401);
  });

  it("stops working the moment its account is disabled", async () => {
    const id = await createServiceAccount();
    const { plaintext } = await issueToken(id);

    await app.inject({
      method: "POST",
      url: `/api/v1/service-accounts/${id}/disable`,
      headers: as(ownerCookie),
    });

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/auth/me",
          headers: withToken(plaintext),
        })
      ).statusCode,
    ).toBe(401);
  });

  it("stops working once it has expired", async () => {
    const id = await createServiceAccount();
    const token = await issueToken(id, "短命", 1);

    // created_at moves too: the table refuses a token that expires before it
    // was issued, which is the constraint that stops an already-dead
    // credential from being handed out as if it worked.
    await app.db.query(
      `UPDATE api_tokens
          SET created_at = now() - interval '2 days',
              expires_at = now() - interval '1 minute'
        WHERE id = $1`,
      [token.id],
    );

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/auth/me",
          headers: withToken(token.plaintext),
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe("what a token may never do", () => {
  /**
   * The containment rule. Without it, a leaked admin token mints a second
   * token that outlives the revocation of the first, and ending the leak stops
   * being possible by revoking one row.
   */
  it("cannot issue another token", async () => {
    const id = await createServiceAccount("配車システム", "admin");
    const { plaintext } = await issueToken(id);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/service-accounts/${id}/tokens`,
      headers: withToken(plaintext),
      payload: { name: "自分で増やす" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("TOKEN_AUTH_NOT_ALLOWED");
  });

  it("cannot create another service account", async () => {
    const id = await createServiceAccount("配車システム", "admin");
    const { plaintext } = await issueToken(id);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/service-accounts",
      headers: withToken(plaintext),
      payload: { displayName: "こっそり", role: "admin" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("TOKEN_AUTH_NOT_ALLOWED");
  });

  it("cannot list or revoke sessions belonging to people", async () => {
    const id = await createServiceAccount("配車システム", "admin");
    const { plaintext } = await issueToken(id);

    const sessions = await app.inject({
      method: "GET",
      url: "/api/v1/auth/sessions",
      headers: withToken(plaintext),
    });

    expect(sessions.statusCode).toBe(403);
    expect(sessions.json().code).toBe("TOKEN_AUTH_NOT_ALLOWED");
  });

  /**
   * A service account has no password, and the database will not let it have
   * one. Interactive sign-in is impossible rather than merely refused.
   */
  it("cannot be given a password, even directly in the database", async () => {
    const id = await createServiceAccount();

    await expect(
      app.db.query("UPDATE users SET password_hash = 'x' WHERE id = $1", [id]),
    ).rejects.toThrow(/ck_service_accounts_have_no_password/);
  });

  it("cannot be an Owner, even directly in the database", async () => {
    const id = await createServiceAccount();

    await expect(
      app.db.query("UPDATE users SET role = 'owner' WHERE id = $1", [id]),
    ).rejects.toThrow(/ck_service_accounts_are_not_owners/);
  });

  it("cannot be created as an Owner through the API", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/service-accounts",
      headers: as(ownerCookie),
      payload: { displayName: "全能", role: "owner" },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("a service account is not a colleague", () => {
  it("does not appear in the member directory", async () => {
    await createServiceAccount("配車システム");

    const members = await app.inject({
      method: "GET",
      url: "/api/v1/users",
      headers: as(ownerCookie),
    });

    expect(members.body).not.toContain("配車システム");
    expect(members.json().items).toHaveLength(1); // the Owner, alone
  });

  /**
   * The failure this prevents is quiet and permanent: a robot in the
   * denominator of an announcement it can never acknowledge, so the rate stops
   * at 12/13 forever and nobody can say which one is missing.
   */
  it("is never a recipient of an announcement addressed to everybody", async () => {
    await createServiceAccount("配車システム");

    const announcement = await app.inject({
      method: "POST",
      url: "/api/v1/announcements",
      headers: as(ownerCookie),
      payload: { title: "全員へ", body: "本文", requiresAcknowledgement: true },
    });
    expect(announcement.statusCode, announcement.body).toBe(201);
    const announcementId = announcement.json().id;

    const targeted = await app.inject({
      method: "PUT",
      url: `/api/v1/announcements/${announcementId}/targets`,
      headers: as(ownerCookie),
      payload: { targets: [{ kind: "all" }] },
    });
    expect(targeted.statusCode, targeted.body).toBe(200);

    const published = await app.inject({
      method: "POST",
      url: `/api/v1/announcements/${announcementId}/publish`,
      headers: as(ownerCookie),
    });
    expect(published.statusCode, published.body).toBe(200);

    // The Owner, and nobody else.
    expect(published.json().recipientsCreated).toBe(1);
  });

  it("cannot be opened as a one-to-one conversation", async () => {
    const id = await createServiceAccount();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/channels/direct",
      headers: as(ownerCookie),
      payload: { userId: id },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("listing service accounts", () => {
  it("counts live tokens and ignores revoked ones", async () => {
    const id = await createServiceAccount();
    const first = await issueToken(id, "一つ目");
    await issueToken(id, "二つ目");

    await app.inject({
      method: "DELETE",
      url: `/api/v1/service-accounts/${id}/tokens/${first.id}`,
      headers: as(ownerCookie),
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/service-accounts",
      headers: as(ownerCookie),
    });

    expect(list.json().items[0]).toMatchObject({
      displayName: "配車システム",
      activeTokenCount: 1,
    });
  });

  it("is not visible to an ordinary member", async () => {
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
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "tanaka@example.test", password: "member-password-here" },
    });
    const memberCookie = `${SESSION_COOKIE}=${
      new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(
        String(login.headers["set-cookie"] ?? ""),
      )![1]
    }`;

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/service-accounts",
      headers: as(memberCookie),
    });

    expect(response.statusCode).toBe(403);
  });
});
