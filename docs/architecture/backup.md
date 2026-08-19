# Backup and restore

An organisation can take its own data and leave. That is one of the three
claims on the front of this project, and until M6a it was a paragraph in the
deployment guide telling somebody to run `pg_dump` and not forget the files.

```bash
pnpm backup                     # write a verified archive
pnpm backup:verify <file>       # check one, touching nothing
pnpm restore <file> [--force]   # put one back
```

## The failure this is built against

An attachment is two things: a row in `message_attachments` and a file under
`ATTACHMENT_ROOT`. Everything else in the system is one thing, in PostgreSQL,
and `pg_dump` handles it.

So the interesting failure is not losing the database. It is a backup that
captures the rows and misses the files. That restores to a system which starts,
signs people in, lists every conversation, shows the paperclip on the message —
and produces a broken download the first time somebody clicks one, with nothing
in any log to connect it to a restore three weeks earlier.

That is this project's least favourite shape of bug, so the tool is built
around refusing to produce it rather than around producing an archive.

## Files first, then the database

The order the archive is assembled in is load-bearing, and it comes from the
same reasoning as the upload path.

The two ways the halves can disagree are not equally bad:

|                    |                                   |
| ------------------ | --------------------------------- |
| a row with no file | a download that is broken forever |
| a file with no row | a wasted block on disk            |

The attachment sweep deletes the row first and the file second. So if a sweep
runs while a backup is being taken:

- **copy files, then dump** — the file was copied while its row still existed,
  and the dump taken afterwards no longer has the row. A wasted block.
- **dump, then copy files** — the dump has the row, and the file was deleted
  before it was copied. A download broken forever.

Files are copied first. Given the choice, waste the space — the same trade, in
the same direction, as `docs/architecture/attachments.md`.

## What is checked, and when

Every check is placed at the earliest point it can be made, because the cost of
a check rises sharply once a restore has started writing.

**Taking a backup.** The rows are reconciled against the files before the
archive is written. A row whose file is already missing means the _running
system_ is inconsistent, and the backup refuses — writing the archive would
preserve the breakage without recording it. `--allow-missing-attachments`
proceeds knowingly, which is a different thing from proceeding accidentally.

**Reading an archive.** `backup:verify` opens the file and touches nothing
else. Every tar header carries a checksum, so truncation is caught structurally;
every entry carries a SHA-256 in the manifest, so a single altered byte is
caught by digest and named. An operator can run this against last night's
archive without a spare machine and without a maintenance window.

**Restoring.** The archive is opened and fully verified _before_ the first byte
is written, so a damaged archive costs nothing. The target database must have
no tables, unless `--force` is given — restoring over live data is not something
to do by accident. Afterwards the restored database is asked what it expects and
the restored disk is searched for it, and every table's row count is compared
against the manifest. A dump that did not apply cleanly is otherwise invisible.

Row counts are taken from the catalogue rather than from a list of interesting
tables. A hand-written list has to be maintained, and the failure when it is not
is silent in the worst direction: a table added in a later milestone is simply
not compared, so a restore that loses all of it passes every check.

## The key is deliberately not in the archive

`ENCRYPTION_KEY_CURRENT` decrypts the stored SMTP password. An archive holding
both the ciphertext and the key protects nothing — it is one file equivalent to
the plaintext.

Only the key **id** is recorded. That is enough for a restore to say that its
secrets were written under `key01` and the key configured here is `key02`, and
not enough to read them. Without the id, that mismatch surfaces as email
silently failing at the moment the first notification is sent.

Every successful backup says this on the way out. It is not in a footnote,
because the usual moment to discover that the key was never stored separately is
the moment somebody needs the backup.

## The archive

A gzipped ustar tar. One file, because two things that must be copied together
are two things somebody will eventually copy separately.

```
manifest.json                     format, digests, row counts, key id
database.sql                      pg_dump --no-owner --no-privileges
attachments/YYYY/MM/<uuid>        every file, keyed as the database refers to it
```

`tar tzf` reads it. That is the requirement the format was chosen for: the
archive has to be openable with tools an operator already has, on a machine
where this project is not installed, at three in the morning.

The tar reader and writer are written rather than depended on — about 180 lines
for the subset used here, with no long names, no symlinks and no extended
headers. A name that does not fit ustar's 100 bytes is refused rather than
truncated; a truncated name is a file that restores to the wrong place and says
nothing about it. Nothing this project writes comes close to the limit, and the
check is there because "comes close" is a claim about today's schema.

Keys are joined with forward slashes on every platform. An archive written on a
Windows development machine whose keys contained backslashes would restore on
Linux to files no row can find.

## What it needs

`pg_dump` and `psql`, version 18 or newer, on `PATH`. The tool shells out to
PostgreSQL's own client tools rather than reimplementing a dump format that
changes between versions.

The container image installs `postgresql-client-18` from PGDG for this reason —
Debian bookworm ships 15, and a pg_dump older than its server refuses outright.
That refusal is the good outcome; the bad one is no `pg_dump` in the image at
all, discovered at the moment somebody needs a backup.

