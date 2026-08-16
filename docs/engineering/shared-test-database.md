# The bug that made the tests untrustworthy

Not a defect in the product. A defect in the ability to measure it, which is
worse, because every conclusion drawn while it was present has to be thrown
away.

## What happened

An agent working in a git worktree ran `pnpm test:e2e` while the main checkout
ran `pnpm test`. A worktree starts life with the same `.env`, so
`TEST_DATABASE_URL` named the same database in both. An E2E run starts a real
API server with a notification worker that polls and drains for as long as the
suite lasts; the unit suite `TRUNCATE`s `users`, `sessions`, `org_units`,
`invitations` and more between cases.

The symptoms, in the order they appeared:

- 25 unit failures scattered across org units, invitations, reminders and
  identity — four areas with nothing in common.
- A clean 369/369 a minute later, with no change in between.
- Failures that moved on every run, then multiplied, then vanished.

Which reads exactly like a suite that is not idempotent across runs. So that is
what it was diagnosed as, and written into `CLAUDE.md` as a known gap, with a
plausible mechanism (`beforeAll` sees rows the previous run's last file left)
and a control experiment that appeared to confirm it.

**The control experiment was contaminated too.** Removing the newest test files
and re-running still showed failures, which looked like proof the problem
predated them. It was not proof of anything: the second checkout was still
running.

The tell was never in the failures. It was in `Get-CimInstance Win32_Process`:
a `tsx watch` server and a Playwright run, both under a `.claude/worktrees/`
path, both pointed at the same database.

## Why it was allowed to happen

`TEST_DATABASE_URL` is a setting, and settings are copied. Worktrees are created
by tooling that copies `.env` verbatim precisely so the copy works at all. Every
mechanism in the workflow pushed towards two checkouts sharing one database, and
nothing anywhere would say so.

Both processes were behaving correctly. There was no error to find.

## The fix

`scripts/checkout.mjs` derives, from the checkout's own real path:

- the **test database name** — `atarimae_test` becomes
  `atarimae_test_zen_merkle_991a84_1f2e3d4c`, a readable label plus a hash so
  two directories with the same name are still two;
- an **E2E port offset**, so the servers do not collide either.

Deliberately derived, not configured. A new setting to remember in each worktree
is the same trap with one more step — and the tooling that creates worktrees
would copy that too.

The development database is untouched. It holds data somebody wants to keep, and
moving it would be the opposite of helpful.

**Ports turned out to be the more dangerous half.** Playwright runs with
`reuseExistingServer` outside CI, so two checkouts on one port do not fail
loudly on a port already in use — the second one attaches to the _first_
checkout's API server, runs against that tree's code and that tree's database,
and reports a green result about a repository it never read.

## What it cost to get wrong twice

The module's own docstring says every consumer must agree exactly. There were
four, and the first attempt converted three:

```
scripts/db.mjs                       creates and migrates it
apps/server/src/test/setup-env.ts    unit tests connect to it
e2e/playwright.config.ts             hands it to the API server
e2e/fixtures/database.ts             ← missed
```

`resetDatabase()` read `TEST_DATABASE_URL` straight from the environment, so it
truncated the _old_ database while the server used the new one. Every spec that
begins by setting up an organisation failed, because first-run setup only works
when no Owner exists and the Owner it had just deleted was in a database nobody
was looking at. 17 passed, 122 did not run, and not one error message mentioned
a database.

Which is the same lesson one level down: a value that must be identical in four
places will not stay identical, and the failure when it drifts does not name its
cause.

## The guards

`apps/server/src/checkout.test.ts`, 17 cases. Two checkouts differ; one checkout
is stable across calls; case and separator differences on Windows are the same
checkout; the name stays inside PostgreSQL's 63-byte identifier limit by
trimming the base and never the hash, because PostgreSQL truncates silently and
two names truncated to the same thing is the shared database all over again.

They are in `apps/server` rather than beside the script because `scripts/` has
no runner, and because the server suite is what suffers when the derivation is
wrong.

## What is true now

With the fix in place and a worktree deliberately running its E2E suite at the
same time: three consecutive `pnpm test` runs, no `db:test:reset` between them,
386/386 each time. Then `pnpm test:e2e`, 151/151, immediately after a `pnpm
check` had left rows behind.

So the suite **is** idempotent across runs. It always was. The earlier claim
that it was not has been retracted rather than fixed, because there was never
anything there to fix.
