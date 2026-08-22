# Announcement model (frozen)

Status: **frozen**. Field names, state semantics and transaction boundaries in
this document are settled. Changing anything here after the migrations exist
means rewriting foreign keys and indexes, so changes require an explicit
decision recorded at the bottom of this file.

This is the construction drawing for identity, organisation and announcements. It defines what the database
looks like, what each command is allowed to do, and — equally important — what
is forbidden.

---

## Why this model is shaped the way it is

The product claim is that acknowledgement statistics are **trustworthy and
explainable**. Every number the administrator sees must be answerable: who is in
the denominator, why, and since when.

That claim fails if any of the following are possible:

- a completed acknowledgement disappears from history
- the same person counts twice in one denominator
- the denominator changes because somebody was transferred between departments
- an administrator triggers a command, sees "success", and nobody is affected
- a published announcement notifies nobody because the notification write failed

Each table and constraint below exists to make one of those impossible.

---

## 1. Entity responsibilities

Six concepts, each answering exactly one question. Conflating any two of them is
what produces statistics nobody can explain.

| Table                                                   | Answers                                             |
| ------------------------------------------------------- | --------------------------------------------------- |
| `announcement_content_revisions`                        | What did the shared body say, at which version?     |
| `announcement_target_versions` + `announcement_targets` | Who was the announcement _aimed_ at?                |
| `announcement_recipients`                               | Who was actually included when it was published?    |
| `announcement_recipient_sources`                        | Why was this person included? (history only)        |
| `announcement_personalizations`                         | What was written _for this specific person_?        |
| `announcement_ack_obligations`                          | Who is required to acknowledge which exact content? |
| `announcement_acknowledgements`                         | Who actually acknowledged, and when? (evidence)     |

**Target** is the administrator's logical intent ("営業部"). **Recipient** is the
materialised fact ("these 10 users, at publish time"). **Obligation** is the
demand placed on one recipient for one exact content combination.
**Acknowledgement** is immutable evidence that the demand was met.

---

## 2. Decision 1 — Personalization exists during the draft phase

`announcement_personalizations` is keyed by `(announcement_id, user_id)` and
**never references a recipient**.

The reason is a hard ordering constraint: the announcement editor requires the
administrator to expand a department, type per-person content, import CSV and
save a draft — all of which happen _before_ publish, and recipients do not exist
until publish. Keying personalization to a recipient would leave that content
with nowhere to live.

Removing a target department during the draft phase must **not** delete already
written personal content. The administrator may be reorganising and may add the
department back. Content that never becomes a recipient is simply never
published and is never visible to ordinary members.

```sql
CREATE TABLE announcement_personalizations (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  announcement_id   uuid NOT NULL REFERENCES announcements(id),
  user_id           uuid NOT NULL REFERENCES users(id),
  version_no        integer NOT NULL,
  personal_body     text NOT NULL,
  change_kind       text NOT NULL,
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  superseded_at     timestamptz,

  CONSTRAINT ck_personalization_change_kind
    CHECK (change_kind IN ('initial', 'personal_minor', 'personal_major'))
);

-- At most one live personal content version per person per announcement.
CREATE UNIQUE INDEX uq_active_personalization
  ON announcement_personalizations (announcement_id, user_id)
  WHERE superseded_at IS NULL;

CREATE UNIQUE INDEX uq_personalization_version
  ON announcement_personalizations (announcement_id, user_id, version_no);
```

At publish, the binding is formed:

```text
Recipient
  + current published content revision
  + current live personalization revision   (NULL when the person has none)
  = Obligation
```

---

## 3. Decision 2 — Waive only touches unacknowledged live obligations

`waive_obligations` selects **only**:

```sql
waived_at IS NULL
AND superseded_at IS NULL
AND NOT EXISTS (
  SELECT 1 FROM announcement_acknowledgements ack
   WHERE ack.obligation_id = announcement_ack_obligations.id
)
```

**An acknowledged obligation can never be waived.** Acknowledgement is a
historical fact that already happened; letting a later administrative action
erase it from the statistics would make every reported figure unfalsifiable.

