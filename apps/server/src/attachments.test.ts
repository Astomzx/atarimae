import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { encodeFileName, MAX_ATTACHMENT_BYTES } from "./lib/attachments.js";
import { SESSION_COOKIE } from "./lib/session.js";
import { sweepUnclaimedAttachments } from "./services/attachment-sweep.js";

/**
 * Chat attachments, through the API.
 *
 * The rules being proved here are the ones from the project's own list: an
 * allow-list of extensions, contents verified rather than trusted, a storage
 * name the uploader cannot influence, and permission checked again on
 * download. Each has a case; a rule with no case is a comment.
 */

let app: FastifyInstance;
let ownerCookie: string;

const OWNER = {
  email: "owner@example.test",
  displayName: "オーナー",
  password: "correct-horse-battery",
};

const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const HEIC = Buffer.from("0000001866747970686569630000000068656963", "hex");
const EXECUTABLE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

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
  return r.json().id;
}

const upload = (cookie: string, channelId: string, fileName: string, body: Buffer) =>
  app.inject({
    method: "POST",
    url: `/api/v1/channels/${channelId}/attachments`,
    headers: {
      ...as(cookie),
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; ${encodeFileName(fileName)}`,
    },
    payload: body,
  });

const send = (
  cookie: string,
  channelId: string,
  body: string,
  attachmentIds?: string[],
) =>
  app.inject({
    method: "POST",
    url: `/api/v1/channels/${channelId}/messages`,
    headers: as(cookie),
    payload: { body, ...(attachmentIds ? { attachmentIds } : {}) },
  });

const download = (cookie: string, attachmentId: string) =>
  app.inject({
    method: "GET",
    url: `/api/v1/attachments/${attachmentId}`,
    headers: as(cookie),
  });

describe("uploading", () => {
  it("accepts a PDF and answers with what it stored", async () => {
    const channelId = await createChannel(ownerCookie, "営業");

    const response = await upload(ownerCookie, channelId, "報告書.pdf", PDF);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      name: "報告書.pdf",
      contentType: "application/pdf",
      byteSize: PDF.length,
      inline: false,
    });
  });

  it("keeps a Japanese filename intact through the header", async () => {
    const channelId = await createChannel(ownerCookie, "営業");

    const response = await upload(
      ownerCookie,
      channelId,
      "2026年度 勤務表.xlsx",
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]),
    );

    expect(response.json().name).toBe("2026年度 勤務表.xlsx");
  });

  it("marks a verified image as safe to show inline", async () => {
    const channelId = await createChannel(ownerCookie, "営業");

    expect((await upload(ownerCookie, channelId, "現場.png", PNG)).json()).toMatchObject({
      inline: true,
    });
  });

  it("accepts an iPhone HEIC photo as a verified downloadable image", async () => {
    const channelId = await createChannel(ownerCookie, "営業");

    const response = await upload(ownerCookie, channelId, "現場写真.heic", HEIC);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      contentType: "image/heic",
      inline: false,
    });
  });

  it("refuses a renamed file that only claims to be HEIC", async () => {
    const channelId = await createChannel(ownerCookie, "営業");

    const response = await upload(ownerCookie, channelId, "偽物.heic", EXECUTABLE);
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("ATTACHMENT_CONTENT_MISMATCH");
  });

  /**
   * The rule the whole module exists for: the declared type is the uploader's
   * word, and the bytes are the evidence.
   */
  it("refuses an executable renamed to a spreadsheet", async () => {
    const channelId = await createChannel(ownerCookie, "営業");

    const response = await upload(ownerCookie, channelId, "勤務表.xlsx", EXECUTABLE);

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("ATTACHMENT_CONTENT_MISMATCH");
  });

  it("refuses an extension that is not on the allow-list, and says which are", async () => {
    const channelId = await createChannel(ownerCookie, "営業");

    const response = await upload(ownerCookie, channelId, "setup.exe", EXECUTABLE);

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("ATTACHMENT_TYPE_NOT_ALLOWED");
    expect(response.json().details.allowedExtensions).toContain("pdf");
  });

  it("refuses an empty file", async () => {
    const channelId = await createChannel(ownerCookie, "営業");

    const response = await upload(ownerCookie, channelId, "空.pdf", Buffer.alloc(0));

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("ATTACHMENT_EMPTY");
  });

  /**
   * Refused by the framework before the body is read into memory, so a huge
   * upload is not buffered first and rejected afterwards.
   */
  it("refuses a body over the ceiling without buffering it", async () => {
    const channelId = await createChannel(ownerCookie, "営業");
    const huge = Buffer.alloc(MAX_ATTACHMENT_BYTES + 2048);
    PDF.copy(huge);

    const response = await upload(ownerCookie, channelId, "大きい.pdf", huge);

    expect(response.statusCode).toBe(413);
  });

  it("refuses an upload with no filename", async () => {
    const channelId = await createChannel(ownerCookie, "営業");

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/attachments`,
      headers: { ...as(ownerCookie), "content-type": "application/octet-stream" },
      payload: PDF,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("ATTACHMENT_NAME_INVALID");
  });

  /** Uploading where you cannot post stores a file that can never be sent. */
  it("refuses an upload from somebody who has not joined the channel", async () => {
    await createMember("tanaka@example.test", "田中");
    const tanaka = await signIn("tanaka@example.test");
    const channelId = await createChannel(ownerCookie, "営業");

    const response = await upload(tanaka, channelId, "報告書.pdf", PDF);

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("CHANNEL_FORBIDDEN");
  });

  it("refuses an upload to a private channel from outside it", async () => {
    await createMember("tanaka@example.test", "田中");
    const tanaka = await signIn("tanaka@example.test");
    const channelId = await createChannel(ownerCookie, "経営", "private");

    expect((await upload(tanaka, channelId, "報告書.pdf", PDF)).statusCode).toBe(404);
  });

  /**
   * The storage name is generated from the row's own id. Nothing from the
   * request reaches the filesystem, so no filename can decide where a file
   * lands or what it is called there.
   */
  it("stores under a generated key that contains nothing from the request", async () => {
    const channelId = await createChannel(ownerCookie, "営業");
    const id = (await upload(ownerCookie, channelId, "報告書.pdf", PDF)).json().id;

    const { rows } = await app.db.query<{ storage_key: string; original_name: string }>(
      "SELECT storage_key, original_name FROM message_attachments WHERE id = $1",
      [id],
    );

    // Date-sharded, named after the row's own id, and carrying no extension —
    // a stored name ending in .html is one misconfiguration away from being
    // served as a page from this origin.
    expect(rows[0]!.storage_key).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}$/);
    expect(rows[0]!.storage_key).not.toContain("報告書");
    expect(rows[0]!.storage_key).not.toContain(".pdf");
    // The name people see is kept, and kept separate.
    expect(rows[0]!.original_name).toBe("報告書.pdf");
  });

  /**
   * The generated key means a name like this can never reach the filesystem,
   * but a name written to escape a directory was written to trick something,
   * so it is refused rather than stored and ignored.
   */
  it("refuses a filename that tries to climb out of a directory", async () => {
    const channelId = await createChannel(ownerCookie, "営業");

    const response = await upload(ownerCookie, channelId, "../../報告書.pdf", PDF);

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("ATTACHMENT_NAME_INVALID");
  });
});

