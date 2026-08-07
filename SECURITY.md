# Security Policy

## Reporting a vulnerability

Please report security issues **privately**, not as a public issue.

Use GitHub's private reporting:
[Report a vulnerability](https://github.com/Astomzx/atarimae/security/advisories/new)

Include, as far as you can:

- what the issue lets an attacker do
- the steps to reproduce it
- the version or commit you tested
- whether it needs an authenticated account, and at which role

You will get an acknowledgement within a week. This project is maintained by
one person in their own time, so a fix may take longer than that — the
acknowledgement will say what to expect rather than leaving you guessing.

Please give a reasonable period for a fix before disclosing publicly.

## Scope

In scope:

- authentication, session handling, role checks
- access to announcements, per-person content, or acknowledgement data by
  someone not entitled to it
- SQL injection, XSS, CSRF
- exposure of stored credentials, including anything that returns an SMTP
  password in plaintext
- audit log tampering through the application

Out of scope:

- issues requiring a compromised server or database
- missing hardening on a deployment the operator configured themselves
  (no TLS, an exposed database port, weak `POSTGRES_PASSWORD`)
- rate limits tuned for a small office rather than a public service
- denial of service through sheer volume
- vulnerabilities in dependencies with no exploitable path here — report those
  upstream

## What the design already assumes

Some things are deliberate, and reporting them as vulnerabilities will get a
"working as intended" answer. Stating them here saves everybody time.

**Anyone with an Owner account can read everything.** There is no separation of
duties above Owner. A deployment is a single organisation, and Owner is its
administrator.

**Audit logs are append-only through the application, not tamper-proof against
database access.** Anyone with a psql connection can edit them. Protecting
against that requires infrastructure this project does not attempt to provide.

**The SMTP password is encrypted, not hashed**, because it must be replayed to
the mail server. Anyone who has both the database and `ENCRYPTION_KEY_CURRENT`
can recover it. Keep the key out of your database backups.

**Losing `ENCRYPTION_KEY_CURRENT` is unrecoverable.** Every stored external
credential becomes permanently undecryptable. This is data loss, not a
vulnerability.

**Members can see the member directory**, including names and email addresses.
An internal noticeboard where colleagues cannot look each other up is not
useful.

## What the implementation guarantees

Stated so a discrepancy is worth reporting:

- passwords are hashed with Argon2id at the OWASP baseline (19 MiB, t=2, p=1)
- session tokens are 256 random bits, stored only as a SHA-256 hash; the raw
  value exists solely in an `httpOnly`, `sameSite=lax` cookie
- an unknown address and a wrong password produce byte-identical responses,
  and an unknown address still pays the Argon2 cost, so response timing does
  not enumerate accounts
- "account disabled" is reported only after the password verifies
- disabling an account revokes its sessions in the same transaction, so it
  takes effect on the next request rather than at expiry
- every permission check runs server-side against the session-resolved role;
  the client's claim about who it is never participates
- administrative actions are recorded in `audit_logs` with actor, IP, user
  agent and request id

## Supported versions

Pre-1.0. Only the latest commit on `main` is supported. There are no backports.

## Operator responsibilities

This is self-hosted software. The deployment is yours, and so is:

- TLS termination — the application serves plain HTTP and expects a reverse
  proxy in front of it
- keeping PostgreSQL off the public internet
- backups, and verifying that a restore actually works
- backing up `ENCRYPTION_KEY_CURRENT` separately from the database dump
- applying updates

See [docs/deployment/docker.md](docs/deployment/docker.md).
