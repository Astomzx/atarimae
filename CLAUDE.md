# Atarimae — working notes

Read this before touching anything. It is the handover between sessions.

**What this is**: a self-hosted announcement board for small Japanese companies,
built as a personal project and as a pointed argument about enterprise software.
The tagline — 当たり前のことが、当たり前にできる — means the basics should just
work: an administrator can add an administrator, one account works on several
devices, an organisation can export its own data.

## Non-negotiable rules

These are settled decisions, not preferences. Changing one needs an explicit
discussion, not a quiet refactor.

1. **`docs/architecture/announcement-model.md` is frozen.** Field names, state
   semantics and transaction boundaries are fixed. It documents not just what
   the tables are but which failure each constraint makes impossible. Read it
   before touching anything announcement-related.

2. **Every constraint has a test.** The project's value is that its claims are
   verifiable. A rule enforced only by a code comment is not enforced.

3. **Silent success is the enemy.** A command that affects nobody returns 422
   with a breakdown, never 200 with a zero. This is the whole thesis of the
   product; it applies to new endpoints too.

4. **Migrations are plain SQL with a working Down Migration.** `pnpm db:verify`
   runs up → down → up in CI. Comments in migrations explain _why_ a constraint
   exists, not what it does.

5. **PostgreSQL 18 minimum.** `uuidv7()` and the builtin `C.UTF-8` collation.
   The collation is a correctness requirement — libc collations differ between
   a Windows dev machine and a Linux container, which silently changes ORDER BY
   and unique index behaviour.

6. **`pnpm check` is the gate.** It builds first, then format/lint/typecheck/test
   — the same order as CI, so local green means CI green. Run it before every
   commit. Run `pnpm test:e2e` too when touching routes or the interface.

7. **Users and org_units are never deleted.** disable / restore, plus anonymize
   for users. Historical references must stay resolvable.

8. **Japanese first.** Interface text is Japanese. Server error `message` fields
   are English and developer-facing; the client maps `code` to a Japanese
   message in one table (`apps/web/src/api.ts`).

9. **Phone and PC are not two different products.** No feature exists on one
   and not the other. E2E runs at both widths.

## Personal red lines (the author's, and they matter)

- Never use the name 吉富運輸, or any real company, in code, comments, demo data
  or documentation.
- Demo data uses **第一営業所**, never a real place name.
- No claim that this replaces a specific named commercial product.
- The repository must not contain the author's real name, personal email, or
  machine-specific paths. `.claude/launch.json` is git-ignored for this reason.

## Commands

```bash
pnpm check          # build + format + lint + typecheck + unit tests
pnpm test:e2e       # Playwright, desktop and phone widths
pnpm dev            # API on :3000, web on :5173
pnpm db:reset       # drop, recreate, migrate the dev database
pnpm db:verify      # prove every migration is reversible
pnpm db:new <name>  # scaffold a migration

pnpm backup         # one archive: database + attachments, checked before writing
pnpm backup:verify <file>       # read an archive, touch nothing else
pnpm restore <file> [--force]   # put one back, then prove it matches
```

`--test` on any `db:` command targets the test database.

## Layout

```
apps/server    Fastify 5 + TypeBox, REST + OpenAPI 3.1, WebSocket
apps/web       React 19 + Vite 6 + TanStack Query + react-router
packages/api-schema    TypeBox schemas — single source of truth for types
packages/secret-store  AES-256-GCM, only for credentials replayed elsewhere
packages/backup        backup / verify / restore, and the archive format
migrations     plain SQL, up and down
e2e            Playwright
docs/architecture   frozen model, technical decisions
docs/engineering    every defect found while building, and its guard
docs/deployment     Docker
```

Only top-level request/response schemas carry `$id`. A named schema referenced
twice inside one response breaks Fastify's serializer.

## Status

| Milestone                                                        | State       |
| ---------------------------------------------------------------- | ----------- |
| M0 foundation                                                    | done        |
| M1 accounts, org units, permissions                              | done        |
| M2 announcements, per-person content, acknowledgement, SMTP, CSV | done        |
| M3a chat                                                         | done        |
| M4 PWA + Tauri                                                   | done        |
| M5 open API, webhooks, 通話 providers                            | done        |
| M6a security, attachments, backup/restore                        | done        |
| M6b documentation, screenshots, release                          | not started |

