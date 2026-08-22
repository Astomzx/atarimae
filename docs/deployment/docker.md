# Deploying with Docker

One container for the application, one for PostgreSQL. The application serves
both the API and the web interface, so there is no separate static host or
worker process to run.

Written to be followed by somebody who has not read the source.

## Windows one-click setup

For a Windows host, extract the repository archive and double-click
`install-windows.cmd`. The Japanese wizard:

1. installs Docker Desktop through Windows Package Manager when it is absent;
2. preserves an existing `.env`, or generates every secret when it is new;
3. offers a local-only trial or an HTTPS office deployment;
4. starts the database, migrations, application and (for HTTPS) Caddy;
5. waits for the real health endpoint and creates an Atarimae desktop shortcut.

An office deployment still needs facts the PC cannot change by itself: the
chosen DNS name must point to that office, and the router must forward TCP
80/443 and UDP 443 to the Windows host. The wizard prints exactly these checks.
Everything on the Windows host is automated.

## Requirements

- Docker with Compose v2 (`docker compose`, not `docker-compose`)
- A machine reachable by the people who will use it
- About 1 GB of RAM

PostgreSQL 18 is required and comes from the compose file. Pointing this at an
older PostgreSQL fails on the first migration with an explicit message —
`uuidv7()` and the builtin `C.UTF-8` collation provider both need 18.

---

## Quick start

```bash
git clone https://github.com/Astomzx/atarimae.git
```

```bash
cd atarimae
```

```bash
node scripts/setup-env.mjs
```

This writes `.env` with freshly generated secrets. It needs Node 22+ installed
locally; if you would rather not install Node, copy `.env.example` to `.env`
and replace every `REPLACE_ME` by hand with at least 32 random bytes.

Now edit one value:

```bash
PUBLIC_ORIGIN=https://atarimae.example.co.jp
```

**This must be the address people actually type into a browser.** It is used
for CORS and for the links inside notification emails, so an incorrect value
produces mail nobody can act on.

### Back up the encryption key

`.env` contains `ENCRYPTION_KEY_CURRENT`. Losing it permanently destroys every
stored external credential — currently the SMTP password.

Store it somewhere that is **not** your database backup. A backup containing
both the ciphertext and the key protects nothing.

```bash
docker compose up -d --build
```

The application waits for PostgreSQL, applies every pending migration and only
then starts accepting traffic. The same command is used for a new installation,
an ordinary restart and an upgrade. If a migration fails, the application does
not start in a half-updated state; inspect it with `docker compose logs app`.

## First sign-in

Open `PUBLIC_ORIGIN` in a browser. The first-run screen asks for a name, an
email address and a password.

**There is no activation step and nobody to contact.** Whoever opens the page
first becomes the Owner, so do this immediately after starting the service, not
tomorrow.

Once an Owner exists, the setup screen stops working.

---

## TLS

The application serves plain HTTP and expects a reverse proxy in front of it.
Session cookies are marked `secure` when `NODE_ENV=production`, so **sign-in
will not work over plain HTTP from another machine** — this is deliberate.

Caddy, for a working example:

```
atarimae.example.co.jp {
    reverse_proxy localhost:3000
}
```

nginx:

