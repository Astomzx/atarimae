import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { parseCsv, toCsv, UTF8_BOM } from "./lib/csv.js";
import { SESSION_COOKIE } from "./lib/session.js";

describe("csv encoding", () => {
  it("quotes only the fields that need it", () => {
    const csv = toCsv(
      ["a", "b"],
      [
        ["plain", "with,comma"],
        ['has "quotes"', "line\nbreak"],
      ],
    );

    expect(csv).toContain("plain,");
    expect(csv).toContain('"with,comma"');
    expect(csv).toContain('"has ""quotes"""');
    expect(csv).toContain('"line\nbreak"');
  });

  /**
   * Excel on Windows assumes the system codepage without a BOM, turning every
   * Japanese name into mojibake. This is the difference between a file that
   * opens by double-clicking and one that needs an import wizard.
   */
  it("round-trips Japanese text through a BOM-prefixed export", () => {
    const csv =
      UTF8_BOM + toCsv(["name", "task"], [["田中 一郎", "8:30 第一営業所集合"]]);

    expect(csv.startsWith(UTF8_BOM)).toBe(true);

    const parsed = parseCsv(csv);
    expect(parsed.headers).toEqual(["name", "task"]);
    expect(parsed.rows[0]).toEqual({ name: "田中 一郎", task: "8:30 第一営業所集合" });
  });

  it("parses fields containing commas, quotes and newlines", () => {
    const parsed = parseCsv('a,b\r\n"x,y","he said ""no"""\r\n');

    expect(parsed.rows[0]).toEqual({ a: "x,y", b: 'he said "no"' });
  });

  it("ignores blank trailing lines", () => {
    // Hand-edited files routinely end with one.
    expect(parseCsv("a,b\r\n1,2\r\n\r\n").rows).toHaveLength(1);
  });

  it("handles a file with no trailing newline", () => {
    expect(parseCsv("a,b\n1,2").rows).toEqual([{ a: "1", b: "2" }]);
  });
});

// ---------------------------------------------------------------------------

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

