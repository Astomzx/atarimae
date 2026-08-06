# Technical decisions (M0)

Decisions made while building the foundation, and why. Product and data-model
decisions live in the specification documents; this file covers the toolchain.

---

## PostgreSQL 18 is a hard requirement

Two features justify the floor, and both are checked at migration time by
`migrations/*_schema-conventions.sql`, which fails with a readable message
rather than letting a later migration break confusingly.

**`uuidv7()`** — primary keys are time-ordered, so inserts land at the right
edge of the B-tree instead of scattering across it the way `uuidv4` does. The
specification allowed "UUID or ULID"; UUIDv7 gives ULID's ordering with a
standard type PostgreSQL generates natively, so no application-side ID
generation is needed.

**Builtin `C.UTF-8` collation provider** — this is not a preference, it is a
correctness requirement. Creating a database on Windows without specifying a
locale produces `Japanese_Japan.936` (CP932), while a Linux container produces
something else entirely. Collation affects `ORDER BY` results, index behaviour,
and which values a unique index considers equal. Development and production
silently disagreeing about that is a bug that surfaces months later and is very
hard to trace.

`scripts/db.mjs` always creates databases with:

```sql
CREATE DATABASE ... TEMPLATE template0 ENCODING 'UTF8'
  LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8'
```

Japanese-aware sorting, where needed, is applied per query or per column with an
explicit `COLLATE`, not inherited from whatever the host happened to default to.

---

## Migrations are plain SQL, and reversibility is enforced

`node-pg-migrate` supports both a JavaScript builder API and raw SQL files. This
project uses SQL because its schema leans heavily on things the builder API
expresses awkwardly:

- partial unique indexes (`WHERE waived_at IS NULL AND superseded_at IS NULL`)
- multi-branch `CHECK` constraints on polymorphic target references
- cross-column conditional constraints (waive requires a reason)

These are the constraints that make the acknowledgement model trustworthy. They
should be readable as SQL in review, not assembled through a wrapper.

`pnpm db:verify` runs `up → down → up` against the test database. A migration
without a working Down Migration fails in CI rather than during a production
rollback.

---

## TypeScript is pinned to 5.9, not 7

TypeScript 7.0 is released, but `typescript-eslint@8.66` declares
`typescript: ">=4.8.4 <6.1.0"`. Adopting TS 7 today means giving up
type-aware linting — including `no-floating-promises`, which catches the most
common class of silent failure in a Fastify plus background-worker codebase.

Revisit when typescript-eslint supports 7.x.

---

## Format validators must be registered twice

There are two validation engines in the request path and they do not share
configuration:

- **ajv**, which Fastify uses to validate requests and responses
- **TypeBox `Value`**, used for anything checked outside a route (config
  loading, worker payloads)

TypeBox ships no format validators at all — an unregistered `format` makes
`Value.Check` fail outright with "Unknown format". ajv silently _ignores_
unknown formats, which is worse: `format: "uuid"` in a route schema becomes a
no-op and malformed ids reach the query layer.

So `packages/api-schema/src/formats.ts` registers them for TypeBox, and
`apps/server/src/app.ts` registers `ajv-formats` for Fastify. The two must stay
in agreement. `apps/server/src/app.test.ts` has a probe route asserting that
route-level format validation is actually active — without it, a regression here
is invisible.

---

## Framework errors keep their status

Fastify raises its own errors for oversized bodies (413), unsupported content
types (415) and unparseable JSON (400). The error handler preserves those
statuses and maps them onto the shared error codes.

The alternative — treating everything that is not an `ApiError` as a 500 — both
misleads the client and buries genuine server faults in noise. This was caught
by a test asserting an oversized body never produces a 500.

---

## `encrypt`/`decrypt` are `async` even though the work is synchronous

AES-GCM is synchronous, so returning `Promise.resolve(...)` is tempting. But a
synchronous `throw` from a method declared to return a `Promise` slips past
`.catch()` at the call site, so a decrypt failure would surface as an uncaught
exception instead of a rejected promise.

The interface stays promise-based for a second reason: it is the seam where an
external KMS or HSM would be substituted without touching callers.

---

## What gets encrypted, what gets hashed

| Value                    | Treatment               | Why                                 |
| ------------------------ | ----------------------- | ----------------------------------- |
| SMTP password            | Encrypted (AES-256-GCM) | Must be replayed to the SMTP server |
| Call provider API secret | Encrypted               | Must be sent to the provider        |
| Atarimae API token       | SHA-256 hash            | Only ever compared, never replayed  |
| User password            | Argon2id                | Only ever compared                  |
| Session token            | SHA-256 hash            | Only ever compared                  |

If the plaintext never has to leave the server, hash it. Encryption is strictly
for credentials Atarimae presents to other systems.

Ciphertext carries its key id (`enc:v1:key01:...`) so rotation never requires a
data migration: `ENCRYPTION_KEY_PREVIOUS` keeps old rows readable while new
writes use the current key.

**Losing `ENCRYPTION_KEY_CURRENT` makes every stored external credential
permanently unrecoverable.** It must be backed up alongside — but never inside —
the database dump. This belongs in the deployment documentation prominently.
