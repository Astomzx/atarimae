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
    `TRUNCATE message_mentions, message_attachments, messages,
              direct_conversations, channel_members, channels,
              system_settings, notification_outbox, notification_deliveries,
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

async function createChannel(
  cookie: string,
  name: string,
  kind: "public" | "private" = "public",
  memberIds: string[] = [],
): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/channels",
    headers: as(cookie),
    payload: { name, kind, memberIds },
  });
  if (r.statusCode !== 201) throw new Error(`createChannel: ${r.statusCode} ${r.body}`);
  return r.json().id;
}

const send = (cookie: string, channelId: string, body: string, replyToId?: string) =>
  app.inject({
    method: "POST",
    url: `/api/v1/channels/${channelId}/messages`,
    headers: as(cookie),
    payload: { body, ...(replyToId ? { replyToId } : {}) },
  });

const listMessages = (cookie: string, channelId: string, query = "") =>
  app.inject({
    method: "GET",
    url: `/api/v1/channels/${channelId}/messages${query}`,
    headers: as(cookie),
  });

const listChannels = (cookie: string) =>
  app.inject({ method: "GET", url: "/api/v1/channels", headers: as(cookie) });

// ---------------------------------------------------------------------------

describe("channels", () => {
  it("creates a channel with the creator as a member", async () => {
    const id = await createChannel(ownerCookie, "営業");

    const members = await app.inject({
      method: "GET",
      url: `/api/v1/channels/${id}/members`,
      headers: as(ownerCookie),
    });
    expect(members.json().items).toHaveLength(1);
    expect(members.json().items[0]).toMatchObject({ userId: ownerId });
  });

  it("rejects a duplicate channel name", async () => {
    await createChannel(ownerCookie, "営業");

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/channels",
      headers: as(ownerCookie),
      payload: { name: "営業", kind: "public" },
    });

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: "CHANNEL_NAME_TAKEN" });
  });

  /**
   * Any member may create a channel. Requiring an administrator is how an
   * internal tool ends up with a support ticket for every new project group.
   */
  it("lets an ordinary member create one", async () => {
    await createMember("tanaka@example.test", "田中");
    const cookie = await signIn("tanaka@example.test");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/channels",
      headers: as(cookie),
      payload: { name: "改善提案", kind: "public" },
    });

    expect(response.statusCode).toBe(201);
  });

  it("lists public channels to non-members, and private ones only to members", async () => {
    await createMember("tanaka@example.test", "田中");
    const tanaka = await signIn("tanaka@example.test");

    await createChannel(ownerCookie, "公開チャンネル", "public");
    await createChannel(ownerCookie, "秘密の相談", "private");

    const visible = (await listChannels(tanaka)).json().items as { name: string }[];

    expect(visible.map((c) => c.name)).toContain("公開チャンネル");
    // A private channel must not even be discoverable.
    expect(visible.map((c) => c.name)).not.toContain("秘密の相談");
  });

  it("hides a private channel's messages from a non-member", async () => {
    await createMember("tanaka@example.test", "田中");
    const tanaka = await signIn("tanaka@example.test");
    const id = await createChannel(ownerCookie, "秘密", "private");
    await send(ownerCookie, id, "内部の話");

    const response = await listMessages(tanaka, id);

    // 404 rather than 403: confirming a private channel exists tells an
    // outsider something a 403 would leak.
    expect(response.statusCode).toBe(404);
  });

  it("requires membership to post in a public channel", async () => {
    await createMember("tanaka@example.test", "田中");
    const tanaka = await signIn("tanaka@example.test");
    const id = await createChannel(ownerCookie, "営業");

    const blocked = await send(tanaka, id, "参加していない");
    expect(blocked.statusCode).toBe(403);

    await app.inject({
      method: "POST",
      url: `/api/v1/channels/${id}/join`,
      headers: as(tanaka),
    });

    expect((await send(tanaka, id, "参加した")).statusCode).toBe(201);
  });
});

describe("direct conversations", () => {
  /**
   * Two people must never end up with two conversations, each holding half
   * the history.
   */
  it("returns the same conversation however it is opened", async () => {
    const tanakaId = await createMember("tanaka@example.test", "田中");
    const tanaka = await signIn("tanaka@example.test");

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/channels/direct",
      headers: as(ownerCookie),
      payload: { userId: tanakaId },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/channels/direct",
      headers: as(ownerCookie),
      payload: { userId: tanakaId },
    });
    // Opened from the other side — the pair is stored ordered, so this must
    // resolve to the same row.
    const reverse = await app.inject({
      method: "POST",
      url: "/api/v1/channels/direct",
      headers: as(tanaka),
      payload: { userId: ownerId },
    });

    expect(first.json().id).toBe(second.json().id);
    expect(first.json().id).toBe(reverse.json().id);

    const { rows } = await app.db.query<{ count: string }>(
      "SELECT count(*) FROM direct_conversations",
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it("shows the other person's name as the conversation title", async () => {
    const tanakaId = await createMember("tanaka@example.test", "田中");
    await app.inject({
      method: "POST",
      url: "/api/v1/channels/direct",
      headers: as(ownerCookie),
      payload: { userId: tanakaId },
    });

    const mine = (await listChannels(ownerCookie)).json().items as {
      kind: string;
      counterpartName: string;
    }[];
    const direct = mine.find((c) => c.kind === "direct");

    expect(direct?.counterpartName).toBe("田中");
  });

  it("refuses a conversation with oneself", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/channels/direct",
      headers: as(ownerCookie),
      payload: { userId: ownerId },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "CANNOT_MESSAGE_SELF" });
  });
});

describe("messages", () => {
  it("sends and reads back in chronological order", async () => {
    const id = await createChannel(ownerCookie, "営業");

    for (const text of ["一つ目", "二つ目", "三つ目"]) {
      expect((await send(ownerCookie, id, text)).statusCode).toBe(201);
    }

    const items = (await listMessages(ownerCookie, id)).json().items as {
      body: string;
      authorName: string;
    }[];

    expect(items.map((m) => m.body)).toEqual(["一つ目", "二つ目", "三つ目"]);
    expect(items[0]!.authorName).toBe("オーナー");
  });

  it("paginates backwards from newest", async () => {
    const id = await createChannel(ownerCookie, "営業");
    for (let i = 1; i <= 5; i++) await send(ownerCookie, id, `メッセージ${i}`);

    const page1 = (await listMessages(ownerCookie, id, "?limit=2")).json();
    expect(page1.items.map((m: { body: string }) => m.body)).toEqual([
      "メッセージ4",
      "メッセージ5",
    ]);
    expect(page1.nextBefore).toBeTruthy();

    const page2 = (
      await listMessages(ownerCookie, id, `?limit=2&before=${page1.nextBefore}`)
    ).json();
    expect(page2.items.map((m: { body: string }) => m.body)).toEqual([
      "メッセージ2",
      "メッセージ3",
    ]);
  });

  it("carries a preview of the message being replied to", async () => {
    const id = await createChannel(ownerCookie, "営業");
    const original = (await send(ownerCookie, id, "明日の集合時間は？")).json();
    await send(ownerCookie, id, "8時30分です", original.id);

    const items = (await listMessages(ownerCookie, id)).json().items as {
      replyToId: string | null;
      replyToPreview: string | null;
    }[];

    expect(items[1]!.replyToId).toBe(original.id);
    expect(items[1]!.replyToPreview).toBe("明日の集合時間は？");
  });

  /** Replying across channels would quote a private thread into a public one. */
  it("refuses a reply to a message in another channel", async () => {
    const a = await createChannel(ownerCookie, "営業");
    const b = await createChannel(ownerCookie, "総務");
    const message = (await send(ownerCookie, a, "営業の話")).json();

    const response = await send(ownerCookie, b, "別チャンネルから返信", message.id);

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "REPLY_ACROSS_CHANNELS" });
  });
});

describe("mentions", () => {
  it("records a mention of a channel member", async () => {
    const tanakaId = await createMember("tanaka@example.test", "田中");
    const id = await createChannel(ownerCookie, "営業", "public", [tanakaId]);

    const message = (await send(ownerCookie, id, `@${tanakaId} 確認お願いします`)).json();

    expect(message.mentions).toEqual([tanakaId]);
  });

  /**
   * An @ in a private channel must not notify somebody who cannot read it.
   */
  it("ignores a mention of somebody outside the channel", async () => {
    const outsiderId = await createMember("outsider@example.test", "部外者");
    const id = await createChannel(ownerCookie, "秘密", "private");

    const message = (await send(ownerCookie, id, `@${outsiderId} こんにちは`)).json();

    expect(message.mentions).toEqual([]);
  });

  it("flags a channel that has an unread mention", async () => {
    const tanakaId = await createMember("tanaka@example.test", "田中");
    const tanaka = await signIn("tanaka@example.test");
    const id = await createChannel(ownerCookie, "営業", "public", [tanakaId]);

    await send(ownerCookie, id, "普通のメッセージ");
    const before = (await listChannels(tanaka))
      .json()
      .items.find((c: { id: string }) => c.id === id);
    expect(before).toMatchObject({ unreadCount: 1, hasMention: false });

    await send(ownerCookie, id, `@${tanakaId} 至急`);
    const after = (await listChannels(tanaka))
      .json()
      .items.find((c: { id: string }) => c.id === id);
    expect(after).toMatchObject({ unreadCount: 2, hasMention: true });
  });
});

describe("unread state", () => {
  it("counts only messages from other people", async () => {
    const tanakaId = await createMember("tanaka@example.test", "田中");
    const tanaka = await signIn("tanaka@example.test");
    const id = await createChannel(ownerCookie, "営業", "public", [tanakaId]);

    await send(ownerCookie, id, "オーナーから");
    await send(tanaka, id, "自分の発言");

    const mine = (await listChannels(tanaka))
      .json()
      .items.find((c: { id: string }) => c.id === id);
    // Your own message is not unread to you, and sending advances your
    // position past everything before it.
    expect(mine).toMatchObject({ unreadCount: 0 });
  });

  it("clears once the read position is moved", async () => {
    const tanakaId = await createMember("tanaka@example.test", "田中");
    const tanaka = await signIn("tanaka@example.test");
    const id = await createChannel(ownerCookie, "営業", "public", [tanakaId]);

    await send(ownerCookie, id, "一つ目");
    const last = (await send(ownerCookie, id, "二つ目")).json();

    await app.inject({
      method: "POST",
      url: `/api/v1/channels/${id}/read`,
      headers: as(tanaka),
      payload: { messageId: last.id },
    });

    const after = (await listChannels(tanaka))
      .json()
      .items.find((c: { id: string }) => c.id === id);
    expect(after).toMatchObject({ unreadCount: 0 });
  });

  /**
   * A phone catching up must not undo what was already read on a desktop.
   */
  it("never moves the read position backwards", async () => {
    const tanakaId = await createMember("tanaka@example.test", "田中");
    const tanaka = await signIn("tanaka@example.test");
    const id = await createChannel(ownerCookie, "営業", "public", [tanakaId]);

    const first = (await send(ownerCookie, id, "一つ目")).json();
    const second = (await send(ownerCookie, id, "二つ目")).json();

    const markRead = (messageId: string) =>
      app.inject({
        method: "POST",
        url: `/api/v1/channels/${id}/read`,
        headers: as(tanaka),
        payload: { messageId },
      });

    await markRead(second.id);
    await markRead(first.id); // a slower device reporting an older position

    const after = (await listChannels(tanaka))
      .json()
      .items.find((c: { id: string }) => c.id === id);
    expect(after).toMatchObject({ unreadCount: 0 });
  });
});