describe("attaching to a message", () => {
  it("carries the file on the message it was sent with", async () => {
    const channelId = await createChannel(ownerCookie, "営業");
    const attachment = (await upload(ownerCookie, channelId, "報告書.pdf", PDF)).json();

    const response = await send(ownerCookie, channelId, "確認をお願いします", [
      attachment.id,
    ]);

    expect(response.statusCode).toBe(201);
    expect(response.json().attachments).toEqual([
      {
        id: attachment.id,
        name: "報告書.pdf",
        contentType: "application/pdf",
        byteSize: PDF.length,
        url: `/api/v1/attachments/${attachment.id}`,
        inline: false,
      },
    ]);
  });

  /**
   * Silent success is the enemy. Delivering the message and quietly losing the
   * file is the exact shape of failure this product argues against, so the
   * whole send fails and names the ids that could not be attached.
   */
  it("fails the whole send rather than dropping an attachment it cannot claim", async () => {
    const channelId = await createChannel(ownerCookie, "営業");
    const stranger = "019fe100-0000-7000-8000-0000000000ff";

    const response = await send(ownerCookie, channelId, "資料です", [stranger]);

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("ATTACHMENT_NOT_CLAIMABLE");
    expect(response.json().details.attachmentIds).toEqual([stranger]);

    // And the message does not exist: the transaction took it with it.
    const messages = await app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: as(ownerCookie),
    });
    expect(messages.json().items).toHaveLength(0);
  });

  it("refuses to attach somebody else's upload", async () => {
    const tanakaId = await createMember("tanaka@example.test", "田中");
    const tanaka = await signIn("tanaka@example.test");
    const channelId = await createChannel(ownerCookie, "営業", "public", [tanakaId]);

    const mine = (await upload(ownerCookie, channelId, "報告書.pdf", PDF)).json();
    const response = await send(tanaka, channelId, "これです", [mine.id]);

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("ATTACHMENT_NOT_CLAIMABLE");
  });

  /**
   * A file uploaded to a private channel must not be able to travel into a
   * public one on the next message.
   */
  it("refuses to attach a file uploaded to a different channel", async () => {
    const privateId = await createChannel(ownerCookie, "経営", "private");
    const publicId = await createChannel(ownerCookie, "営業");

    const secret = (await upload(ownerCookie, privateId, "給与.pdf", PDF)).json();
    const response = await send(ownerCookie, publicId, "共有します", [secret.id]);

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("ATTACHMENT_NOT_CLAIMABLE");
  });

  it("refuses to attach the same upload to a second message", async () => {
    const channelId = await createChannel(ownerCookie, "営業");
    const attachment = (await upload(ownerCookie, channelId, "報告書.pdf", PDF)).json();

    await send(ownerCookie, channelId, "一度目", [attachment.id]);
    const again = await send(ownerCookie, channelId, "二度目", [attachment.id]);

    expect(again.statusCode).toBe(422);
    expect(again.json().code).toBe("ATTACHMENT_NOT_CLAIMABLE");
  });
});

