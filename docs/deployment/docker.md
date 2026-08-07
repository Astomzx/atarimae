# Deploying with Docker

One container for the application, one for PostgreSQL. The application serves
both the API and the web interface, so there is no separate static host or
worker process to run.

Written to be followed by somebody who has not read the source.

## Requirements

- Docker with Compose v2 (`docker compose`, not `docker-compose`)
- A machine reachable by the people who will use it
- About 1 GB of RAM

PostgreSQL 18 is required and comes from the compose file. Pointing this at an
older PostgreSQL fails on the first migration with an explicit message —
`uuidv7()` and the builtin `C.UTF-8` collation provider both need 18.

---

## 1. Get the source

```bash
git clone https://github.com/Astomzx/atarimae.git
```

```bash
cd atarimae
```

## 2. Generate configuration

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

### Back up the encryption key now

`.env` contains `ENCRYPTION_KEY_CURRENT`. Losing it permanently destroys every
stored external credential — currently the SMTP password.

Store it somewhere that is **not** your database backup. A backup containing
both the ciphertext and the key protects nothing.

## 3. Start

```bash
docker compose up -d
```

## 4. Create the database schema

```bash
docker compose exec app node scripts/db.mjs up
```

Expect a list of applied migrations ending in `Migrations complete!`.

## 5. Create the first Owner

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

`X-Forwarded-For` matters: without it every audit log entry records the proxy's
address instead of the user's.

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
```

```bash
docker compose build
```

```bash
docker compose up -d
```

```bash
docker compose exec app node scripts/db.mjs up
```

Always run migrations after updating. `db.mjs up` is safe to run when there is
nothing to do.

Check what would run first:

```bash
docker compose exec app node scripts/db.mjs status
```

---

## Backups

Two things must be backed up, **separately**:

**The database.**

```bash
docker compose exec -T db pg_dump -U atarimae atarimae | gzip > atarimae-$(date +%F).sql.gz
```

**`ENCRYPTION_KEY_CURRENT`, from `.env`**, stored somewhere other than the
database backup.

### Restoring

```bash
gunzip -c atarimae-2026-08-07.sql.gz | docker compose exec -T db psql -U atarimae atarimae
```

A backup you have never restored is not a backup. Try it once, on a spare
machine, before you need it.

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
- **No automatic backups.** Set up your own schedule.
- **No high availability.** One application container, one database.
- **No official support.** See the project status section of the README.