```nginx
server {
    server_name atarimae.example.co.jp;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`X-Forwarded-For` matters, and **setting it in the proxy is only half of it.**
Atarimae ignores that header unless you also name the proxy:

```bash
TRUSTED_PROXY_IPS=127.0.0.1
```

Use the address the proxy connects _from_, as seen by the application — its own
IP, or a CIDR range. On the compose network that is usually the Docker bridge,
e.g. `172.18.0.0/16`.

Without it, every audit log entry records the proxy instead of the user, and
the whole office shares one sign-in rate-limit budget. **With it set to the
wrong thing — or with the port exposed directly and no proxy at all — anyone
can choose their own address by sending the header**, which makes the sign-in
rate limit unenforceable and the audit log untrustworthy. That is why the
default is to believe nobody; see `docs/architecture/security.md`.

---

## Email

Atarimae does not run a mail server. It connects to one you already have.

Sign in as the Owner, go to settings, and enter your SMTP host, port, username
and password. The password is encrypted before storage and is never returned by
the API. Use the connection test — it authenticates without sending anything.

Until SMTP is configured, notifications accumulate in the queue rather than
being lost. Configuring it later delivers everything that was waiting.

Three kinds of mail are sent, all tied to an acknowledgement:

- a new announcement requiring confirmation
- a re-confirmation request after a significant change
- one reminder, 24 hours before a deadline

Nothing else. No per-message chat mail, no digests.

---

## Updating

```bash
git pull
docker compose up -d --build
```

Pending migrations run automatically before the updated server starts. If one
fails, the application remains stopped instead of serving new code against an
incomplete schema; inspect the app logs, correct the cause and run the same
command again.

Check what would run first:

```bash
docker compose exec app node scripts/db.mjs status
```

---

## Backups

```bash
docker compose exec app node packages/backup/dist/cli.js backup --out /var/lib/atarimae/backups/atarimae-$(date +%F).tar.gz
```

That writes one archive holding the database **and** every uploaded file, and it
checks the two agree before writing anything. `/var/lib/atarimae/backups` is a
bind mount, so the file lands in `./backups` on the host — set `BACKUP_DIR` in
`.env` to put it somewhere else.

(`node …/cli.js` rather than `pnpm backup`, for the same reason migrations are
run as `node scripts/db.mjs`: the runtime image has Node and no package manager.
From a checkout on your own machine, `pnpm backup` is the same command.)

A backup of the database alone is the mistake this command exists to prevent:
it restores to a system that starts, signs people in and shows the paperclip on
every message, and produces a broken download the first time somebody clicks
one.

### Encrypting it

Add `--encrypt-to <recipient>` to encrypt the archive to an age or SSH public
key you already manage. Atarimae never generates, stores or sees a key — and if
`age` is not installed it refuses rather than quietly writing a plaintext file
you believe is encrypted. Restore with `--identity <your key file>`.

**`ENCRYPTION_KEY_CURRENT`, from `.env`, is deliberately not in the archive.**
It decrypts the stored SMTP password, and a file containing both the ciphertext
and the key protects nothing. Store it somewhere the archives are not. The
backup command prints this every time it succeeds.

### Checking one

```bash
docker compose exec app node packages/backup/dist/cli.js verify /var/lib/atarimae/backups/atarimae-2026-08-16.tar.gz
```

Reads the archive and nothing else — safe to run against last night's backup on
a live system, at any time. It reports the row counts it holds, and fails if any
file is truncated, altered or missing.

### Restoring

```bash
docker compose exec app node packages/backup/dist/cli.js restore /var/lib/atarimae/backups/atarimae-2026-08-16.tar.gz
```

The archive is verified in full before a byte is written. The target database
must be empty; add `--force` to drop every table in the `public` schema first,
which has no undo. Afterwards the restored database is compared against the
archive's own row counts, table by table, and the attachments on disk are
reconciled against the rows that refer to them.

Then check whether the archive predates the running code:

```bash
docker compose exec app node scripts/db.mjs status
```

A backup you have never restored is not a backup. `backup:verify` proves an
archive is complete; it cannot prove the dump is meaningful. Try a real restore
once, on a spare machine, before you need it.

See `docs/architecture/backup.md` for why it is built this way.

---

## Health and monitoring

```bash
curl http://localhost:3000/api/v1/health
```

Returns 200 when the database is reachable, 503 when it is not. The container
health check uses the same endpoint.

An administrator can see the notification queue in the settings screen. A
growing `abandoned` count means messages exceeded the retry limit and need
attention — usually a wrong SMTP password.

---

## Troubleshooting

**Sign-in appears to succeed but immediately returns to the login screen.**
Cookies are `secure` in production and you are on plain HTTP. Put TLS in front,
or use `http://localhost` for a local trial.

**Email is never sent.** Check the queue in settings. If `abandoned` is
climbing, run the SMTP connection test — it reports the raw error.

**`Atarimae requires PostgreSQL 18 or newer`.** An older image, or a volume
created by one. Check with:

```bash
docker compose exec db psql -U atarimae -c "SELECT version()"
```

**Logs.**

```bash
docker compose logs -f app
```

---

## What this deployment does not include

Stated plainly so nothing is a surprise:

- **No TLS.** Use a reverse proxy.
- **No backup schedule.** `pnpm backup` is one verified backup; `cron` is
  better at deciding when. Nothing here runs it for you.
- **No high availability.** One application container, one database.
- **No official support.** See the project status section of the README.