describe("downloading", () => {
  it("returns the bytes with the stored type and the original name", async () => {
    const channelId = await createChannel(ownerCookie, "営業");
    const attachment = (await upload(ownerCookie, channelId, "報告書.pdf", PDF)).json();
    await send(ownerCookie, channelId, "どうぞ", [attachment.id]);

    const response = await download(ownerCookie, attachment.id);

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.rawPayload.equals(PDF)).toBe(true);
    expect(response.headers["content-disposition"]).toContain(
      `filename*=UTF-8''${encodeURIComponent("報告書.pdf")}`,
    );
  });

  /** Nothing is served in a way a browser is free to reinterpret. */
  it("forbids content sniffing", async () => {
    const channelId = await createChannel(ownerCookie, "営業");
    const attachment = (await upload(ownerCookie, channelId, "報告書.pdf", PDF)).json();

    const response = await download(ownerCookie, attachment.id);

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-disposition"]).toContain("attachment;");
  });

  it("shows a verified image inline", async () => {
    const channelId = await createChannel(ownerCookie, "営業");
    const attachment = (await upload(ownerCookie, channelId, "現場.png", PNG)).json();

    const response = await download(ownerCookie, attachment.id);

    expect(response.headers["content-disposition"]).toContain("inline;");
  });

  it("requires a session", async () => {
    const channelId = await createChannel(ownerCookie, "営業");
    const attachment = (await upload(ownerCookie, channelId, "報告書.pdf", PDF)).json();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/attachments/${attachment.id}`,
    });

    expect(response.statusCode).toBe(401);
  });

  /**
   * A link is not a capability. The channel is consulted on every download, so
   * losing access to it loses access to its files — including ones already
   * sent and still visible in somebody's browser history.
   */
  it("refuses somebody who cannot read the channel", async () => {
    await createMember("tanaka@example.test", "田中");
    const tanaka = await signIn("tanaka@example.test");
    const channelId = await createChannel(ownerCookie, "経営", "private");
    const attachment = (await upload(ownerCookie, channelId, "給与.pdf", PDF)).json();
    await send(ownerCookie, channelId, "確認", [attachment.id]);

    const response = await download(tanaka, attachment.id);

    // notFound, not forbidden: confirming that a private channel's file exists
    // tells an outsider something a 403 should not.
    expect(response.statusCode).toBe(404);
  });

  it("lets a member of a public channel download what was sent there", async () => {
    const tanakaId = await createMember("tanaka@example.test", "田中");
    const tanaka = await signIn("tanaka@example.test");
    const channelId = await createChannel(ownerCookie, "営業", "public", [tanakaId]);
    const attachment = (await upload(ownerCookie, channelId, "報告書.pdf", PDF)).json();
    await send(ownerCookie, channelId, "どうぞ", [attachment.id]);

    expect((await download(tanaka, attachment.id)).statusCode).toBe(200);
  });

  /**
   * An upload that has not been sent yet belongs to nobody but its uploader.
   * Guessing an id must not reveal a file somebody is still deciding whether
   * to send.
   */
  it("hides an unsent upload from everybody but the uploader", async () => {
    const tanakaId = await createMember("tanaka@example.test", "田中");
    const tanaka = await signIn("tanaka@example.test");
    const channelId = await createChannel(ownerCookie, "営業", "public", [tanakaId]);
    const attachment = (await upload(ownerCookie, channelId, "下書き.pdf", PDF)).json();

    expect((await download(tanaka, attachment.id)).statusCode).toBe(404);
    expect((await download(ownerCookie, attachment.id)).statusCode).toBe(200);
  });
});

describe("the sweep", () => {
  it("removes an upload nobody ever sent, and its file", async () => {
    const channelId = await createChannel(ownerCookie, "営業");
    const attachment = (
      await upload(ownerCookie, channelId, "気が変わった.pdf", PDF)
    ).json();

    const { rows } = await app.db.query<{ storage_key: string }>(
      "SELECT storage_key FROM message_attachments WHERE id = $1",
      [attachment.id],
    );
    const storageKey = rows[0]!.storage_key;
    expect(await app.attachments.exists(storageKey)).toBe(true);

    // Older than the grace period.
    await app.db.query(
      "UPDATE message_attachments SET created_at = now() - interval '2 hours' WHERE id = $1",
      [attachment.id],
    );

    const result = await sweepUnclaimedAttachments(app.db, app.attachments);

    expect(result.removed).toBe(1);
    expect(await app.attachments.exists(storageKey)).toBe(false);
    expect((await download(ownerCookie, attachment.id)).statusCode).toBe(404);
  });

  it("leaves a recent upload alone, so a slow typist keeps their file", async () => {
    const channelId = await createChannel(ownerCookie, "営業");
    const attachment = (await upload(ownerCookie, channelId, "書きかけ.pdf", PDF)).json();

    expect((await sweepUnclaimedAttachments(app.db, app.attachments)).removed).toBe(0);
    expect((await download(ownerCookie, attachment.id)).statusCode).toBe(200);
  });

  it("never touches a file that was sent", async () => {
    const channelId = await createChannel(ownerCookie, "営業");
    const attachment = (await upload(ownerCookie, channelId, "報告書.pdf", PDF)).json();
    await send(ownerCookie, channelId, "どうぞ", [attachment.id]);

    await app.db.query(
      "UPDATE message_attachments SET created_at = now() - interval '30 days'",
    );

    expect((await sweepUnclaimedAttachments(app.db, app.attachments)).removed).toBe(0);
    expect((await download(ownerCookie, attachment.id)).statusCode).toBe(200);
  });
});