async function scenario() {
  const unit = await app.inject({
    method: "POST",
    url: "/api/v1/org-units",
    headers: as(ownerCookie),
    payload: { name: "第一営業所" },
  });
  const unitId = unit.json().id as string;

  const ids: Record<string, string> = {};
  for (const [email, name] of [
    ["tanaka@example.test", "田中 一郎"],
    ["sato@example.test", "佐藤 花子"],
  ] as [string, string][]) {
    const created = await app.inject({
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
    ids[email] = created.json().id;
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

  return { announcementId: created.json().id as string, unitId, ids };
}

const importCsv = (announcementId: string, payload: object) =>
  app.inject({
    method: "POST",
    url: `/api/v1/announcements/${announcementId}/personalizations/import`,
    headers: as(ownerCookie),
    payload,
  });

describe("importing per-person content", () => {
  it("writes a paragraph for each row", async () => {
    const { announcementId, ids } = await scenario();

    const csv =
      "user_id,display_name,personal_body\r\n" +
      `${ids["tanaka@example.test"]},田中 一郎,8:30 第一営業所集合\r\n` +
      `${ids["sato@example.test"]},佐藤 花子,大阪センターへ直行\r\n`;

    const response = await importCsv(announcementId, {
      csv,
      changeKind: "personal_minor",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ rowCount: 2, written: 2, unchanged: 0 });

    const { rows } = await app.db.query<{ personal_body: string }>(
      `SELECT personal_body FROM announcement_personalizations
        WHERE announcement_id = $1 AND superseded_at IS NULL
        ORDER BY personal_body`,
      [announcementId],
    );
    expect(rows.map((r) => r.personal_body)).toEqual([
      "8:30 第一営業所集合",
      "大阪センターへ直行",
    ]);
  });

  /**
   * Atomicity. Fifty rows of which twenty-three succeeded is not a state
   * anybody can act on.
   */
  it("writes nothing when any row is unusable", async () => {
    const { announcementId, ids } = await scenario();

    const csv =
      "user_id,personal_body\r\n" +
      `${ids["tanaka@example.test"]},有効な行\r\n` +
      `00000000-0000-7000-8000-000000000000,存在しない利用者\r\n`;

    const response = await importCsv(announcementId, {
      csv,
      changeKind: "personal_minor",
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "CSV_INVALID_ROWS" });
    // Reports the line number, so the file can be fixed without guessing.
    expect(response.json().details.problems[0]).toMatchObject({ line: 3 });

    expect(
      Number(
        (
          await app.db.query<{ count: string }>(
            "SELECT count(*) FROM announcement_personalizations",
          )
        ).rows[0]!.count,
      ),
    ).toBe(0);
  });

  it("rejects a file missing a required column", async () => {
    const { announcementId } = await scenario();

    const response = await importCsv(announcementId, {
      csv: "name,task\r\n田中,集合\r\n",
      changeKind: "personal_minor",
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "CSV_MISSING_COLUMN" });
  });

  it("does not create a revision for a row whose text is unchanged", async () => {
    const { announcementId, ids } = await scenario();
    const csv = `user_id,personal_body\r\n${ids["tanaka@example.test"]},同じ内容\r\n`;

    await importCsv(announcementId, { csv, changeKind: "personal_minor" });
    const second = await importCsv(announcementId, { csv, changeKind: "personal_minor" });

    expect(second.json()).toMatchObject({ written: 0, unchanged: 1 });

    // One version, not two: re-uploading the same sheet must not churn
    // history, and must not re-ask anybody.
    expect(
      Number(
        (
          await app.db.query<{ count: string }>(
            "SELECT count(*) FROM announcement_personalizations",
          )
        ).rows[0]!.count,
      ),
    ).toBe(1);
  });

  it("treats a blank paragraph as no content rather than an error", async () => {
    const { announcementId, ids } = await scenario();

    const csv =
      "user_id,personal_body\r\n" +
      `${ids["tanaka@example.test"]},担当あり\r\n` +
      `${ids["sato@example.test"]},\r\n`;

    const response = await importCsv(announcementId, {
      csv,
      changeKind: "personal_minor",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ rowCount: 2, written: 1 });
  });

  it("re-asks only the people whose paragraph actually changed", async () => {
    const { announcementId, unitId, ids } = await scenario();

    await importCsv(announcementId, {
      csv:
        "user_id,personal_body\r\n" +
        `${ids["tanaka@example.test"]},初版\r\n` +
        `${ids["sato@example.test"]},初版さとう\r\n`,
      changeKind: "personal_minor",
    });

    await app.inject({
      method: "PUT",
      url: `/api/v1/announcements/${announcementId}/targets`,
      headers: as(ownerCookie),
      payload: { targets: [{ kind: "org_unit", orgUnitId: unitId }] },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/announcements/${announcementId}/publish`,
      headers: as(ownerCookie),
    });

    // Only 田中's row differs from what is stored.
    const response = await importCsv(announcementId, {
      csv:
        "user_id,personal_body\r\n" +
        `${ids["tanaka@example.test"]},改訂版\r\n` +
        `${ids["sato@example.test"]},初版さとう\r\n`,
      changeKind: "personal_major",
      requireReacknowledgement: true,
    });

    expect(response.json()).toMatchObject({
      written: 1,
      unchanged: 1,
      reacknowledgementRequested: 1,
    });
  });
});

describe("exporting", () => {
  it("produces a sheet that can be filled in and uploaded back", async () => {
    const { announcementId, ids } = await scenario();

    const download = await app.inject({
      method: "GET",
      url: `/api/v1/announcements/${announcementId}/personalizations.csv`,
      headers: as(ownerCookie),
    });

    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("text/csv");
    expect(download.headers["content-disposition"]).toContain("attachment");
    expect(download.body.startsWith(UTF8_BOM)).toBe(true);

    // The round trip: parse the export, fill a column, upload it.
    const parsed = parseCsv(download.body);
    expect(parsed.headers).toEqual([
      "user_id",
      "display_name",
      "department",
      "personal_body",
    ]);
    expect(parsed.rows).toHaveLength(3); // owner + two members

    const filled =
      "user_id,personal_body\r\n" +
      parsed.rows
        .filter((r) => r["user_id"] === ids["tanaka@example.test"])
        .map((r) => `${r["user_id"]},記入した内容`)
        .join("\r\n") +
      "\r\n";

    const upload = await importCsv(announcementId, {
      csv: filled,
      changeKind: "personal_minor",
    });
    expect(upload.json()).toMatchObject({ written: 1 });
  });

  it("exports acknowledgement results with a state per person", async () => {
    const { announcementId, unitId } = await scenario();

    await app.inject({
      method: "PUT",
      url: `/api/v1/announcements/${announcementId}/targets`,
      headers: as(ownerCookie),
      payload: { targets: [{ kind: "org_unit", orgUnitId: unitId }] },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/announcements/${announcementId}/publish`,
      headers: as(ownerCookie),
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "tanaka@example.test", password: "member-password-here" },
    });
    const header = String(login.headers["set-cookie"] ?? "");
    const cookie = `${SESSION_COOKIE}=${new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header)![1]}`;

    await app.inject({
      method: "POST",
      url: `/api/v1/my/announcements/${announcementId}/acknowledge`,
      headers: as(cookie),
      payload: { clientType: "web" },
    });

    const download = await app.inject({
      method: "GET",
      url: `/api/v1/announcements/${announcementId}/acknowledgements.csv`,
      headers: as(ownerCookie),
    });

    const parsed = parseCsv(download.body);
    const tanaka = parsed.rows.find((r) => r["display_name"] === "田中 一郎");
    const sato = parsed.rows.find((r) => r["display_name"] === "佐藤 花子");

    expect(tanaka?.["state"]).toBe("acknowledged");
    expect(tanaka?.["acknowledged_at"]).not.toBe("");
    expect(sato?.["state"]).toBe("pending");
    expect(sato?.["department"]).toBe("第一営業所");
  });

  it("does not let a member download either sheet", async () => {
    const { announcementId } = await scenario();

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "tanaka@example.test", password: "member-password-here" },
    });
    const header = String(login.headers["set-cookie"] ?? "");
    const cookie = `${SESSION_COOKIE}=${new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header)![1]}`;

    for (const file of ["personalizations.csv", "acknowledgements.csv"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/announcements/${announcementId}/${file}`,
        headers: as(cookie),
      });
      expect(response.statusCode).toBe(403);
    }
  });
});
