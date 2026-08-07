# Engineering regressions

Real defects found while building, not while reasoning about the design. Every
one surfaced only when something was actually run.

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

## 7. A synchronous Fastify hook hangs the request forever (M1)

`requireAuth` was written as an ordinary synchronous function:

```ts
export function requireAuth(request: FastifyRequest, _reply: FastifyReply): void {
  if (!request.user) throw ApiError.unauthenticated();
}
```

Fastify decides how to wait for a hook from its **arity**. Three parameters
means the callback style, and it waits for `done()`. Two parameters means the
promise style, and it waits for the returned promise to settle. This function
takes two parameters and returns `undefined`, so Fastify waited for a promise
that never existed.

Every authenticated request hung until the test timeout. No error, no log line,
no stack trace — the request simply never completed. The first symptom was 16
failing tests and a suite that took 57 seconds instead of 7, which points at
performance rather than at a hook signature.

**Fix**: `requireAuth` and the function returned by `requireRole` are declared
`async`. The `done` form would also work; async is harder to get subtly wrong,
because forgetting to call `done()` reproduces exactly this bug.

**Guarded by**: `apps/server/src/identity.test.ts` — every case behind a
permission check exercises the hooks. Any regression here fails the entire
authenticated suite rather than one assertion.

---

## 8. A JSON content-type on every request, including those with no body (M1)

The browser API client set one header unconditionally:

```ts
headers: { "content-type": "application/json", ...init?.headers }
```

Fastify rejects a request that declares a JSON body and then sends nothing:

```
400  Body cannot be empty when content-type is set to 'application/json'
```

So **every write with no request body was broken**: sign-out, disable user,
restore user, disable unit, restore unit, revoke session, remove from unit.

96 server tests and 30 E2E tests were green throughout. None of them went
through this code — the server tests use `inject`, and the E2E suite used
Playwright's own request context. The client had no coverage at all.

It surfaced by clicking sign-out in a browser and noticing the page did not
change.

**Fix**: set `content-type` only when there is a body.

**Guarded by**: `e2e/tests/m1-ui.spec.ts` — drives the real interface with real
client code, and deliberately covers the empty-bodied writes (sign-out, disable,
restore) rather than only the ones that send JSON.

---

## 9. Sign-out that left the previous user on screen (M1)

Even once the request succeeded, sign-out did this:

```ts
queryClient.clear();
navigate("/login", { replace: true });
```

Clearing the cache does not unmount anything, so components kept their last
render: the previous user's name, role and the full member list stayed visible
after the session cookie was gone. It looked exactly like a failed sign-out.

There is a second reason not to do it this way. On a shared machine, a
client-side navigation leaves the previous user's data in memory for whoever
sits down next.

**Fix**: `window.location.assign("/login")` — a full page load, in `onSettled`
so it happens whether or not the request succeeded.

**Guarded by**: `e2e/tests/m1-ui.spec.ts` — asserts after sign-out that
`/auth/me` returns 401 _and_ that a protected route renders the sign-in screen
rather than stale content.

---

## 10. `removeAdditional: "all"` silently breaks every union body (M2)

The server's ajv was configured with:

```ts
customOptions: {
  removeAdditional: "all";
}
```

which sounds like a tightening. It is, for plain objects. For an `anyOf` — a
discriminated union like `AnnouncementTarget` — it is destructive: **ajv strips
properties it considers additional _before_ evaluating the branches**. So

```json
{ "kind": "org_unit", "orgUnitId": "018f..." }
```

loses `orgUnitId`, then matches no branch, and comes back as:

```
400  body/targets/0/kind must be equal to constant,
     must have required property 'orgUnitId',
     must match a schema in anyOf
```

The error accuses the client of sending exactly what it did send. Every
union-bodied request was rejected, and setting targets — the step everything
else in M2 depends on — could not succeed at all.

It was found only because a test helper was made to fail loudly on a
non-200 from `setTargets`. Without that, thirteen tests failed three
assertions downstream with `NO_TARGETS`, pointing at publishing rather than at
ajv.

**Fix**: `removeAdditional: false`. Undeclared properties are never read
anyway, so stripping them bought nothing worth a broken union.

**Guarded by**: `apps/server/src/announcements.test.ts` — every publishing test
sets targets through the union schema, so a regression fails the whole suite
immediately.

---

## 11. A named schema used twice in one response (M2)

TypeBox schemas carrying `$id` become `$ref` components. `AnnouncementDetail`
referenced `ContentRevisionSummary` twice — once for the current revision, once
for the published one — and Fastify refused to build the serializer:

```
reference "ContentRevisionSummary" resolves to more than one schema
```

It fails at route registration, so it is loud rather than subtle. But it fails
one `$id` at a time: fixing `ContentRevisionSummary` revealed the same problem
in `ContentChangeKind`, then in `AnnouncementStatus`.

**Fix and rule**: only top-level request and response shapes carry `$id`.
Nested value types — enums, small embedded objects — do not.

---

## The pattern

Nine of the eleven share one shape: **the system reports success while doing
nothing**, or reports a fault while working correctly, or simply never answers.
Nothing crashed, no stack trace pointed anywhere useful.

Number 10 adds a third lesson, about diagnosis rather than design: **a helper
that swallows a failed setup step relocates the symptom**. Thirteen tests
blamed publishing for a fault in request validation, because the helper that
set targets ignored its own status code. Making setup steps fail loudly, at the
point they fail, is worth more than any amount of downstream assertion detail.

Number 8 adds a second lesson: **a layer with no tests is a layer with no
evidence**, however green everything around it is. The server was thoroughly
covered and entirely correct; the twenty lines of fetch wrapper between it and
the user were not covered at all, and that is where the product broke.

That is the same failure mode the announcement model is built to eliminate —
an administrator clicking "request acknowledgement", seeing success, and nobody
being asked. Silent success is the enemy here, at every layer.