Verified by building the image and running the commands inside it: 18.6 from
PGDG, an archive written to the bind mount and read back by `verify`. That build
also found that every backup command in `docs/deployment/docker.md` was
unrunnable — they said `pnpm`, and the runtime image has Node and no package
manager. See `docs/engineering/docker-first-build.md`.

## Encrypting the archive

```bash
pnpm backup --encrypt-to age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
pnpm restore atarimae-2026-08-19.tar.gz.age --identity ~/.age/key.txt
```

Optional, and the shape of it is the whole point. This file refused archive
encryption once, and that refusal still stands for the obvious version: a
passphrase or a generated key would be a _second_ thing to lose alongside
`ENCRYPTION_KEY_CURRENT`, and an operator who loses one loses both. Moving a
problem is not solving it.

So: **Atarimae never generates, stores or sees a key.** You name a recipient
you already manage — an age public key, or an SSH public key you already use —
and `age` encrypts to it. Decryption needs an identity file this project also
never touches. Losing that key is the same event as losing your SSH key, which
is a risk operators already have habits about.

`age` rather than GPG: one binary, one flag, no keyring, no agent, no trust
model to explain.

**If `age` is not installed, this refuses.** It does not fall back to writing
the archive unencrypted. A backup that is not encrypted is recoverable; a
backup somebody _believes_ is encrypted, on a USB drive in a van, is not a
mistake they find out about in time.

Encryption happens last, after reconciliation and after the digests. Those are
about what went in; doing it earlier would only mean verifying ciphertext.

The recipient goes on the command line and the identity does not — a public key
is not a secret, so a process list seeing it costs nothing, while a private key
is passed as a path and never as its contents.

**Verified against real age**, v1.3.1, not only against a stub. A keypair from
`age-keygen`, a backup encrypted to it, the file confirmed to begin
`age-encryption.org/v1`, `verify` decrypting it, and a full restore into an
empty database matching every row count and all three attachments. Both
refusals were exercised too: the wrong identity reports age's own "no identity
matched any of the recipients", and no identity at all names what is missing
rather than failing inside gunzip.

Sixteen unit tests cover the rest by injecting `spawnSync` — the command handed
to age, and every way it can fail, including exiting zero with zero bytes,
which would otherwise write an empty file with a reassuring name.

## Downloading one over HTTP

```
POST /api/v1/backup/export   { "password": "…" }
```

This file refused this once, and the refusal was right about what it was
worried about: **one request that carries away every password hash, every
message and every attachment.** Shell access to the host was the barrier, and
this removes it.

It exists because the barrier was also doing something else. An operator who
cannot open a terminal was, in practice, an operator with no backups — and a
backup feature nobody can use is the same as not having one. That cost was
real, and it was the one being paid.

So it is built, and made as narrow as the threat allows:

- **Owner only.** Not admin. Owner is already the role that can grant Owner, so
  no new capability reaches anybody who did not have everything already.
- **People only.** An API token is refused before the handler runs. A leaked
  integration token must not become the whole database.
- **The password, again, now.** The important one. A stolen session cookie is
  the realistic attack, and this makes the cookie alone insufficient.
- **Audited, including refusals.** Somebody holding an Owner session but not
  the password is somebody who took that session, and that row is the more
  interesting of the two.
- **Five per hour.** Argon2 on every attempt and a full dump on every success.
- **Refuses an inconsistent system outright.** No `--allow-missing-attachments`
  here. The command line can ask a person; a request has nobody to ask, and an
  archive pulled through a browser is one nobody inspects before trusting it.

**What none of that fixes**, stated plainly rather than buried under the list:
an Owner who is hostile, or an Owner whose password is taken along with their
session. Against those this endpoint is exactly as dangerous as it first looks.
An operator who does not want it should not expose the application to the
internet without a proxy that requires something more.

## Deliberately not done

- **No scheduling.** `cron` exists and is better at it. The tool's job is to
  make one backup trustworthy.
- **No incremental or differential backups.** Everything, every time. An
  organisation small enough to run one container has a database measured in
  megabytes, and an incremental chain is a way to discover that one link is
  missing only when restoring.
- ~~No encryption of the archive itself.~~ **Optional, via `age`.** The
  original objection stands for the obvious version and is why this is the
  narrow one: Atarimae never generates, stores or sees a key. See below.
- ~~No backup over HTTP.~~ **Built, and made as narrow as the threat allows.**
  See below — the original objection is not withdrawn, it is mitigated and then
  stated again.
- **No automatic restore verification.** `backup:verify` proves an archive is
  internally complete; it cannot prove the dump's contents are meaningful. For
  that, restore onto a spare machine. A backup you have never restored is not a
  backup.

## Testing it

33 unit tests over the three pure parts, which is where the decisions are: the
tar round trip (including sizes that do not land on a 512-byte boundary, and
bytes that are not text), the manifest's refusal of a format version it does not
understand, and the reconciliation in both directions.

The command itself was checked against a real PostgreSQL 18 and a real archive:
a backup of 37 tables and three attachments, `tar tzf` and GNU `tar x` reading
it, a restore into an empty database matching every row count, and then each
refusal in turn — a restore over a populated database without `--force`, a
single flipped byte in an attachment, a truncated archive, and a backup taken
while one attachment file was missing. The last one writes no archive at all.
