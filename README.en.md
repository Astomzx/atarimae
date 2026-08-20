# Atarimae

**当たり前のことが、当たり前にできる社内掲示板** — a communication board where
the basics just work.

A free, self-hosted announcement and communication board for small companies. No
per-seat pricing, no user limit, open source under AGPL-3.0. There is no hosted
service and nobody to contact.

📖 **日本語: [README.md](README.md)** — the primary version, and the one the
author reads.

---

## Why this exists

The same walls, over and over, in software that companies pay for:

- an administrator who cannot add another administrator
- one account that cannot be used on both the office PC and a phone in the field
- a company that cannot get its own data back out

None of these are advanced features. **They are the basics.** Atarimae is what
happens when the basics are implemented as basics.

| The thing                              | How it works here                                       |
| -------------------------------------- | ------------------------------------------------------- |
| An administrator adds an administrator | On the permissions screen. No request, no waiting       |
| One account, several devices           | Concurrent sessions, each revocable by their owner      |
| A company exports its own data         | CSV per announcement, and a whole-system backup archive |

---

## What it does

### One announcement carries both the notice and each person's instructions

```
明日の予定                          ← the shared body, for everybody
朝礼は8時30分から。全員参加してください。

あなたの担当                        ← shown only to that one person
8:30 第一営業所集合、その後A区域を担当
```

田中 sees only 田中's assignment; 佐藤 sees only 佐藤's. What the acknowledgement
button records is **the combination that person actually saw** — shared body plus
their own section.

Typing forty of those by hand is not realistic, so assignments come in by CSV:
download the roster, fill the column in Excel, upload it back.

### Acknowledgement statistics you can explain

The denominator is **currently active acknowledgement obligations** — not the
department's headcount, not the number of addressees, not the total delivered.
Which is what makes these true:

- The recipients are fixed at publication, so a later transfer never changes a
  past acknowledgement rate.
- A disabled member drops out of the denominator (otherwise the rate never
  reaches 100% while anybody cannot sign in).
- But if that person had already acknowledged, their record stays.
- An acknowledgement already given cannot be waived, not even by an administrator.

**"Sent for acknowledgement" is never displayed when it reached nobody.** A
command that affects zero people returns 422 with a breakdown, never 200 with a
zero. That is the central claim of this product, so the same rule applies to
every endpoint in it.

Also, around announcements:

- Targeting by department, branch or team, or by individual
- Deadlines, with an email reminder 24 hours before — sent exactly once
- CSV export of acknowledgement results
- An audit log of administrative actions

### Chat and calls

**Chat.** Channels (public and private) and one-to-one conversations, file
attachments, mentions, unread counts with mentions distinguished from them, and
a WebSocket for immediacy.

Some things are deliberately absent until after v1.0: editing, deletion,
reactions, link previews, search, threads, presence, typing indicators. **The
interface matches the implemented scope exactly** — nothing is stubbed and
nothing is disabled-with-a-tooltip.

**Calls** are network calls, the way LINE and WeChat do them — not telephone
calls. One-to-one and group are not two features: a call belongs to a channel,
and a channel is either a conversation or a group.

Atarimae does not carry the audio and is not going to. **Point it at the Jitsi
already running in your server cupboard and the calls never leave the building.**
What Atarimae holds is who is being called, when it started, whether anybody
answered, and the record afterwards. The room opens in its own window, and is
embedded in the page only when an administrator says their provider permits it.

### Phone, PC, and no signal at all

**Nothing exists at one width and not the other.** No phone-only feature, no
desktop-only feature; the E2E suite runs the same scenarios at both.

- **PWA** — installable, with Web Push notifications.
- **Offline** — your own announcements stay readable with no network, and
  **every one carries the time it was fetched, unmissably on screen**. That
  stamp is the whole of the argument for allowing this at all — a driver in a
  basement reading yesterday's roster as today's is the failure — and an E2E
  test fails without it. Acknowledging offline records nothing, and says so.
- **Windows desktop client** — a taskbar window. Inside it is the same web
  application the server serves; there is no Windows-only feature. It asks
  where your server is, and refuses an address that does not answer.

### Integrating

- **OpenAPI 3.1** — `apps/server/openapi.json` is generated, committed, and CI
  fails when it drifts. Browsable at `/docs` in development.
- **Service accounts** — an integration is not a person's token. It is a
  different kind of account in the same table, and it cannot hold Owner.