The database cannot express this as a `CHECK` — `waived_at` lives on
obligations, the acknowledgement lives in another table. It is enforced in the
application layer and covered by a mandatory test (see §11).

### User disable

| Obligation state     | Action                                     |
| -------------------- | ------------------------------------------ |
| Live, unacknowledged | Waive, `waived_reason = 'user_disabled'`   |
| Live, acknowledged   | **Leave untouched** — history is preserved |
| Already waived       | No action                                  |
| Already superseded   | No action                                  |

### User restore

**Old obligations are not restored automatically.** Re-enabling an account must
not silently drop dozens of stale tasks on someone, nor silently change a
historical statistic. If the person genuinely needs to acknowledge something
again, an administrator runs `assign_obligations` explicitly, and that action is
recorded.

Being transferred out of a department does **not** waive anything. Only an
explicit administrative command does.

---

## 4. Decision 3 — `assign_obligations` binds the published body, never a draft

Taking "the latest revision" is wrong: the latest row may still be a draft.
Obligations must reference the currently **published** body.

```sql
announcements.current_published_content_revision_id
```

`assign_obligations` reads that column. **If it is NULL, the command fails** with
`ANNOUNCEMENT_NOT_PUBLISHED`. It must never quietly bind a draft — that would
demand acknowledgement of text the administrator has not released.

### Eligibility

```sql
SELECT recipient.id
  FROM announcement_recipients recipient
  JOIN users u ON u.id = recipient.user_id
 WHERE recipient.announcement_id = $1
   AND u.disabled_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM announcement_ack_obligations o
      WHERE o.recipient_id = recipient.id
        AND o.waived_at IS NULL
        AND o.superseded_at IS NULL
   );
```

### Frozen at creation

Each new obligation permanently records:

- the **currently published** content revision
- that user's **currently live** personalization revision (or NULL)
- the final `due_at`, resolved once (see §7)

### `assign_obligations` vs `request_reacknowledgement`

These are separate commands with **complementary** filters. Confusing them
produces the silent failure this model exists to prevent.

|         | `assign_obligations`                                                   | `request_reacknowledgement`                                        |
| ------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Targets | Recipients with **no** live obligation                                 | Recipients **with** a live obligation                              |
| Use for | First-time demand, target expansion, manual reassignment after restore | Major body edit, major personal content edit                       |
| Effect  | Creates a first obligation                                             | Supersedes the old one, creates a successor                        |
| Skips   | Disabled users, anyone already holding a live obligation               | Disabled users, waived, superseded, anyone with no live obligation |

A person with no live obligation can **only** be reached through
`assign_obligations`. A person holding one can **only** be reached through
`request_reacknowledgement`.

---

## 5. Decision 4 — Notification idempotency keys are specific

The vague `required_announcement` event type is removed. Event types are:

```text
obligation.assigned              first obligation for this recipient
obligation.reassigned            successor after a major change
obligation.deadline_reminder_24h 24 hours before due_at
```

```sql
CREATE UNIQUE INDEX uq_obligation_notification
  ON notifications (obligation_id, event_type)
  WHERE obligation_id IS NOT NULL;
```

Because the key includes the event type, first assignment, re-acknowledgement
and the deadline reminder never collide, and a retrying worker cannot produce a
duplicate email.

Notifications are generated **per obligation, never per announcement**. This is
what makes the following correct without any special-casing:

| Situation                                         | Who is notified                                                            |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| Add 総務部 to a published announcement            | Only the 5 new people. 営業部's original 10 get nothing.                   |
| Edit only 田中's personal content, require re-ack | Only 田中.                                                                 |
| Major body edit, require re-ack                   | Everyone holding a live obligation. Waived and disabled users get nothing. |
| Announcement requires no acknowledgement          | No obligations exist, so nobody is notified.                               |

v1.0 sends exactly one reminder, so this model is sufficient. Adding multiple
reminders later requires a `notification_key` or a reminder instance id — **not**
a change to this index.

---

## 6. Decision 5 — Recipient sources are history, never current state

```sql
CREATE TABLE announcement_recipient_sources (
  recipient_id  uuid NOT NULL REFERENCES announcement_recipients(id),
  target_id     uuid NOT NULL REFERENCES announcement_targets(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recipient_id, target_id)
);
```

