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
```

`--test` on any `db:` command targets the test database.

## Layout

```
apps/server    Fastify 5 + TypeBox, REST + OpenAPI 3.1, WebSocket
apps/web       React 19 + Vite 6 + TanStack Query + react-router
packages/api-schema    TypeBox schemas — single source of truth for types
packages/secret-store  AES-256-GCM, only for credentials replayed elsewhere
migrations     plain SQL, up and down
e2e            Playwright
docs/architecture   frozen model, technical decisions
docs/engineering    every defect found while building, and its guard
docs/deployment     Docker
```

Only top-level request/response schemas carry `$id`. A named schema referenced
twice inside one response breaks Fastify's serializer.

## Status

| Milestone                                                        | State                              |
| ---------------------------------------------------------------- | ---------------------------------- |
| M0 foundation                                                    | done                               |
| M1 accounts, org units, permissions                              | done                               |
| M2 announcements, per-person content, acknowledgement, SMTP, CSV | done                               |
| M3a chat                                                         | **backend done, no interface yet** |
| M4 PWA + Tauri                                                   | not started                        |
| M5 open API, webhooks, call providers                            | not started                        |
| M6a security, attachments, backup/restore                        | not started                        |
| M6b documentation, screenshots, release                          | not started                        |

195 unit tests, 80 E2E, 7 migrations. CI green.

## Suggested order from here

1. **M3a chat interface** — the backend is complete and tested; nothing blocks it.
2. **Attachment upload** (part of M6a, but it is what makes chat complete).
   Needs the file validation rules: allow-list extensions, verify actual type
   rather than trusting Content-Type, server-generated storage names, permission
   re-checked on download.
3. **M5** — service accounts, API tokens (hashed, never encrypted), webhooks
   with HMAC signatures, generic URL and HTTP call providers.
4. **M4** — PWA first, then Tauri. **Tauri needs a Rust toolchain that is not
   installed on this machine.**
5. **M6b** — three-language README, screenshots, demo video, release.

## Known gaps and unverified things

- **The Docker image has never been built.** Docker is not installed here.
  Everything the image depends on that could be checked without it is covered by
  `apps/server/src/static-hosting.test.ts`, but `docker compose up -d --build`
  has never run. This is the last unverified item in the v1.0 completion
  criteria.
- **Chat has no attachment upload.** The tables exist and messages carry an
  always-empty attachment list.
- **Screenshots and the demo video need the author.** The browser pane here
  cannot take screenshots. `e2e/tests/m2-ui.spec.ts` is the shot list —
  Playwright can record video by setting `video: "on"` in the config.
- **The repository is private.** The plan is to make it public after M2, which
  is now done; the timing is the author's call.

## Where the interesting reading is

- `docs/architecture/announcement-model.md` — why acknowledgement statistics are
  trustworthy, constraint by constraint
- `docs/engineering/m0-regressions.md` — eleven real defects, each with the test
  that now prevents it. Most share one shape: the system reported success while
  doing nothing.
- `docs/architecture/decisions.md` — toolchain decisions and their reasons
