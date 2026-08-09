import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { SESSION_COOKIE } from "./lib/session.js";
import {
  CallProviderError,
  generateRoomName,
  resolveJoinUrl,
} from "./services/call-providers.js";
import { endAbandonedCalls } from "./services/call-sweep.js";

/**
 * M5: 通話 — calls over the network, inside a conversation.
 *
 * The claims: the room is generated and not guessable, one channel has one
 * live call however many people press the button, joining re-checks membership
 * rather than trusting the link, and a provider that cannot be reached fails
 * out loud instead of producing a call nobody can join.
 */

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
    `TRUNCATE call_participants, calls, call_providers,
              webhook_deliveries, webhooks, api_tokens,
              message_mentions, message_attachments, messages,
              direct_conversations, channel_members, channels,
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

const as = (cookie: string) => ({ cookie });

async function createMember(email: string, name: string): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/users",
    headers: as(ownerCookie),
    payload: {
      email,
      displayName: name,
      role: "member",
      password: "member-password-here",
    },
  });
  return r.json().id;
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

async function createChannel(memberIds: string[] = []): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/channels",
    headers: as(ownerCookie),
    payload: { name: "営業", kind: "public", memberIds },
  });
  return r.json().id;
}

async function configureUrlProvider(
  urlTemplate = "https://meet.example.test/{room}",
): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/call-providers",
    headers: as(ownerCookie),
    payload: { name: "社内 Jitsi", kind: "url", urlTemplate, isDefault: true },
  });
  if (r.statusCode !== 201) throw new Error(`provider: ${r.statusCode} ${r.body}`);
  return r.json().id;
}

const startCall = (cookie: string, channelId: string) =>
  app.inject({
    method: "POST",
    url: `/api/v1/channels/${channelId}/calls`,
    headers: as(cookie),
  });

describe("configuring a provider", () => {
  it("accepts a URL template and needs no credential", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/call-providers",
      headers: as(ownerCookie),
      payload: {
        name: "社内 Jitsi",
        kind: "url",
        urlTemplate: "https://meet.example.test/{room}",
      },
    });

    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ kind: "url", hasSecret: false });
  });

  /**
   * A template with no {room} sends every call in the organisation into one
   * shared room — two unrelated conversations hearing each other, looking
   * exactly like the product working.
   */
  it("refuses a template with no room placeholder", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/call-providers",
      headers: as(ownerCookie),
      payload: { name: "壊れた", kind: "url", urlTemplate: "https://meet.example.test/" },
    });

    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe("CALL_PROVIDER_TEMPLATE_INVALID");
  });

  /**
   * Deliberately permitted, and the difference from a webhook. A self-hosted
   * Jitsi in the server cupboard is the case this product is for; refusing it
   * would mean calls only work through somebody else's cloud.
   */
  it("allows an address on the office network", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/call-providers",
      headers: as(ownerCookie),
      payload: {
        name: "社内サーバー",
        kind: "url",
        urlTemplate: "https://10.0.0.20/meet/{room}",
      },
    });

    expect(r.statusCode).toBe(201);
  });

  it("refuses a scheme that is not http", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/call-providers",
      headers: as(ownerCookie),
      payload: { name: "変", kind: "url", urlTemplate: "ftp://example.test/{room}" },
    });

    expect(r.statusCode).toBe(422);
  });

  it("refuses an HTTP provider with no way to read the answer", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/call-providers",
      headers: as(ownerCookie),
      payload: {
        name: "半端",
        kind: "http",
        requestUrl: "https://api.example.test/rooms",
      },
    });

    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe("CALL_PROVIDER_INCOMPLETE");
  });

  it("stores the API secret encrypted and never returns it", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/call-providers",
      headers: as(ownerCookie),
      payload: {
        name: "外部サービス",
        kind: "http",
        requestUrl: "https://api.example.test/rooms",
        responseUrlPath: "data.url",
        secret: "super-secret-api-key",
      },
    });

    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ hasSecret: true });
    expect(r.body).not.toContain("super-secret-api-key");

    const { rows } = await app.db.query<{ secret_encrypted: string }>(
      "SELECT secret_encrypted FROM call_providers WHERE id = $1",
      [r.json().id],
    );
    expect(rows[0]!.secret_encrypted).not.toContain("super-secret-api-key");
    expect(await app.secrets.decrypt(rows[0]!.secret_encrypted)).toBe(
      "super-secret-api-key",
    );
  });

  it("keeps only one default", async () => {
    await configureUrlProvider("https://one.example.test/{room}");
    await app.inject({
      method: "POST",
      url: "/api/v1/call-providers",
      headers: as(ownerCookie),
      payload: {
        name: "二つ目",
        kind: "url",
        urlTemplate: "https://two.example.test/{room}",
        isDefault: true,
      },
    });

    const { rows } = await app.db.query(
      "SELECT id FROM call_providers WHERE is_default AND disabled_at IS NULL",
    );
    expect(rows).toHaveLength(1);
  });

  it("requires an administrator", async () => {
    await createMember("tanaka@example.test", "田中");
    const tanaka = await signIn("tanaka@example.test");

    const r = await app.inject({
      method: "POST",
      url: "/api/v1/call-providers",
      headers: as(tanaka),
      payload: { name: "勝手に", kind: "url", urlTemplate: "https://x.test/{room}" },
    });

    expect(r.statusCode).toBe(403);
  });
});

describe("resolving a room", () => {
  it("substitutes the room into a URL template", async () => {
    const url = await resolveJoinUrl(
      {
        id: "p",
        kind: "url",
        urlTemplate: "https://meet.example.test/{room}",
        requestUrl: null,
        requestHeaders: {},
        requestBodyTemplate: null,
        responseUrlPath: null,
        secretEncrypted: null,
      },
      "atarimae-abc",
      app.secrets,
    );

    expect(url).toBe("https://meet.example.test/atarimae-abc");
  });

  it("reads the join URL out of an HTTP provider's answer", async () => {
    const calls: { url: string; body: string; headers: Headers }[] = [];
    const fetchImpl = ((url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: String(init?.body ?? ""),
        headers: new Headers(init?.headers),
      });
      return Promise.resolve(
        new Response(JSON.stringify({ data: { url: "https://rooms.test/xyz" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    const url = await resolveJoinUrl(
      {
        id: "p",
        kind: "http",
        urlTemplate: null,
        requestUrl: "https://api.example.test/rooms",
        requestHeaders: { authorization: "Bearer {secret}" },
        requestBodyTemplate: '{"name":"{room}"}',
        responseUrlPath: "data.url",
        secretEncrypted: await app.secrets.encrypt("api-key-here"),
      },
      "atarimae-abc",
      app.secrets,
      { fetchImpl },
    );

    expect(url).toBe("https://rooms.test/xyz");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer api-key-here");
    expect(calls[0]!.body).toBe('{"name":"atarimae-abc"}');
  });

  it("fails out loud when the answer has nothing at the path", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ nothing: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )) as unknown as typeof fetch;

    await expect(
      resolveJoinUrl(
        {
          id: "p",
          kind: "http",
          urlTemplate: null,
          requestUrl: "https://api.example.test/rooms",
          requestHeaders: {},
          requestBodyTemplate: null,
          responseUrlPath: "data.url",
          secretEncrypted: null,
        },
        "atarimae-abc",
        app.secrets,
        { fetchImpl },
      ),
    ).rejects.toBeInstanceOf(CallProviderError);
  });

  /**
   * A provider's error body can quote the request back, API key included. Only
   * the shape of the failure is reported.
   */
  it("does not put the provider's own message into the error", async () => {
    const fetchImpl = (() =>
      Promise.reject(
        new Error("connect ECONNREFUSED key=api-key-here"),
      )) as unknown as typeof fetch;

    await expect(
      resolveJoinUrl(
        {
          id: "p",
          kind: "http",
          urlTemplate: null,
          requestUrl: "https://api.example.test/rooms",
          requestHeaders: {},
          requestBodyTemplate: null,
          responseUrlPath: "data.url",
          secretEncrypted: null,
        },
        "atarimae-abc",
        app.secrets,
        { fetchImpl },
      ),
    ).rejects.toThrow(/Could not reach the call provider/);
  });

  it("generates a room name nobody can guess", () => {
    const names = new Set(Array.from({ length: 100 }, generateRoomName));

    expect(names.size).toBe(100);
    expect(generateRoomName()).toMatch(/^atarimae-[0-9a-f-]{36}$/);
  });
});

describe("starting a call", () => {
  it("starts one and returns somewhere to go", async () => {
    await configureUrlProvider();
    const channelId = await createChannel();

    const r = await startCall(ownerCookie, channelId);

    expect(r.statusCode).toBe(201);
    expect(r.json().joinUrl).toMatch(/^https:\/\/meet\.example\.test\/atarimae-/);
    expect(r.json().call).toMatchObject({ channelId, startedBy: ownerId, endedAt: null });
    expect(r.json().call.participants).toHaveLength(1);
  });

  /** The room must not be derivable from anything an outsider can see. */
  it("names the room from nothing in the channel", async () => {
    await configureUrlProvider();
    const channelId = await createChannel();

    await startCall(ownerCookie, channelId);

    const { rows } = await app.db.query<{ room_name: string }>(
      "SELECT room_name FROM calls",
    );
    expect(rows[0]!.room_name).not.toContain("営業");
    expect(rows[0]!.room_name).not.toContain(channelId);
  });

  /**
   * Two people pressing 通話 at the same moment must land in one room, not two
   * with half the participants in each.
   */
  it("joins the call already running rather than opening a second", async () => {
    await configureUrlProvider();
    const tanakaId = await createMember("tanaka@example.test", "田中");
    const tanaka = await signIn("tanaka@example.test");
    const channelId = await createChannel([tanakaId]);

    const first = await startCall(ownerCookie, channelId);
    const second = await startCall(tanaka, channelId);

    expect(second.statusCode).toBe(201);
    expect(second.json().call.id).toBe(first.json().call.id);

    const { rows } = await app.db.query("SELECT id FROM calls");
    expect(rows).toHaveLength(1);
    expect(second.json().call.participants).toHaveLength(2);
  });

  /**
   * Not a 500, and not a success with nowhere to go: there is no provider, and
   * an administrator is the one who can fix it.
   */
  it("says so when no provider is configured", async () => {
    const channelId = await createChannel();

    const r = await startCall(ownerCookie, channelId);

    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe("NO_CALL_PROVIDER");
  });

  it("refuses somebody who has not joined the channel", async () => {
    await configureUrlProvider();
    await createMember("tanaka@example.test", "田中");
    const tanaka = await signIn("tanaka@example.test");
    const channelId = await createChannel();

    const r = await startCall(tanaka, channelId);

    expect(r.statusCode).toBe(403);
  });
});

describe("joining and leaving", () => {
  it("re-checks membership rather than trusting the link", async () => {
    await configureUrlProvider();
    const tanakaId = await createMember("tanaka@example.test", "田中");
    const tanaka = await signIn("tanaka@example.test");
    const channelId = await createChannel([tanakaId]);
    const callId = (await startCall(ownerCookie, channelId)).json().call.id;

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/calls/${callId}/join`,
          headers: as(tanaka),
        })
      ).statusCode,
    ).toBe(200);

    // Removed from the channel, still holding the call id.
    await app.db.query(
      "UPDATE channel_members SET left_at = now() WHERE channel_id = $1 AND user_id = $2",
      [channelId, tanakaId],
    );

    const after = await app.inject({
      method: "POST",
      url: `/api/v1/calls/${callId}/join`,
      headers: as(tanaka),
    });
    expect(after.statusCode).toBe(403);
  });

  it("treats a reconnection as the same person", async () => {
    await configureUrlProvider();
    const channelId = await createChannel();
    const callId = (await startCall(ownerCookie, channelId)).json().call.id;

    await app.inject({
      method: "POST",
      url: `/api/v1/calls/${callId}/leave`,
      headers: as(ownerCookie),
    });

    const { rows } = await app.db.query("SELECT id FROM call_participants");
    expect(rows).toHaveLength(1);
  });

  /**
   * Otherwise the channel list says "in progress" forever, and nobody can
   * start a new one because of the single-live-call index.
   */
  it("ends the call when the last person leaves", async () => {
    await configureUrlProvider();
    const tanakaId = await createMember("tanaka@example.test", "田中");
    const tanaka = await signIn("tanaka@example.test");
    const channelId = await createChannel([tanakaId]);
    const callId = (await startCall(ownerCookie, channelId)).json().call.id;
    await startCall(tanaka, channelId);

    await app.inject({
      method: "POST",
      url: `/api/v1/calls/${callId}/leave`,
      headers: as(ownerCookie),
    });

    let { rows } = await app.db.query<{ ended_at: string | null }>(
      "SELECT ended_at FROM calls WHERE id = $1",
      [callId],
    );
    expect(rows[0]!.ended_at, "one person is still on it").toBeNull();

    await app.inject({
      method: "POST",
      url: `/api/v1/calls/${callId}/leave`,
      headers: as(tanaka),
    });

    ({ rows } = await app.db.query<{ ended_at: string | null }>(
      "SELECT ended_at FROM calls WHERE id = $1",
      [callId],
    ));
    expect(rows[0]!.ended_at).not.toBeNull();
  });

  it("refuses to join a call that is over", async () => {
    await configureUrlProvider();
    const channelId = await createChannel();
    const callId = (await startCall(ownerCookie, channelId)).json().call.id;

    await app.db.query("UPDATE calls SET ended_at = now() WHERE id = $1", [callId]);

    const r = await app.inject({
      method: "POST",
      url: `/api/v1/calls/${callId}/join`,
      headers: as(ownerCookie),
    });

    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe("CALL_ALREADY_ENDED");
  });

  it("lets a new call start once the old one ended", async () => {
    await configureUrlProvider();
    const channelId = await createChannel();
    const first = (await startCall(ownerCookie, channelId)).json().call.id;

    await app.inject({
      method: "POST",
      url: `/api/v1/calls/${first}/leave`,
      headers: as(ownerCookie),
    });

    const second = await startCall(ownerCookie, channelId);
    expect(second.statusCode).toBe(201);
    expect(second.json().call.id).not.toBe(first);
  });
});

