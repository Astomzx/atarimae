# M0 regressions

Six real defects found while building the foundation. None came from reasoning
about the design — every one surfaced when something was actually run.

**Each entry names the test that now prevents it.** A regression without a test
is a note, not a guard; if a test here is ever deleted, the corresponding defect
is once again reachable.

---

## 1. A `Promise`-returning method that throws synchronously

`SecretStore.decrypt` was declared `Promise<string>` but built its return with
`Promise.resolve(...)`, so every validation failure threw synchronously.

Callers writing the obvious thing:

```ts
await store.decrypt(value).catch(handleBadCiphertext);
```

would never reach `handleBadCiphertext`. The throw happens while evaluating the
argument, before any promise exists, so it escapes as an uncaught exception. In
the SMTP worker that means a process-level crash instead of a logged delivery
failure.

**Fix**: `encrypt` and `decrypt` are genuine `async` methods. Every failure is a
rejection.

**Guarded by**: `packages/secret-store/src/secret-store.test.ts` — all failure
paths assert with `await expect(...).rejects`, which only passes on a rejected
promise.

---

## 2. Framework errors collapsed into 500

The error handler recognised `ApiError` and Fastify validation errors, then sent
everything else to 500. But Fastify raises its own errors with meaningful
statuses: 413 for oversized bodies, 415 for unsupported content types, 400 for
unparseable JSON.

A client uploading a too-large attachment was told the server had an internal
fault. Worse, genuine 500s became statistically invisible — the log filled with
"internal errors" that were ordinary client mistakes, which is how a real fault
goes unnoticed for a week.

**Fix**: any error carrying a 4xx status keeps it and maps onto the shared error
codes. Only genuinely unknown errors become 500, logged in full and disclosed as
nothing.

**Guarded by**: `apps/server/src/app.test.ts` — separate cases asserting 413 /
`PAYLOAD_TOO_LARGE`, 415 / `UNSUPPORTED_MEDIA_TYPE`, 400 / `VALIDATION_FAILED`,
plus one asserting an unexpected throw returns 500 without leaking the message.

---

## 3. Format validators silently absent — in two different ways

Two validation engines sit in the request path and share no configuration:

| Engine            | Used for                    | Behaviour with an unregistered format |
| ----------------- | --------------------------- | ------------------------------------- |
| ajv (via Fastify) | request/response validation | **Silently ignores it**               |
| TypeBox `Value`   | config, worker payloads     | Fails with "Unknown format"           |

The TypeBox side failed loudly at startup, which was easy. The ajv side is the
dangerous one: `format: "uuid"` in a route schema becomes a no-op, malformed ids
pass validation and reach the query layer, and the failure surfaces months later
as a puzzling database error.

**Fix**: `packages/api-schema/src/formats.ts` registers formats for TypeBox;
`ajv-formats` is registered with Fastify. The two must stay in agreement.

**Guarded by**: `apps/server/src/app.test.ts` — a probe route with a
`format: "uuid"` parameter, asserting a well-formed UUID is accepted and a
malformed one is rejected with 400. Without this test the regression is
invisible: nothing errors, validation just stops happening.

---

## 4. IPv4 / IPv6 address family mismatch

Vite with no explicit `host` binds `::1` on Windows. Playwright's `baseURL` used
`127.0.0.1`. Playwright's readiness probe tries both families, so it reported
the server up, then all six E2E tests failed with `ERR_CONNECTION_REFUSED`.

The symptom looks like an application fault. It is an address-family mismatch,
and it costs an hour if you have not seen it before.

**Fix**: `apps/web/vite.config.ts` binds `127.0.0.1` explicitly, for both `server`
and `preview`. The API server already defaults to `127.0.0.1`.

**Guarded by**: `e2e/tests/environment-invariants.spec.ts` — asserts the Vite
config pins IPv4 and that the Playwright config uses `127.0.0.1` rather than
`localhost`. The E2E suite itself is the broader guard: if the binding regresses,
every spec fails.

---

## 5. Windows default collation differs from production

`CREATE DATABASE` with no locale produces `Japanese_Japan.936` (CP932) on a
Japanese Windows host. Encoding was UTF8, so it looked fine — but collation
governs `ORDER BY` results, index behaviour, and which values a unique index
considers equal.

A development machine and a production container disagreeing about that is a
correctness bug that shows up as "sorting is different in production" or, far
worse, a uniqueness constraint that behaves differently in each environment.

**Fix**: `scripts/db.mjs` always creates databases with

```sql
TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8'
```

The builtin provider is byte-identical across platforms. Japanese-aware sorting,
where required, is applied per query or per column with an explicit `COLLATE`.

**Guarded by**: `apps/server/src/db.test.ts` — asserts the connected database
reports encoding `UTF8`, provider `b` (builtin) and locale `C.UTF-8`. Also
asserts `uuidv7()` exists, since the schema depends on it.

---

## 6. PowerShell 5.1 writes a BOM

`Set-Content -Encoding utf8` on PowerShell 5.1 writes UTF-8 **with** a BOM. The
first line of `.env` became `﻿DATABASE_URL=...`, so `process.loadEnvFile`
registered a variable named `﻿DATABASE_URL` and `DATABASE_URL` read as
undefined.

The file is visually identical in every editor. The error message says the
configuration is invalid while the value is plainly present.

**Fix**: `scripts/setup-env.mjs` writes through Node. Any future file-generating
script does the same — no shell redirects for files another tool will parse.

**Guarded by**: `e2e/tests/environment-invariants.spec.ts` — asserts `.env` does
not begin with `EF BB BF`, and that the generator uses `writeFileSync`.

---

## The pattern

Five of the six share one shape: **the system reports success while doing
nothing**, or reports a fault while working correctly. Nothing crashed, no stack
trace pointed anywhere useful.

That is the same failure mode the announcement model is built to eliminate —
an administrator clicking "request acknowledgement", seeing success, and nobody
being asked. Silent success is the enemy here, at every layer.