496 server unit tests, 74 web unit tests, 47 backup, 20 secret-store,
18 desktop (Rust), 154 E2E, 11 migrations. CI green.

## Suggested order from here

1. **M6b** — three-language README, screenshots, demo video, release.

M6a is done. `docs/architecture/security.md` is what was defended and what was
not; `docs/engineering/m6a-security.md` is what the pass found.

**`TRUSTED_PROXY_IPS` is new and matters.** `request.ip` is what the sign-in
rate limit is keyed on and what `audit_logs` records, so `X-Forwarded-For` is
now believed only from addresses an operator names, and from nobody by default.
Any deployment behind a reverse proxy must set it or the whole office shares one
rate-limit budget.

**The database pool has an `error` listener, and must keep one.** A pooled
connection that fails while idle has no caller to reject, so `pg` emits `error`
on the pool — and an unhandled `error` event is rethrown by Node as an uncaught
exception. Without the listener, a failover, a restart, an idle-session timeout
or one `pg_terminate_backend` killed the whole server. `createDatabase` attaches
one whoever builds the pool, and `db.test.ts` proves it.

**The desktop client is not in the pnpm workspace.** `apps/desktop` has no
`package.json` on purpose, so `pnpm -r build` never reaches it and `pnpm check`
stays a Node-only gate that runs in seconds. Its commands are `desktop:*` on
the root package; see `docs/architecture/desktop.md`.

**通話 is network calls, not telephone calls** — and both one-to-one and group
calls, from the same mechanism: a call belongs to a channel, and a channel is
either a conversation or a group. The provider carries the media; Atarimae
carries everything else. `docs/architecture/calls.md` says what that buys and
what it costs.

**The call room can now be embedded, and `reconsidering.md` item 5 is done.**
Opt-in per `url` provider, off by default. Two things to know before touching
it:

- `frame-src` is what this application may frame; `frame-ancestors` is who may
  frame it. Only the first moves for an embedded room. The clickjacking defence
  around 確認 is the second and does not move — the doc that refused this item
  conflated the two, which is the only reason it looked expensive.
- Whether a room is framed is decided per join by comparing the join URL against
  the origin **currently** in `frame-src`, never by reading the provider's flag.
  A call outlives the provider it started with. `docs/engineering/embedded-call-room.md`
  is what building it found, including a placeholder host that reached a CSP
  header without any browser complaining.

**`users.kind` is now a thing.** Any new query that means "people" must say
`kind = 'person'`; service accounts are rows in the same table. The three
places that already do are listed in `docs/architecture/service-accounts.md`.

## Known gaps and unverified things

- **Two checkouts no longer collide, and neither do two suites.**
  `scripts/checkout.mjs` derives a test database name _and_ an E2E port offset
  from the checkout's own path, so a worktree that copied `.env` gets
  `atarimae_test_zen_merkle_991a84_…` on its own ports instead of deleting this
  one's rows mid-run. `testDatabaseUrlFor` also takes a **suite**, so the
  Playwright suite is on `atarimae_test_e2e_<tag>` and `pnpm check` and
  `pnpm test:e2e` are safe to run together. Four callers must agree —
  `db.mjs`, `apps/server/src/test/setup-env.ts`, `e2e/playwright.config.ts` and
  `e2e/fixtures/database.ts` — and the fourth was missed first time round,
  which cost 122 skipped E2E tests. Add a fifth at your peril; there are tests.
  `pnpm db:test:reset` prepares both databases; `--e2e` targets just the
  Playwright one. See `docs/engineering/shared-test-database.md`.
- **The Docker image builds and runs.** No longer a gap: Docker is installed
  here now, `docker compose up -d --build` works from a clean checkout, both
  containers reach healthy, all migrations apply inside the container and the
  first Owner can be created. It found three real defects on the way —
  `docs/engineering/docker-first-build.md`. Note that signing in needs TLS in
  front: cookies are `Secure` under `NODE_ENV=production`, which is correct and
  is what `docs/deployment/docker.md` describes.