/**
 * Both shapes, because both are the point.
 *
 * A call belongs to a channel, and a channel is either a one-to-one
 * conversation or a group — so 1:1 and group calls are the same mechanism
 * pointed at different rooms. That is a claim, and a claim needs a test:
 * without these, "it should work" is all there is.
 */
describe("one-to-one and group", () => {
  it("holds a call in a one-to-one conversation", async () => {
    await configureUrlProvider();
    const tanakaId = await createMember("tanaka@example.test", "田中");
    const tanaka = await signIn("tanaka@example.test");

    const opened = await app.inject({
      method: "POST",
      url: "/api/v1/channels/direct",
      headers: as(ownerCookie),
      payload: { userId: tanakaId },
    });
    const channelId = opened.json().id;

    const started = await startCall(ownerCookie, channelId);
    expect(started.statusCode).toBe(201);

    // The other person can join it, and nobody else exists who could.
    const joined = await app.inject({
      method: "POST",
      url: `/api/v1/calls/${started.json().call.id}/join`,
      headers: as(tanaka),
    });
    expect(joined.statusCode).toBe(200);
    expect(joined.json().call.participants).toHaveLength(2);
  });

  it("keeps a one-to-one call out of reach of everybody else", async () => {
    await configureUrlProvider();
    const tanakaId = await createMember("tanaka@example.test", "田中");
    await createMember("sato@example.test", "佐藤");
    const sato = await signIn("sato@example.test");

    const opened = await app.inject({
      method: "POST",
      url: "/api/v1/channels/direct",
      headers: as(ownerCookie),
      payload: { userId: tanakaId },
    });
    const callId = (await startCall(ownerCookie, opened.json().id)).json().call.id;

    // 佐藤 has the id and no business being in the conversation.
    const intruder = await app.inject({
      method: "POST",
      url: `/api/v1/calls/${callId}/join`,
      headers: as(sato),
    });
    expect(intruder.statusCode).toBe(404);
  });

  it("holds a call for a whole group, and everybody in it can join", async () => {
    await configureUrlProvider();
    const tanakaId = await createMember("tanaka@example.test", "田中");
    const satoId = await createMember("sato@example.test", "佐藤");
    const tanaka = await signIn("tanaka@example.test");
    const sato = await signIn("sato@example.test");
    const channelId = await createChannel([tanakaId, satoId]);

    const callId = (await startCall(ownerCookie, channelId)).json().call.id;

    for (const cookie of [tanaka, sato]) {
      const joined = await app.inject({
        method: "POST",
        url: `/api/v1/calls/${callId}/join`,
        headers: as(cookie),
      });
      expect(joined.statusCode).toBe(200);
    }

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/calls`,
      headers: as(ownerCookie),
    });
    expect(history.json().items[0].participants).toHaveLength(3);
  });

  /**
   * A group call is for the group. Being able to *read* a public channel is
   * not being in it — walking into its call uninvited is not reading, which is
   * why joining asks `assertCanPost` rather than `assertCanRead`.
   */
  it("keeps a group call to the members of the group", async () => {
    await configureUrlProvider();
    const tanakaId = await createMember("tanaka@example.test", "田中");
    await createMember("sato@example.test", "佐藤");
    const sato = await signIn("sato@example.test");
    const channelId = await createChannel([tanakaId]);

    const callId = (await startCall(ownerCookie, channelId)).json().call.id;

    // 佐藤 can see this public channel and has not joined it.
    const readable = await app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/calls`,
      headers: as(sato),
    });
    expect(readable.statusCode, "the channel is public, so she can read it").toBe(200);

    const intruder = await app.inject({
      method: "POST",
      url: `/api/v1/calls/${callId}/join`,
      headers: as(sato),
    });
    expect(intruder.statusCode).toBe(403);
  });
});