- **Webhooks** — delivered from an outbox with retries, and the timestamp is
  signed together with the body. A webhook may not point inside your network
  (a call provider may — the reasons differ, and both are in
  `docs/architecture/webhooks.md`).

### Operating it

- **Backup** — database and attachments in one archive, checked before it is
  written. `pnpm backup:verify` reads an archive and touches nothing else.
  Restore proves the result matches.
- **Optional archive encryption** — delegated to `age`. **This project never
  generates or holds a key**; it encrypts to a public key you already manage.
- **Security** — Argon2id passwords, AES-256-GCM for credentials that must be
  replayed elsewhere, sign-in rate limiting, an audit log, and a strict CSP.
  The line that matters most is `frame-ancestors 'none'`: a page that can be
  framed can be covered, and then a click lands on 確認 — the record would be
  correct and the claim it supports would be false.

---

## Screenshots

**Not yet.** For now the acceptance scenarios are the evidence that it works:
[M1](e2e/tests/m1-acceptance.spec.ts), [M2](e2e/tests/m2-ui.spec.ts),
[M3a](e2e/tests/m3a-ui.spec.ts), [M4](e2e/tests/m4-pwa.spec.ts),
[M5](e2e/tests/m5-ui.spec.ts), [calls](e2e/tests/m5-calls.spec.ts) — each run at
desktop and phone widths.

---

## Deploying

You need Docker, and TLS in front of it: session cookies are `Secure` in
production, so sign-in does not work without it.

```bash
git clone https://github.com/Astomzx/atarimae.git
```

```bash
node scripts/setup-env.mjs
```

Set `PUBLIC_ORIGIN` in the generated `.env`, then:

```bash
docker compose up -d
```

```bash
docker compose exec app node scripts/db.mjs up
```

Open the address and create the first Owner. There is no activation step and
nobody to contact.

Full instructions, including TLS, SMTP, backups and updating:
**[docs/deployment/docker.md](docs/deployment/docker.md)**

> **Back up `ENCRYPTION_KEY_CURRENT` separately from your database dumps.**
> Losing it permanently destroys every stored external credential.

> **Behind a reverse proxy, set `TRUSTED_PROXY_IPS`.** Without it the whole
> office shares one sign-in rate-limit budget.

---

## Development

| Tool       | Version              | Why                                            |
| ---------- | -------------------- | ---------------------------------------------- |
| Node.js    | 22+ (24 recommended) | `process.loadEnvFile`                          |
| pnpm       | 10+                  | workspace management                           |
| PostgreSQL | **18+**              | `uuidv7()` and the builtin `C.UTF-8` collation |

PostgreSQL 18 is a hard floor, not a preference. The collation is a correctness
requirement: libc collations differ between a Windows development machine and a
Linux container, which silently changes ORDER BY results and unique index
behaviour. See [docs/architecture/decisions.md](docs/architecture/decisions.md).

```bash
pnpm install
```

```bash
node scripts/setup-env.mjs
```

```bash
pnpm db:reset
```

```bash
pnpm dev
```

- Web client: http://localhost:5173
- API: http://localhost:3000/api/v1
- API docs (development only): http://localhost:3000/docs

### Checks

```bash
pnpm check
```

Builds, then runs format check, lint, typecheck and unit tests — the same gates
as CI, in the same order.

```bash
pnpm test:e2e
```

Playwright, at desktop and phone widths. Browsers need installing once:

```bash
pnpm --filter @atarimae/e2e install-browsers
```

**Those two are safe to run at the same time.** The unit suite and the E2E suite
have a database each, and the names are derived from the checkout rather than
configured. Why, and what it cost before they were:
[docs/engineering/shared-test-database.md](docs/engineering/shared-test-database.md).

### Database

Migrations are plain SQL with both directions mandatory. `pnpm db:verify` runs
`up → down → up` and fails if any migration cannot be rolled back.

| Command              | What it does                                  |
| -------------------- | --------------------------------------------- |
| `pnpm db:new <name>` | Scaffold a migration, both directions stubbed |
| `pnpm db:up`         | Apply pending migrations                      |
| `pnpm db:down`       | Roll back the most recent one                 |
| `pnpm db:status`     | Show applied and pending                      |
| `pnpm db:reset`      | Drop, recreate and migrate the dev database   |
| `pnpm db:verify`     | Prove every migration is reversible           |

Append `--test` to target the test database, and `--e2e` for the E2E one.

### Backups

```bash
pnpm backup                      # database + attachments, one archive
pnpm backup:verify <file>        # read an archive, touch nothing else
pnpm restore <file> [--force]    # put one back, then prove it matches
```

