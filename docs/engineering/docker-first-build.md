# What the first Docker build found

`docker compose up -d --build` had never run. It was the last unverified item
in the v1.0 completion criteria, and the reason it stayed unverified was that
Docker could not be installed on the development machine.

It runs now. Three defects surfaced on the way, in the order a person following
the README would have hit them. None of them could have been found by reading:
each needed the image to actually be built and started.

Same rule as the other files here — each entry names what now prevents it.

---

## 1. The build aborted asking a question nobody could answer

```
[ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY] Aborted removal of modules directory due to no TTY
```

The Dockerfile installs everything, builds, then reinstalls with `--prod` to
strip development dependencies out of the runtime image. That second install
replaces `node_modules`, and pnpm asks for confirmation before removing a
directory it did not create itself.

A build has no terminal. So pnpm cannot ask, and refuses rather than guessing —
correct of it, and fatal here.

**Fix**: `ENV CI=true` in the build stage. It is what pnpm documents for exactly
this, and it is honest: a container build _is_ a non-interactive environment.

**Guarded by**: the build itself. `docker compose build` is the test, and it
failed on line 39 of the Dockerfile until this was set.

---

## 2. PostgreSQL 18 moved its data directory, and the mount had not

The database container came up unhealthy, restarting in a loop:

```
Counter to that, there appears to be PostgreSQL data in:
  /var/lib/postgresql/data (unused mount/volume)
```

The 18+ official images store data in a major-version-specific subdirectory so
that `pg_upgrade --link` is not blocked by a mount-point boundary. The compose
file mounted `db-data:/var/lib/postgresql/data`, which is the pre-18
convention. The container finds data where it no longer expects any and stops
rather than guessing which layout it is looking at.

This project **requires** PostgreSQL 18 — `uuidv7()` and the builtin `C.UTF-8`
collation — so the new layout is the only one that ever applies here. The old
path was simply wrong, and had been since the compose file was written.

**Fix**: mount `db-data:/var/lib/postgresql`.

**Guarded by**: `docker compose up -d` reaching `Healthy` on the `db` service.
The healthcheck is `pg_isready`, so an unhealthy database blocks the app from
starting at all — which is what made this loud instead of subtle.

---

## 3. The documented deployment step could not run

Both the README and the header of `docker-compose.yml` tell an operator to run:

```bash
docker compose exec app node scripts/db.mjs up
```

It failed:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'pg' imported from /app/scripts/db.mjs
```

The runtime image's root `node_modules` was **empty**. `node-pg-migrate` and
`pg` were root devDependencies, so the `--prod` install pruned them, and the
migration runner had nothing to import.

This is the worst of the three. The first two stopped the build or the
container — visible immediately. This one produced a container that started,
answered `/api/v1/health` with `database: ok`, and served the web interface —
and then failed at the one step that creates the tables. `/api/v1/setup/status`
returned a 500 with no explanation of why.

The framing that fixes it: **the migration runner is part of what gets
deployed**. An operator runs it, in production, as a documented step. Its
dependencies are production dependencies, and calling them development
dependencies was the mistake.

**Fix**: `node-pg-migrate` and `pg` moved to `dependencies` in the root
`package.json`.

**Guarded by**: running the documented command inside the container. All ten
migrations apply, `/api/v1/setup/status` answers `{"initialized":false}`, and
the first Owner can be created through the API.

---

## One thing that was not a defect

After creating the first Owner over `http://localhost:3000`, the next
authenticated request came back 401.

That is correct. `NODE_ENV=production` in the image, so session cookies carry
`Secure`, and no client will send a `Secure` cookie back over plain HTTP. The
container is meant to sit behind a reverse proxy terminating TLS.

`docs/deployment/docker.md` already says so — including the exact symptom under
"sign-in will not work over plain HTTP", with Caddy and nginx examples and a
troubleshooting entry. Nothing to change; recorded here only because it looks
exactly like a bug for about a minute.

---

---

## 4. Every documented backup command was unrunnable (found by the M6a build)

Not from the first build — from the second, when M6a added backup and restore
and the image gained a `postgresql-client-18` layer to support them.

`docs/deployment/docker.md` told operators to run:

```bash
docker compose exec app pnpm backup --out /var/lib/atarimae/backups/...
```

There is no `pnpm` in the runtime image. The build stage runs `corepack enable`;
the runtime stage is a fresh `node:24-bookworm-slim` that copies build output
and nothing else. So all three documented commands — backup, verify and restore
— failed immediately with `pnpm: not found`.

**The same shape as defect 2 above**, and worth noticing that it recurred: a
documented operational step, written from the perspective of a development
checkout, that nobody had executed inside the container. The migration commands
avoid it only because they were written as `node scripts/db.mjs up` after that
earlier lesson.

**The fix** is the same convention: `node packages/backup/dist/cli.js backup`.
Adding `corepack enable` to the runtime image was the alternative and was not
taken — the image should not carry a package manager it has no other use for,
and the `node` form matches what the migration commands already do.

There is no test for this, and that is the honest state of it: nothing in
`pnpm check` runs a command inside a container. What catches it is building the
image and running the documented steps, which is what happened here.

---

## What is verified now

From the first build:

- The image builds from a clean checkout: `atarimae-app:latest`, 615 MB.
- `db` and `app` both reach `Healthy`.
- All ten migrations apply inside the container.
- The API answers, the web interface is served by the same process, and the
  first Owner can be created.
- Attachments and database data are on named volumes, as
  `docs/architecture/attachments.md` requires.

Added by the M6a build:

- `pg_dump` and `psql` are present and are 18.6 from PGDG, not bookworm's 15.
- `packages/backup` is in the image and resolves its own `pg` dependency —
  it is the first workspace package with a runtime dependency, so the
  `COPY /app/packages` plus `COPY /app/node_modules` symlink layout had never
  actually been exercised before.
- A backup taken inside the container writes a valid archive, and the bind
  mount puts it on the host in `./backups`.
- `verify` reads that archive back inside the container and reports the row
  counts it holds.
