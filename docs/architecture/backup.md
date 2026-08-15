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

**That Dockerfile change has not been built yet.** Docker was not running on the
machine where this was written, so the PGDG apt lines and the `packages/backup`
build step are the one part of this feature that has only been read, not run.
Everything above was exercised against a real PostgreSQL 18 outside a container.

## Deliberately not done

- **No scheduling.** `cron` exists and is better at it. The tool's job is to
  make one backup trustworthy.
- **No incremental or differential backups.** Everything, every time. An
  organisation small enough to run one container has a database measured in
  megabytes, and an incremental chain is a way to discover that one link is
  missing only when restoring.
- **No encryption of the archive itself.** It contains password hashes and
  message content and should be treated accordingly, but adding a second key to
  lose in order to protect a file the operator already has to store safely
  moves the problem rather than solving it.
- **No backup over HTTP.** There is no admin button for this. A full dump
  streamed through the application is an endpoint that returns the entire
  database, and no permission check is worth that much.
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
