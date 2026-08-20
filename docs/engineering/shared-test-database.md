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

## The same bug one dimension along: two suites, one checkout

Fixing the checkout dimension left the other one standing, and it is the one a
single developer with a single checkout meets.

`pnpm check` runs the server's unit tests, which `TRUNCATE` every table and
create an Owner in a `beforeEach`, several hundred times a run. `pnpm test:e2e`
runs the Playwright suite, which truncates in each spec's `beforeAll`. CLAUDE.md
asks you to run both. In two terminals against one database they empty each
other's tables mid-test.

The damage never surfaces where it happens:

- A browser three tests into a spec finds itself on the first-run setup screen.
- `POST /setup/owner` answers 409 two hundred milliseconds after
  `/setup/status` said the organisation was empty.
- The two `TRUNCATE` statements list their tables in different orders, so they
  deadlock and PostgreSQL kills one. Whichever assertion was in flight is the
  one that fails.

CI never saw it, because quality and e2e are separate jobs with a PostgreSQL
each — which is the reason a red local run and a green CI run could disagree
without either being wrong.

**The fix is the same shape as the first: derive, do not configure.**
`testDatabaseUrlFor` takes a suite, so the Playwright suite gets
`atarimae_test_e2e_<tag>` and the unit suite keeps `atarimae_test_<tag>`. A
second environment variable was considered and rejected for the reason written
at the top of `checkout.mjs`: a `.env` that has to gain a line is a `.env` some
checkout will not have. `pnpm db:test:reset` prepares both, because a half-
prepared pair is how one suite ends up on the other's tables again.

Two guards came with it:

- `db:reset` **refuses to drop a database something is connected to**, naming
  the connections rather than counting them. It used to terminate every session
  and drop it without mentioning it — invisible destruction of a database a
  suite was using. `--force` still does the old thing, out loud.
- `checkout.test.ts` covers the suite dimension the way it covers the checkout
  one, including that neither the suite nor the hash is what gets trimmed at
  PostgreSQL's 63-byte limit.

Measured rather than reasoned about: `pnpm --filter @atarimae/server test` and
`pnpm test:e2e` started together, in one checkout, both green — 496 and 154.
That pair is what used to destroy a run.

## The product defect underneath all of it

Not a test-harness bug at all, and the most serious thing here.

`createDatabase` built a `pg.Pool` with **no `error` listener**. A pooled
connection that fails while idle — checked in, no query running — has no caller
to reject, so `pg` reports it by emitting `error` on the pool. `error` is Node's
one special event: unhandled, it is rethrown as an uncaught exception and takes
the process with it.

So every ordinary reason PostgreSQL ends a connection was fatal to the whole
server:

- a failover or a restart
- an idle-session timeout
- an administrator running `pg_terminate_backend`
- a `db:reset` on a database the server was connected to — which is how it was
  found, the API server exiting mid-suite and every test after it failing for
  reasons of its own

The pool discards the dead connection either way. The missing listener only
decided whether the rest of the server survived. It is now a `log.warn` through
Fastify's logger, with a stderr default so a pool built by a script is not a way
to kill a process either.

**Guarded by** `db.test.ts`, "an idle connection failing" — three cases that
terminate a real pooled backend from a second connection and require the pool to
report it, keep answering queries, and always have a listener. Run against the
old `createDatabase` first, where it ends the vitest process with an uncaught
exception rather than failing a test.

## The socket the investigation found on the way past

Not a cause of any of the above, and worth writing down because it was only ever
visible in a trace nobody reads until something else is already wrong.

In development the realtime hook leaked a socket on every mount. "Did we close
this on purpose?" lived in a `useRef`, which is shared across every run of the
effect. React's StrictMode runs an effect, cleans it up, and runs it again — and
the first socket's `close` event arrives after the second run has reset the flag
to false. The cleanup's own `close()` was therefore read as an unexpected
disconnection and scheduled a reconnect, on a connection whose cleanup had
already happened. Nothing would ever close what that reconnect opened, and each
orphan kept its own reconnect loop for the life of the page.

Development only — a production build does not double-invoke effects — so it
cost nobody anything except two sockets per page while developing, and the
console line "WebSocket is closed before the connection is established" that
made it look like an ordinary StrictMode artefact.

The lifetime now lives in `apps/web/src/chat/realtime-socket.ts`, outside React,
with the flag as a local of the function that opens the socket. Two overlapping
connections are then simply two connections, each closing only itself. The hook
is what is left: a `useEffect` that opens one and returns its `close`.

Moving it out is also what made it testable — `realtime-socket.test.ts` drives a
stand-in socket through open, close, reconnect, and the StrictMode sequence
exactly, with no browser. Run against the shared flag, the StrictMode case ends
with three sockets where two were asked for.

### Two real defects it had been hiding

Closing the leak broke four E2E tests, in both projects, every run. They had been
passing on the leak — and that was measured here rather than taken on trust: with
the socket fixed and the two invalidations below removed, `m3a-ui` and `m5-calls`
fail exactly four tests, the same four, at both widths.

Every socket invalidates `chatKeys.all` when it opens, so that nothing missed
while disconnected is assumed unchanged. The orphaned socket connected a second
after the page loaded and did it again — and because invalidating a query with no
observer marks it stale rather than refetching it, the channel list was left
stale for the life of the page, so every screen that later mounted refetched it.
That accident was standing in for two invalidations the client genuinely owed:

- **Starting a conversation did not refresh the channel list.** The screen it
  navigates to finds its channel in that list, and a conversation created a
  moment ago is not in it — so the heading fell back to 会話 instead of naming
  the person. Present in production, where there is no leaked socket at all: the
  heading was wrong until something else happened to refetch.
- **Answering a call did not either.** A call rings wherever you are, including
  in a conversation created after your screen loaded, and answering navigates
  straight into it. Same fallback, same reason.

Both are now invalidated where they are caused — `NewConversation` before it
navigates, `useEnterCall` before the banner does. `m3a-ui.spec.ts` "a one-to-one
conversation" and `m5-calls.spec.ts` "6. a one-to-one call" cover them, and now
cover them on purpose rather than by accident.

It is worth being plain about what this means: two user-visible bugs survived
because a development-only leak was quietly papering over them, and the tests
that should have caught them were passing for a reason that did not exist in a
production build.