It answers exactly one question: _why was this person included at the time?_
For example: 田中 was included via 営業部 **and** 第一営業所 **and** an individual
designation.

### Forbidden

`announcement_recipient_sources` **must not** be used to determine:

- whether a user is currently within the target scope
- whether a user is still covered after a department is removed
- who should receive newly assigned obligations
- who should currently be able to see the announcement

The `target_id` it stores points at a target row belonging to a **historical**
target version. After a new target version is created, those rows describe the
old scope and answering current questions with them gives the wrong answer.

### Required instead

Any "is this user currently in scope?" question is answered by re-resolving:

```text
current target version → TargetResolver → current user_id set → compare
```

```ts
interface TargetResolver {
  resolveUsers(targetVersionId: string): Promise<Set<string>>;
}
```

Removing a target department creates a new target version and changes what
`TargetResolver` returns. It does **not** delete recipients, does **not** delete
sources, and does **not** waive obligations. Stopping outstanding demands
requires an explicit `waive_obligations`.

---

## 7. Due dates

Three possible sources, resolved once and then frozen.

```text
announcements.acknowledgement_due_at          announcement default
announcement_user_due_overrides.due_at        per-person override (draft-phase capable)
announcement_ack_obligations.due_at           the authority, once created
```

The override table is keyed by `(announcement_id, user_id)` — **not** by
recipient, for the same reason as personalization: CSV import happens before
publish. Note the name carries no "recipient".

```sql
CREATE TABLE announcement_user_due_overrides (
  announcement_id uuid NOT NULL REFERENCES announcements(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  due_at          timestamptz,
  updated_by      uuid NOT NULL REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);
```

Resolution when creating an obligation:

```text
per-user override  >  announcement default  >  no deadline
```

**The reminder worker reads `obligation.due_at` and nothing else.** It must never
`COALESCE` across tables at send time: if it did, editing the announcement
default would retroactively move every existing deadline with no record of the
change, and the history would stop being explainable.

Changing `announcements.acknowledgement_due_at` affects only obligations created
afterwards. Applying it to existing ones requires an explicit checkbox, updates
only **live, unacknowledged** obligations, and writes an announcement event plus
an audit log entry. The response reports how many were changed.

---

## 8. Decision 6 — Users and org units are never physically deleted

System invariant.

```text
users      → disable / restore / anonymize
org_units  → disable / restore
```

No `DELETE /users/:id` or `DELETE /org-units/:id` exists. Historical targets,
recipients, obligations, events and audit logs reference these ids indefinitely,
and physical deletion would either break those references or cascade away the
evidence the model is built to preserve.

When privacy law requires erasure, `anonymize_user` clears name, email, phone
and avatar while keeping the stable id and all relationships intact.

Because deletion is impossible, targets can use real foreign keys instead of a
polymorphic `target_id`, so the database itself enforces referential integrity:

```sql
CREATE TABLE announcement_targets (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  target_version_id uuid NOT NULL REFERENCES announcement_target_versions(id),
  target_kind       text NOT NULL,
  org_unit_id       uuid REFERENCES org_units(id),
  user_id           uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_target_reference CHECK (
    (target_kind = 'all'      AND org_unit_id IS NULL     AND user_id IS NULL)
    OR (target_kind = 'org_unit' AND org_unit_id IS NOT NULL AND user_id IS NULL)
    OR (target_kind = 'user'     AND org_unit_id IS NULL     AND user_id IS NOT NULL)
  )
);
```

---

## 9. Obligations and acknowledgements