- **The E2E flakiness is explained and closed.** It was never a timing problem.
  Two suites shared one test database — `pnpm check` truncating several hundred
  times a run while `pnpm test:e2e` truncated per spec — so each emptied the
  other's tables mid-test, and the damage surfaced anywhere but where it
  happened. The Playwright suite now has its own database
  (`atarimae_test_e2e_<tag>`), derived rather than configured, and the pair has
  been run **at the same time** in one checkout: 496 and 154, both green.
  `ws proxy socket error: ECONNRESET` in the Vite log is a page closing and
  appears just as often in runs that pass — ruled out rather than left hanging.
  `docs/engineering/shared-test-database.md`.
- **Backup works inside Docker too.** No longer a gap: the image builds with the
  PGDG `postgresql-client-18` layer, `pg_dump` is 18.6, `packages/backup`
  resolves its own `pg` (it is the first workspace package with a runtime
  dependency, so that symlink layout had never been exercised), and an archive
  written in the container lands on the host via the `./backups` bind mount and
  reads back with `verify`. It found a fourth defect on the way — every
  documented backup command said `pnpm`, which is not in the runtime image. See
  `docs/engineering/docker-first-build.md`.
- **Attachments need a mounted volume in Docker.** `ATTACHMENT_ROOT` is a plain
  directory; `docker-compose.yml` declares the volume. Without it a rebuild
  destroys every uploaded file while the database keeps the rows pointing at
  them. Also: no virus scanning — the rules verify what a file _is_, not
  whether its contents are hostile. See `docs/architecture/attachments.md`.
- **Chat is deliberately incomplete** (M3b, after v1.0): no editing,
  deletion, reactions, link previews, search, threads, presence or typing
  indicators. The interface matches the backend's scope exactly — nothing there
  is stubbed or disabled.
- **An embedded call room closes when you leave the conversation.** A window did
  not. Rejoining is one press and the frame comes back, but it is a real
  difference between the two ways of holding a call, and it is why embedding is
  opt-in. Also: the CSP origin is rebuilt when a provider is written through the
  API, so a database changed underneath a running server — a restore — needs a
  restart before the header agrees with it.
- **Mentions are picked, never typed.** The composer converts a name chosen from
  the member list into the `@<uuid>` the server resolves; a name typed by hand
  stays plain text. Two members sharing a display name makes the conversion
  ambiguous, and the composer refuses rather than guessing.
- **Screenshots and the demo video need the author.** The browser pane here
  cannot take screenshots. `e2e/tests/m2-ui.spec.ts` is the shot list —
  Playwright can record video by setting `video: "on"` in the config.
- **The repository is private.** The plan is to make it public after M2, which
  is now done; the timing is the author's call.

## Where the interesting reading is

- `docs/architecture/announcement-model.md` — why acknowledgement statistics are
  trustworthy, constraint by constraint
- `docs/architecture/attachments.md` — the four upload rules, the hole each one
  closes, and the limits stated plainly
- `docs/architecture/backup.md` — why files are copied before the database is
  dumped, and why the encryption key is not in the archive
- `docs/architecture/service-accounts.md` — why an integration is not a person's
  token, and what a leaked token still cannot do
- `docs/architecture/webhooks.md` — why delivery is an outbox, why the timestamp
  is signed with the body, and where a webhook may not point
- `docs/architecture/calls.md` — what Atarimae refuses to carry, and why a call
  provider may point inside the network when a webhook may not
- `docs/architecture/security.md` — why clickjacking, of all things, is the
  attack this product actually has to care about
- `docs/engineering/m0-regressions.md` — eleven real defects, each with the test
  that now prevents it. Most share one shape: the system reported success while
  doing nothing.
- `docs/engineering/m6a-security.md` — the sign-in rate limit that could be
  bypassed with one header, and the two absences beside it.
- `docs/engineering/embedded-call-room.md` — a host that was still a placeholder
  reaching a CSP header, and the two things a browser will not tell you about a
  frame.
- `docs/engineering/shared-test-database.md` — two checkouts on one database,
  and how long it takes to notice that the measurement is the thing that is
  broken.
- `docs/engineering/m3a-interface.md` — what building the chat interface found,
  and the hazards it was written against.
- `docs/engineering/docker-first-build.md` — three defects the first-ever image
  build found, including one that produced a healthy container with no tables.
- `docs/architecture/pwa.md` — what is cached and what is refused, and why an
  offline client is the easiest place to break this product's own rule.
- `docs/architecture/desktop.md` — why the address cannot be hard-coded, and
  why the client refuses one that does not answer.
- `docs/architecture/decisions.md` — toolchain decisions and their reasons
