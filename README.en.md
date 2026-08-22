# Atarimae

**An internal noticeboard where the basics simply work.**

Atarimae is an open-source app for small companies to run on their own server.
It brings announcements, acknowledgements and chat together in one place. It is
free, has no per-person limit, and gives phones, PCs and the Windows app the same
account and the same features.

📖 **日本語: [README.md](README.md)**

## Everything in one place

- **Announcements** — send a shared notice and each person's assignment together
- **Acknowledgements** — record what each person read and count only obligations that remain active
- **Organisation** — manage units, members, administrators, permissions and device sessions
- **Chat and calls** — channels, direct conversations, attachments, mentions and network calls
- **Phone and PC** — PWA installation, Web Push, offline reading and a Windows app
- **Integrations** — OpenAPI 3.1, service accounts and signed webhooks
- **Operations** — audit logs, CSV, and verified backup and restore including attachments

An administrator can add another administrator. One account can be signed in on
several devices. A company can take its own data out. There is no approval process,
per-seat plan or official cloud service.

## Screenshots

Every image uses the same demo data, operated as both an administrator and a
member at desktop and phone widths.

### Administrator

![Administrator home with pending acknowledgements, member management, announcement creation and system status](docs/screenshots/admin-home-desktop.png)

![Administrator announcement list with creation, recipient counts, acknowledgement requirements and publication state](docs/screenshots/admin-announcements-desktop.png)

![Administrator announcement detail with shared text, recipients, personal content and acknowledgement status](docs/screenshots/admin-announcement-desktop.png)

<img src="docs/screenshots/admin-announcement-mobile.png" alt="Administrator announcement detail at phone width" width="390">

### Member

![Member home with announcements requiring acknowledgement and no administrative controls](docs/screenshots/member-home-desktop.png)

![A member's announcement with shared text, their personal assignment and the acknowledgement button](docs/screenshots/member-announcement-desktop.png)

<img src="docs/screenshots/member-announcement-mobile.png" alt="A member's announcement at phone width" width="390">

![Owners, administrators and members assigned to 第一営業所](docs/screenshots/members-desktop.png)

## Start using it

You need Docker Compose and a reverse proxy that terminates TLS.

```bash
git clone https://github.com/Astomzx/atarimae.git
cd atarimae
node scripts/setup-env.mjs
```

Set `PUBLIC_ORIGIN` in the generated `.env` to the HTTPS address that people will
open. One command then builds the image, prepares the database and starts the app.

```bash
docker compose up -d --build
```

Open `PUBLIC_ORIGIN` and create the first Owner. There is no separate activation.
On later restarts and upgrades, pending database changes are applied automatically
before the server accepts traffic.

TLS, reverse proxies, SMTP, backups and upgrades are collected in the
**[Docker operations guide](docs/deployment/docker.md)**.

> Keep `ENCRYPTION_KEY_CURRENT` from `.env` somewhere safe and separate from the
> database backup. Losing it makes stored external credentials impossible to decrypt.

## Using Atarimae

### Administrator

1. Add the organisation and its members, then give administrative access only to
   the people who need it.
2. Write an announcement and address it to units or individuals. Personal
   assignments can be imported together from CSV.
3. After publication, follow acknowledgement status on screen or export it as CSV.
   An operation that affects nobody is never reported as a success.

### Member

After signing in, announcements that need attention, personal assignments and
unread conversations appear together on the home screen. A member reads both the
shared text and their own content before acknowledging it. Previously fetched
announcements remain readable offline, with the fetch time always visible; an
offline acknowledgement is not recorded.

## Operations

An upgrade is the same start command after pulling the source.

```bash
git pull
docker compose up -d --build
```

A backup places the database and every attachment in one verified archive.

```bash
docker compose exec app node packages/backup/dist/cli.js backup \
  --out /var/lib/atarimae/backups/atarimae.tar.gz
```

The commands for verification and restore, encryption and scheduling are in the
[Docker operations guide](docs/deployment/docker.md#backups).

## Development

Development uses Node.js 22 or later, pnpm 10 or later and PostgreSQL 18 or later.

```bash
pnpm install
node scripts/setup-env.mjs
pnpm db:reset
pnpm dev
```

Run `pnpm check` before submitting any change, and `pnpm test:e2e` when changing
routes or the interface. Architecture, deployment, defects found during development
and their regression tests live under [docs/](docs/).

| Location       | Purpose                                                |
| -------------- | ------------------------------------------------------ |
| `apps/server`  | Fastify, REST / OpenAPI and WebSocket                  |
| `apps/web`     | React, Vite and TanStack Query                         |
| `apps/desktop` | Tauri Windows client displaying the same web app       |
| `packages`     | Shared API schema, secret storage and backup packages  |
| `migrations`   | PostgreSQL migrations with both up and down directions |
| `e2e`          | Playwright scenarios at desktop and phone widths       |

## What matters here

- **No silent success.** An operation that affects nobody returns the reason instead.
- **Verifiable behaviour.** Important constraints have tests; CI checks units, E2E,
  Windows and the production container.
- **No data lock-in.** CSV, OpenAPI, webhooks and complete backups are built in.
- **One product on every device.** Phone and PC do not have different feature sets.
- **Japanese first.** The interface is Japanese, and the Japanese and English
  READMEs describe the same product.

For the reasons behind the design, start with the
[announcement model](docs/architecture/announcement-model.md),
[security](docs/architecture/security.md) and
[backup](docs/architecture/backup.md) documents.

## Security, licence and support

Report vulnerabilities privately using [SECURITY.md](SECURITY.md), not a public
issue.

Atarimae is licensed under [AGPL-3.0-only](LICENSE). You may use, modify and run it
yourself. If you offer a modified version as a network service, you must provide
that version's source to its users.

This is maintained by an individual as a project and technical demonstration.
There is no official hosting, SLA or individual free installation service.
Reproducible bugs, documentation improvements, generally useful feature proposals
and pull requests are welcome.