```sql
CREATE TABLE announcement_ack_obligations (
  id                          uuid PRIMARY KEY DEFAULT uuidv7(),
  recipient_id                uuid NOT NULL REFERENCES announcement_recipients(id),
  content_revision_id         uuid NOT NULL REFERENCES announcement_content_revisions(id),
  personalization_revision_id uuid REFERENCES announcement_personalizations(id),
  previous_obligation_id      uuid REFERENCES announcement_ack_obligations(id),
  assigned_at                 timestamptz NOT NULL DEFAULT now(),
  due_at                      timestamptz,
  waived_at                   timestamptz,
  waived_reason               text,
  superseded_at               timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_obligation_not_waived_and_superseded
    CHECK (NOT (waived_at IS NOT NULL AND superseded_at IS NOT NULL)),

  CONSTRAINT ck_obligation_waive_reason CHECK (
    (waived_at IS NULL AND waived_reason IS NULL)
    OR (waived_at IS NOT NULL AND waived_reason IS NOT NULL)
  )
);

-- The single most important constraint in the schema: one recipient can hold
-- at most one live obligation. Without it, any logic bug double-counts a person
-- in the denominator and the error is undetectable after the fact.
CREATE UNIQUE INDEX uq_active_obligation_per_recipient
  ON announcement_ack_obligations (recipient_id)
  WHERE waived_at IS NULL AND superseded_at IS NULL;

CREATE TABLE announcement_acknowledgements (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  obligation_id   uuid NOT NULL REFERENCES announcement_ack_obligations(id),
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  client_type     text NOT NULL,
  device_id       uuid REFERENCES user_devices(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- One obligation is acknowledged at most once. Re-acknowledgement creates a new
-- obligation; it never overwrites this evidence.
CREATE UNIQUE INDEX uq_acknowledgement_once
  ON announcement_acknowledgements (obligation_id);
```

`personalization_revision_id` is nullable — most people on a plain announcement
have no personal content.

When a major body edit requires re-acknowledgement, the successor obligation
carries the user's **currently live** personalization revision. It is never set
to NULL: doing so would make 田中's personal instructions vanish from what he is
being asked to confirm.

### State is derived, never stored

There is no `status` column. A stored status drifts from the timestamps that
actually define it.

| State        | Derivation                                                                  |
| ------------ | --------------------------------------------------------------------------- |
| pending      | `waived_at IS NULL AND superseded_at IS NULL` and no acknowledgement        |
| acknowledged | `waived_at IS NULL AND superseded_at IS NULL` and an acknowledgement exists |
| waived       | `waived_at IS NOT NULL`                                                     |
| superseded   | `superseded_at IS NOT NULL`                                                 |

The API still returns a computed `"status": "acknowledged"`. Only the storage
layer refuses to duplicate it.

---

## 10. Acknowledgement rate

```sql
SELECT
  COUNT(*) FILTER (WHERE ack.id IS NOT NULL) AS acknowledged_count,
  COUNT(*)                                   AS obligation_count
FROM announcement_ack_obligations o
LEFT JOIN announcement_acknowledgements ack ON ack.obligation_id = o.id
WHERE o.waived_at IS NULL
  AND o.superseded_at IS NULL;
```

- **Denominator**: all live obligations
- **Numerator**: live obligations that have an acknowledgement

There is no `required` flag. An announcement that needs no acknowledgement
creates no obligations, so a boolean distinguishing them would never be false
and would only add a condition every statistics query could forget.

Not in the denominator: current department headcount, current target headcount,
total recipients, waived obligations, superseded obligations, disabled users.

---

## 11. Transaction boundaries

Every obligation-creating path goes through one service —
`ObligationAssignmentService` — so these rules cannot be bypassed.

**Re-acknowledgement** must run in a single transaction, in this order. The
partial unique index requires the old row to stop being live _before_ the new
one is inserted:

```text
BEGIN
  SELECT ... FOR UPDATE            lock the live obligation
  UPDATE  superseded_at = now()    old row leaves the live set
  INSERT  new obligation           previous_obligation_id = old.id
  INSERT  notification outbox      obligation.reassigned
  INSERT  announcement event
  INSERT  audit log
COMMIT
```

**Publish** writes everything or nothing:

```text
BEGIN
  resolve current target version → user set
  INSERT recipients (deduplicated by user)
  INSERT recipient sources
  read live personalization per user
  read due overrides per user
  INSERT obligations (due_at frozen)
  INSERT notification outbox (obligation.assigned per obligation)
  UPDATE announcements.current_published_content_revision_id
COMMIT
```

The notification outbox row is written **inside the publish transaction**. This
is the whole point of the transactional outbox: an announcement that is
published but notifies nobody is the failure this system must never produce.
SMTP delivery happens afterwards from a worker; SMTP being down delays mail, it
never loses it.