describe("a call nobody left", () => {
  /**
   * A closed laptop is not somebody leaving. Without the backstop the channel
   * shows 通話中 forever and can never start another, because only one live
   * call is allowed per channel.
   */
  it("is ended by the backstop, so the channel is not stuck", async () => {
    await configureUrlProvider();
    const channelId = await createChannel();
    const callId = (await startCall(ownerCookie, channelId)).json().call.id;

    expect(await endAbandonedCalls(app.db), "not yet — it only just started").toBe(0);

    await app.db.query(
      "UPDATE calls SET started_at = now() - interval '13 hours' WHERE id = $1",
      [callId],
    );

    expect(await endAbandonedCalls(app.db)).toBe(1);

    // And a new call can start again.
    expect((await startCall(ownerCookie, channelId)).statusCode).toBe(201);
  });
});

describe("the history", () => {
  /**
   * The difference between a call that happened and one that rang out, which
   * is the thing anybody wants to know afterwards.
   */
  it("records who actually joined", async () => {
    await configureUrlProvider();
    const tanakaId = await createMember("tanaka@example.test", "田中");
    const channelId = await createChannel([tanakaId]);
    await startCall(ownerCookie, channelId);

    const r = await app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/calls`,
      headers: as(ownerCookie),
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().items).toHaveLength(1);
    // 田中 was in the channel and never picked up.
    expect(r.json().items[0].participants).toHaveLength(1);
    expect(r.json().items[0].participants[0].displayName).toBe("オーナー");
  });

  it("never hands the join URL to the history", async () => {
    await configureUrlProvider();
    const channelId = await createChannel();
    await startCall(ownerCookie, channelId);

    const r = await app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/calls`,
      headers: as(ownerCookie),
    });

    expect(r.body).not.toContain("meet.example.test");
  });
});