---

## Layout

```text
atarimae/
├─ apps/
│  ├─ server/          Fastify 5 + TypeBox, REST + OpenAPI 3.1, WebSocket
│  ├─ web/             React 19 + Vite 6 + TanStack Query
│  └─ desktop/         Tauri (Rust). Outside the pnpm workspace on purpose
├─ packages/
│  ├─ api-schema/      TypeBox schemas — the single source of truth for types
│  ├─ secret-store/    AES-256-GCM, only for credentials replayed elsewhere
│  └─ backup/          The archive format, and backup / verify / restore
├─ migrations/         Plain SQL, up and down
├─ e2e/                Playwright
└─ docs/
   ├─ architecture/    Frozen data model, technical decisions
   ├─ deployment/      Docker
   └─ engineering/     Defects found while building, and their guards
```

Request and response types are defined once in `packages/api-schema` and reused
by Fastify for validation, by `@fastify/swagger` for the OpenAPI document, and by
the web client for its types.

The announcement data model is **frozen** and documented in
[docs/architecture/announcement-model.md](docs/architecture/announcement-model.md).
It explains not only what the tables are, but which failure each constraint
exists to make impossible.

---

## Status

| Milestone |                                              | State           |
| --------- | -------------------------------------------- | --------------- |
| M0        | Foundation, CI, migrations, E2E              | done            |
| M1        | Accounts, org units, permissions             | done            |
| M2        | Announcements, per-person content, SMTP, CSV | done            |
| M3a       | Chat and attachments                         | done            |
| M4        | PWA, push, Windows client                    | done            |
| M5        | Open API, webhooks, calls                    | done            |
| M6a       | Security, attachments, backup and restore    | done            |
| **M6b**   | Documentation, screenshots, release          | **in progress** |

496 server unit tests, 74 web unit tests, 47 backup, 20 secret-store, 18 desktop
(Rust), 158 E2E, 11 migrations. CI is green.

**The counts are here because this product's value is that its claims are
checkable.** A rule enforced only by a comment is not enforced.

---

## Where the interesting reading is

Possibly faster than reading the code.

| Document                                                            | What it is                                                                    |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [announcement-model.md](docs/architecture/announcement-model.md)    | Why acknowledgement statistics are trustworthy, constraint by constraint      |
| [security.md](docs/architecture/security.md)                        | Why clickjacking, of all things, is the attack this product has to care about |
| [calls.md](docs/architecture/calls.md)                              | What Atarimae refuses to carry, and what that costs                           |
| [attachments.md](docs/architecture/attachments.md)                  | The four upload rules and the hole each one closes                            |
| [backup.md](docs/architecture/backup.md)                            | Why the encryption key is not in the archive                                  |
| [pwa.md](docs/architecture/pwa.md)                                  | Where an offline client nearly breaks this product's own rule                 |
| [reconsidering.md](docs/architecture/reconsidering.md)              | Six refusals, re-examined one at a time                                       |
| [m0-regressions.md](docs/engineering/m0-regressions.md)             | Eleven real defects, each with the test that now prevents it                  |
| [shared-test-database.md](docs/engineering/shared-test-database.md) | How long it takes to notice the measurement is what is broken                 |

`reconsidering.md` is the method as much as the content: a refusal written down
in enough detail to be checked is a refusal somebody can find the error in. Four
of the six were overturned that way.

---

## Security

Report vulnerabilities privately: **[SECURITY.md](SECURITY.md)**. It also states
plainly what the design already assumes, so nobody wastes time reporting a
deliberate decision.

---

## License

[AGPL-3.0-only](LICENSE).

You may use, modify and self-host this freely. If you run a modified version as a
network service, that version's source must be made available to its users.

This is deliberate: it keeps anyone from taking this, closing it, and charging
per employee for it.

Known cost: some companies' legal departments refuse AGPL outright, so adoption
will be lower than under MIT. That trade is accepted.

---

## Project status and support

This project is maintained by one person, as a piece of work and a technical
argument.

- No hosted service
- No SLA
- No promised release cadence
- No phone support, site visits, or free deployment assistance

Companies using it are responsible for their own deployment, backups, security
configuration and operation.

Issues are welcome: reproducible bugs, security problems, documentation
improvements, and generally useful feature proposals. Customisation for a
specific company, unpaid deployment work, and committed fix dates are not things
this project can offer.

**PRs are welcome.**