**CSV import** of 500 rows is one transaction. Twenty-three of fifty rows
succeeding is not an acceptable state.

---

## 12. Command results are never silently empty

Every administrative command returns a summary:

```json
{
  "eligibleCount": 10,
  "createdCount": 10,
  "skippedDisabledCount": 0,
  "skippedExistingActiveCount": 0,
  "skippedNoActiveObligationCount": 0,
  "skippedAlreadyAcknowledgedCount": 0
}
```

When an administrator explicitly runs a command and `createdCount` is 0, the API
returns **422**, not 200:

```json
{
  "code": "NO_ELIGIBLE_RECIPIENTS",
  "message": "No recipients matched the conditions for this operation."
}
```

The confirmation dialog shows the projected effect _before_ execution:

```text
確認義務を新規作成： 10名
停止中のためスキップ：  2名
既に有効な義務あり：    3名
```

The failure being designed out: the UI says "acknowledgement requested", zero
people receive it, the rate reads 0/0, and it looks like a normal empty state.

---

## 13. Error codes

| Code                              | Status | Meaning                                           |
| --------------------------------- | ------ | ------------------------------------------------- |
| `NO_ELIGIBLE_RECIPIENTS`          | 422    | Command matched nobody                            |
| `ANNOUNCEMENT_NOT_PUBLISHED`      | 422    | No published content revision to bind             |
| `OBLIGATION_ALREADY_ACKNOWLEDGED` | 422    | Attempted waive of an acknowledged obligation     |
| `OBLIGATION_NOT_LIVE`             | 409    | Target obligation is waived or superseded         |
| `PERSONALIZATION_STALE`           | 409    | Concurrent edit replaced the version being edited |

---

## 14. Events versus audit logs

Both are written for the same action. They must never be merged.

|                        | `announcement_events`                  | `audit_logs`                                                               |
| ---------------------- | -------------------------------------- | -------------------------------------------------------------------------- |
| Audience               | Administrators, in the announcement UI | Security and compliance                                                    |
| Language               | Human-readable business narrative      | Structured actor / action / resource                                       |
| Content                | "佐藤が09:30に総務部を追加しました"    | `actor`, `action`, `resource`, `outcome`, `ip`, `user_agent`, `request_id` |
| Scope                  | Announcement lifecycle only            | Every sensitive operation system-wide                                      |
| Mutability             | Append-only                            | Append-only, not modifiable even by Owner                                  |
| Retention              | With the announcement                  | Independently configured                                                   |
| On announcement delete | May cascade                            | **Never cascades**                                                         |

---

## 15. Worked scenarios

| Action                                   | Result                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| New member joins 第一営業所              | Can read still-visible historical announcements. Gains no historical obligations.                                                          |
| Add 総務部 to a published announcement   | New target version. Recipients added for the 5 new people only. 5 obligations, 5 emails. Denominator 10 → 15.                              |
| Fix a typo                               | `content_minor` revision. No new obligations. Nobody re-notified.                                                                          |
| Change tomorrow's meeting time           | `content_major` + `requires_reacknowledgement`. Live obligations superseded, successors created carrying each user's live personalization. |
| Edit only 田中's personal content, major | Only 田中's obligation superseded. One successor, one email. Everyone else unchanged.                                                      |
| Remove 総務部                            | New target version. Recipients, sources and obligations all retained. Nothing auto-waived.                                                 |
| Disable a user                           | Unacknowledged live obligation waived as `user_disabled`. Acknowledged ones untouched.                                                     |
| Restore that user                        | Nothing restored automatically. Administrator must run `assign_obligations`.                                                               |
| Administrator revokes a session          | Device and push subscription both survive.                                                                                                 |
| API token leaks                          | Revoke the hash row. Nothing needs decrypting.                                                                                             |

---

## 16. Demo data

Demo and seed data use **第一営業所**. Place names tied to any real organisation
must not appear in the repository, screenshots, or recordings.

---

## Change log

| Date       | Change                                        |
| ---------- | --------------------------------------------- |
| 2026-08-06 | Frozen. Supersedes revision drafts v0.1–v0.4. |
