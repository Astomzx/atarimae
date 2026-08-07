import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";
import { createDatabase, type Database, type DatabaseClient } from "./db.js";

let db: Database;

beforeAll(() => {
  db = createDatabase(loadConfig());
});

afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  await db.query(
    `TRUNCATE announcement_events, announcement_acknowledgements,
              announcement_ack_obligations, announcement_user_due_overrides,
              announcement_personalizations, announcement_recipient_sources,
              announcement_recipients, announcement_targets,
              announcement_target_versions, announcement_content_revisions,
              announcements,
              audit_logs, sessions, user_devices, invitations,
              user_org_units, org_units, users
       RESTART IDENTITY CASCADE`,
  );
});

async function inRollback<T>(fn: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    return await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

/** Minimal cast of characters: an owner, an announcement, one recipient. */
async function seed(client: DatabaseClient) {
  const { rows: users } = await client.query<{ id: string }>(
    `INSERT INTO users (email, display_name, role)
     VALUES ('owner@example.test', 'オーナー', 'owner'),
            ('tanaka@example.test', '田中', 'member')
     RETURNING id`,
  );
  const ownerId = users[0]!.id;
  const memberId = users[1]!.id;

  const { rows: announcements } = await client.query<{ id: string }>(
    `INSERT INTO announcements (requires_acknowledgement, created_by)
     VALUES (true, $1) RETURNING id`,
    [ownerId],
  );
  const announcementId = announcements[0]!.id;

  const { rows: revisions } = await client.query<{ id: string }>(
    `INSERT INTO announcement_content_revisions
       (announcement_id, version_no, title, body, change_kind, created_by)
     VALUES ($1, 1, '明日の予定', '朝礼は8時30分から', 'initial', $2)
     RETURNING id`,
    [announcementId, ownerId],
  );
  const revisionId = revisions[0]!.id;

  await client.query(
    "UPDATE announcements SET current_published_content_revision_id = $2 WHERE id = $1",
    [announcementId, revisionId],
  );

  const { rows: recipients } = await client.query<{ id: string }>(
    `INSERT INTO announcement_recipients (announcement_id, user_id)
     VALUES ($1, $2) RETURNING id`,
    [announcementId, memberId],
  );

  return {
    ownerId,
    memberId,
    announcementId,
    revisionId,
    recipientId: recipients[0]!.id,
  };
}

async function createObligation(
  client: DatabaseClient,
  recipientId: string,
  revisionId: string,
  previousId?: string,
) {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO announcement_ack_obligations
       (recipient_id, content_revision_id, previous_obligation_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [recipientId, revisionId, previousId ?? null],
  );
  return rows[0]!.id;
}

// ---------------------------------------------------------------------------

describe("one live obligation per recipient", () => {
  /**
   * The most important constraint in the schema. Without it a logic bug counts
   * somebody twice in the denominator and the error is undetectable
   * afterwards — the acknowledgement rate is simply, permanently, slightly
   * wrong.
   */
  it("refuses a second live obligation for the same recipient", async () => {
    await inRollback(async (client) => {
      const { recipientId, revisionId } = await seed(client);
      await createObligation(client, recipientId, revisionId);

      await expect(createObligation(client, recipientId, revisionId)).rejects.toThrow(
        /uq_active_obligation_per_recipient|duplicate key/,
      );
    });
  });

  /**
   * Re-acknowledgement must supersede before inserting. The partial unique
   * index enforces that ordering, so getting it backwards fails loudly in
   * development rather than silently double-counting in production.
   */
  it("accepts a successor once the previous one is superseded", async () => {
    await inRollback(async (client) => {
      const { recipientId, revisionId, announcementId, ownerId } = await seed(client);
      const first = await createObligation(client, recipientId, revisionId);

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO announcement_content_revisions
           (announcement_id, version_no, title, body, change_kind,
            requires_reacknowledgement, created_by)
         VALUES ($1, 2, '明日の予定', '朝礼は9時からに変更', 'content_major', true, $2)
         RETURNING id`,
        [announcementId, ownerId],
      );
      const revision2 = rows[0]!.id;

      await client.query(
        "UPDATE announcement_ack_obligations SET superseded_at = now() WHERE id = $1",
        [first],
      );

      const second = await createObligation(client, recipientId, revision2, first);
      expect(second).toBeTruthy();

      // Exactly one live obligation, and the chain back to the original is
      // intact so the history stays explainable.
      const { rows: live } = await client.query<{ count: string }>(
        `SELECT count(*) FROM announcement_ack_obligations
          WHERE recipient_id = $1 AND waived_at IS NULL AND superseded_at IS NULL`,
        [recipientId],
      );
      expect(Number(live[0]!.count)).toBe(1);
    });
  });

  it("allows a new obligation after the previous one was waived", async () => {
    await inRollback(async (client) => {
      const { recipientId, revisionId } = await seed(client);
      const first = await createObligation(client, recipientId, revisionId);

      await client.query(
        `UPDATE announcement_ack_obligations
            SET waived_at = now(), waived_reason = 'user_disabled' WHERE id = $1`,
        [first],
      );

      await expect(
        createObligation(client, recipientId, revisionId),
      ).resolves.toBeTruthy();
    });
  });
});

describe("obligation integrity", () => {
  it("rejects an obligation that is both waived and superseded", async () => {
    await inRollback(async (client) => {
      const { recipientId, revisionId } = await seed(client);
      const id = await createObligation(client, recipientId, revisionId);

      await expect(
        client.query(
          `UPDATE announcement_ack_obligations
              SET waived_at = now(), waived_reason = 'x', superseded_at = now()
            WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow(/ck_obligation_not_waived_and_superseded/);
    });
  });

  it("requires a reason for every waive", async () => {
    await inRollback(async (client) => {
      const { recipientId, revisionId } = await seed(client);
      const id = await createObligation(client, recipientId, revisionId);

      // Without a reason, nobody can later explain why the denominator moved.
      await expect(
        client.query(
          "UPDATE announcement_ack_obligations SET waived_at = now() WHERE id = $1",
          [id],
        ),
      ).rejects.toThrow(/ck_obligation_waive_reason/);
    });
  });

  it("rejects a reason without a waive", async () => {
    await inRollback(async (client) => {
      const { recipientId, revisionId } = await seed(client);
      const id = await createObligation(client, recipientId, revisionId);

      await expect(
        client.query(
          "UPDATE announcement_ack_obligations SET waived_reason = 'oops' WHERE id = $1",
          [id],
        ),
      ).rejects.toThrow(/ck_obligation_waive_reason/);
    });
  });
});

describe("acknowledgements are immutable evidence", () => {
  it("permits only one acknowledgement per obligation", async () => {
    await inRollback(async (client) => {
      const { recipientId, revisionId } = await seed(client);
      const id = await createObligation(client, recipientId, revisionId);

      const ack = () =>
        client.query(
          `INSERT INTO announcement_acknowledgements (obligation_id, client_type)
           VALUES ($1, 'web')`,
          [id],
        );

      await expect(ack()).resolves.toBeTruthy();
      // Re-acknowledgement creates a new obligation; it never overwrites this.
      await expect(ack()).rejects.toThrow(/uq_acknowledgement_once|duplicate key/);
    });
  });

  it("rejects an unknown client type", async () => {
    await inRollback(async (client) => {
      const { recipientId, revisionId } = await seed(client);
      const id = await createObligation(client, recipientId, revisionId);

      await expect(
        client.query(
          `INSERT INTO announcement_acknowledgements (obligation_id, client_type)
           VALUES ($1, 'carrier-pigeon')`,
          [id],
        ),
      ).rejects.toThrow(/ck_acknowledgement_client_type/);
    });
  });

  /**
   * Superseding an obligation must leave its acknowledgement untouched: the
   * person really did confirm the old content, and that fact does not stop
   * being true.
   */
  it("keeps the acknowledgement when its obligation is superseded", async () => {
    await inRollback(async (client) => {
      const { recipientId, revisionId } = await seed(client);
      const id = await createObligation(client, recipientId, revisionId);

      await client.query(
        `INSERT INTO announcement_acknowledgements (obligation_id, client_type)
         VALUES ($1, 'web')`,
        [id],
      );
      await client.query(
        "UPDATE announcement_ack_obligations SET superseded_at = now() WHERE id = $1",
        [id],
      );

      const { rows } = await client.query<{ count: string }>(
        "SELECT count(*) FROM announcement_acknowledgements WHERE obligation_id = $1",
        [id],
      );
      expect(Number(rows[0]!.count)).toBe(1);
    });
  });
});

describe("acknowledgement rate", () => {
  /**
   * The denominator is live obligations, nothing else. Not current department
   * headcount, not total recipients, not waived or superseded rows.
   */
  it("counts only live obligations, and only their acknowledgements", async () => {
    await inRollback(async (client) => {
      const { announcementId, revisionId, ownerId } = await seed(client);

      // Four more members, so there are five recipients in total.
      for (let i = 0; i < 4; i++) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO users (email, display_name, role)
           VALUES ($1, $2, 'member') RETURNING id`,
          [`member${i}@example.test`, `社員${i}`],
        );
        await client.query(
          `INSERT INTO announcement_recipients (announcement_id, user_id)
           VALUES ($1, $2)`,
          [announcementId, rows[0]!.id],
        );
      }
      void ownerId;

      const { rows: recipients } = await client.query<{ id: string }>(
        "SELECT id FROM announcement_recipients WHERE announcement_id = $1 ORDER BY id",
        [announcementId],
      );
      expect(recipients).toHaveLength(5);

      const obligations: string[] = [];
      for (const recipient of recipients) {
        obligations.push(await createObligation(client, recipient.id, revisionId));
      }

      // Two acknowledge.
      for (const id of obligations.slice(0, 2)) {
        await client.query(
          `INSERT INTO announcement_acknowledgements (obligation_id, client_type)
           VALUES ($1, 'web')`,
          [id],
        );
      }

      // One is waived — leaves both numerator and denominator.
      await client.query(
        `UPDATE announcement_ack_obligations
            SET waived_at = now(), waived_reason = 'user_disabled' WHERE id = $1`,
        [obligations[4]!],
      );

      const { rows } = await client.query<{
        acknowledged_count: string;
        obligation_count: string;
      }>(
        `SELECT COUNT(*) FILTER (WHERE ack.id IS NOT NULL) AS acknowledged_count,
                COUNT(*)                                   AS obligation_count
           FROM announcement_ack_obligations o
           JOIN announcement_recipients r ON r.id = o.recipient_id
           LEFT JOIN announcement_acknowledgements ack ON ack.obligation_id = o.id
          WHERE r.announcement_id = $1
            AND o.waived_at IS NULL
            AND o.superseded_at IS NULL`,
        [announcementId],
      );

      // 2 of 4: the waived person is in neither figure.
      expect(Number(rows[0]!.acknowledged_count)).toBe(2);
      expect(Number(rows[0]!.obligation_count)).toBe(4);
    });
  });
});

describe("targets", () => {
  async function targetVersion(
    client: DatabaseClient,
    announcementId: string,
    by: string,
  ) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO announcement_target_versions (announcement_id, version_no, created_by)
       VALUES ($1, 1, $2) RETURNING id`,
      [announcementId, by],
    );
    return rows[0]!.id;
  }

  it.each([
    ["all with an org unit", "all", "org", null],
    ["all with a user", "all", null, "user"],
    ["org_unit with no unit", "org_unit", null, null],
    ["org_unit with a user", "org_unit", "org", "user"],
    ["user with no user", "user", null, null],
    ["user with an org unit", "user", "org", null],
  ])("rejects %s", async (_label, kind, org, user) => {
    await inRollback(async (client) => {
      const { announcementId, ownerId, memberId } = await seed(client);
      const versionId = await targetVersion(client, announcementId, ownerId);

      const { rows: units } = await client.query<{ id: string }>(
        "INSERT INTO org_units (name) VALUES ('第一営業所') RETURNING id",
      );

      await expect(
        client.query(
          `INSERT INTO announcement_targets (target_version_id, target_kind, org_unit_id, user_id)
           VALUES ($1, $2, $3, $4)`,
          [versionId, kind, org ? units[0]!.id : null, user ? memberId : null],
        ),
      ).rejects.toThrow(/ck_target_reference/);
    });
  });

  it("accepts each valid combination", async () => {
    await inRollback(async (client) => {
      const { announcementId, ownerId, memberId } = await seed(client);
      const versionId = await targetVersion(client, announcementId, ownerId);
      const { rows: units } = await client.query<{ id: string }>(
        "INSERT INTO org_units (name) VALUES ('第一営業所') RETURNING id",
      );

      await client.query(
        `INSERT INTO announcement_targets (target_version_id, target_kind, org_unit_id, user_id)
         VALUES ($1, 'all', NULL, NULL),
                ($1, 'org_unit', $2, NULL),
                ($1, 'user', NULL, $3)`,
        [versionId, units[0]!.id, memberId],
      );

      const { rows } = await client.query<{ count: string }>(
        "SELECT count(*) FROM announcement_targets WHERE target_version_id = $1",
        [versionId],
      );
      expect(Number(rows[0]!.count)).toBe(3);
    });
  });

  it("rejects the same org unit twice in one version", async () => {
    await inRollback(async (client) => {
      const { announcementId, ownerId } = await seed(client);
      const versionId = await targetVersion(client, announcementId, ownerId);
      const { rows: units } = await client.query<{ id: string }>(
        "INSERT INTO org_units (name) VALUES ('営業部') RETURNING id",
      );

      const insert = () =>
        client.query(
          `INSERT INTO announcement_targets (target_version_id, target_kind, org_unit_id)
           VALUES ($1, 'org_unit', $2)`,
          [versionId, units[0]!.id],
        );

      await expect(insert()).resolves.toBeTruthy();
      // Listing it twice would double-count during expansion.
      await expect(insert()).rejects.toThrow(/uq_target_org_unit|duplicate key/);
    });
  });
});

describe("personalizations", () => {
  it("permits one live version per person per announcement", async () => {
    await inRollback(async (client) => {
      const { announcementId, memberId, ownerId } = await seed(client);

      const insert = (versionNo: number) =>
        client.query(
          `INSERT INTO announcement_personalizations
             (announcement_id, user_id, version_no, personal_body, change_kind, created_by)
           VALUES ($1, $2, $3, '8:30 第一営業所集合', 'initial', $4)`,
          [announcementId, memberId, versionNo, ownerId],
        );

      await expect(insert(1)).resolves.toBeTruthy();
      await expect(insert(2)).rejects.toThrow(/uq_active_personalization|duplicate key/);
    });
  });

  it("allows a new version once the previous one is superseded", async () => {
    await inRollback(async (client) => {
      const { announcementId, memberId, ownerId } = await seed(client);

      await client.query(
        `INSERT INTO announcement_personalizations
           (announcement_id, user_id, version_no, personal_body, change_kind, created_by)
         VALUES ($1, $2, 1, '旧内容', 'initial', $3)`,
        [announcementId, memberId, ownerId],
      );
      await client.query(
        `UPDATE announcement_personalizations SET superseded_at = now()
          WHERE announcement_id = $1 AND user_id = $2`,
        [announcementId, memberId],
      );

      await expect(
        client.query(
          `INSERT INTO announcement_personalizations
             (announcement_id, user_id, version_no, personal_body, change_kind, created_by)
           VALUES ($1, $2, 2, '新内容', 'personal_major', $3)`,
          [announcementId, memberId, ownerId],
        ),
      ).resolves.toBeTruthy();
    });
  });

  /**
   * Personalization is keyed by user, not recipient, precisely so it can exist
   * before publish. This proves a draft with no recipients can still carry
   * per-person content.
   */
  it("exists during the draft phase, before any recipient", async () => {
    await inRollback(async (client) => {
      const { rows: users } = await client.query<{ id: string }>(
        `INSERT INTO users (email, display_name, role)
         VALUES ('drafter@example.test', '起案者', 'admin') RETURNING id`,
      );
      const authorId = users[0]!.id;

      const { rows: drafts } = await client.query<{ id: string }>(
        "INSERT INTO announcements (created_by) VALUES ($1) RETURNING id",
        [authorId],
      );
      const draftId = drafts[0]!.id;

      await expect(
        client.query(
          `INSERT INTO announcement_personalizations
             (announcement_id, user_id, version_no, personal_body, change_kind, created_by)
           VALUES ($1, $2, 1, '大阪センターへ直行', 'initial', $2)`,
          [draftId, authorId],
        ),
      ).resolves.toBeTruthy();

      const { rows } = await client.query<{ count: string }>(
        "SELECT count(*) FROM announcement_recipients WHERE announcement_id = $1",
        [draftId],
      );
      expect(Number(rows[0]!.count)).toBe(0);
    });
  });
});

describe("content revisions", () => {
  it("refuses re-acknowledgement on a minor change", async () => {
    await inRollback(async (client) => {
      const { announcementId, ownerId } = await seed(client);

      // A typo fix must never be able to re-ask hundreds of people.
      await expect(
        client.query(
          `INSERT INTO announcement_content_revisions
             (announcement_id, version_no, title, body, change_kind,
              requires_reacknowledgement, created_by)
           VALUES ($1, 2, '明日の予定', '誤字修正', 'content_minor', true, $2)`,
          [announcementId, ownerId],
        ),
      ).rejects.toThrow(/ck_content_revision_reack_requires_major/);
    });
  });

  it("rejects a duplicate version number", async () => {
    await inRollback(async (client) => {
      const { announcementId, ownerId } = await seed(client);

      await expect(
        client.query(
          `INSERT INTO announcement_content_revisions
             (announcement_id, version_no, title, body, change_kind, created_by)
           VALUES ($1, 1, '重複', '本文', 'content_minor', $2)`,
          [announcementId, ownerId],
        ),
      ).rejects.toThrow(/uq_content_revision_version|duplicate key/);
    });
  });
});

describe("recipients", () => {
  it("holds each user at most once per announcement", async () => {
    await inRollback(async (client) => {
      const { announcementId, memberId } = await seed(client);

      // Being targeted via both a department and an individual designation
      // must still produce one recipient.
      await expect(
        client.query(
          `INSERT INTO announcement_recipients (announcement_id, user_id)
           VALUES ($1, $2)`,
          [announcementId, memberId],
        ),
      ).rejects.toThrow(/uq_announcement_recipient|duplicate key/);
    });
  });

  it("records several sources for one recipient", async () => {
    await inRollback(async (client) => {
      const { announcementId, ownerId, memberId, recipientId } = await seed(client);

      const { rows: versions } = await client.query<{ id: string }>(
        `INSERT INTO announcement_target_versions (announcement_id, version_no, created_by)
         VALUES ($1, 1, $2) RETURNING id`,
        [announcementId, ownerId],
      );
      const { rows: units } = await client.query<{ id: string }>(
        "INSERT INTO org_units (name) VALUES ('営業部') RETURNING id",
      );

      const { rows: targets } = await client.query<{ id: string }>(
        `INSERT INTO announcement_targets (target_version_id, target_kind, org_unit_id, user_id)
         VALUES ($1, 'org_unit', $2, NULL), ($1, 'user', NULL, $3)
         RETURNING id`,
        [versions[0]!.id, units[0]!.id, memberId],
      );

      await client.query(
        `INSERT INTO announcement_recipient_sources (recipient_id, target_id)
         VALUES ($1, $2), ($1, $3)`,
        [recipientId, targets[0]!.id, targets[1]!.id],
      );

      const { rows } = await client.query<{ count: string }>(
        "SELECT count(*) FROM announcement_recipient_sources WHERE recipient_id = $1",
        [recipientId],
      );
      expect(Number(rows[0]!.count)).toBe(2);
    });
  });
});
