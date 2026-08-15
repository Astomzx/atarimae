# What the M6a security pass found

One real defect, one absence, and one piece of debt that a comment had already
admitted to. Each with the test that now prevents it, in the style of
`m0-regressions.md`.

## 1. The sign-in rate limit could be bypassed with a header

**The bug.** `app.ts` built Fastify with:

```ts
trustProxy: config.NODE_ENV === "production",
```

`trustProxy: true` tells Fastify to take `request.ip` from `X-Forwarded-For`.
That header is set by whoever sends the request. The rate limiter is keyed on
`request.user?.id ?? request.ip`, and sign-in is unauthenticated, so it is keyed
on `request.ip` and nothing else.

So in production, ten sign-in attempts per fifteen minutes was:

```
POST /api/v1/auth/login   X-Forwarded-For: 1.1.1.1
POST /api/v1/auth/login   X-Forwarded-For: 1.1.1.2
POST /api/v1/auth/login   X-Forwarded-For: 1.1.1.3   ...
```

Unlimited attempts, each one costing the server a full Argon2 hash. The same
value is written to `audit_logs`, so the log recorded whatever the attacker
chose to put in a header.

**Why it survived review.** Because the comment on the line was true. It said
"trust the reverse proxy for client IPs, which audit_logs records", and there
_is_ meant to be a reverse proxy — `docs/deployment/docker.md` says so under
"No TLS. Use a reverse proxy." What the comment did not say is that
`docker-compose.yml` publishes port 3000 to the host by default, so "there is a
proxy in front" was an assumption the code depended on and nothing enforced.

Verified rather than reasoned about, which is how it turned from a suspicion
into a finding:

```
trustProxy=true           -> req.ip = 203.0.113.99
trustProxy=false          -> req.ip = 127.0.0.1
trustProxy="10.0.0.1/32"  -> req.ip = 127.0.0.1
```

**The fix.** `TRUSTED_PROXY_IPS`, a list of addresses or CIDR ranges whose
`X-Forwarded-For` may be believed, defaulting to none. Production warns at
startup when it is unset, because both outcomes are wrong in ways nobody would
notice from outside: behind a proxy the whole office shares one budget, and
directly exposed the header would be a lie anybody could tell.

The safe default has a visible cost and the unsafe one had none. That is the
whole reason the default is the safe one.

**The guard.** `rate-limit.test.ts`, "cannot be used to buy a fresh budget when
no proxy is trusted" — exhausts the budget, then sends the same request with a
different `X-Forwarded-For` and requires 429. It was run against the old
behaviour before the fix landed and fails there, which is the only way to know a
regression test tests anything.

## 2. There were no security headers at all

**The absence.** No CSP, no `nosniff` outside the attachment download route, no
frame protection, no referrer policy. The application serves its own interface
and files other people uploaded from one origin, which is the configuration
where all of those matter most.

**The one that matters here** is not the CSP. It is `frame-ancestors 'none'`.
This product's central claim is that an acknowledgement is trustworthy; a
framed page with a transparent overlay produces a real acknowledgement from a
click aimed at something else. Every database constraint would hold and the
claim would be false. There is no schema-level defence against it — see
`docs/architecture/security.md`.

**The fix.** `plugins/security-headers.ts`, applied from an `onSend` hook so it
covers error responses and static files too. Written out rather than taken from
a library, because the value of each header here is the failure it closes, and a
header whose reason nobody can state is a header nobody can safely change.

**The guard.** `security-headers.test.ts` asserts they arrive on a 200, a 404, a
500 and a 401 — the interesting case being the branch nobody looks at. Plus the
CSP checked against the running interface in a browser, because a policy that
breaks the application is a policy that gets deleted rather than fixed.

**One thing the tests did not catch, and the browser did.** The first check of
the headers against a running server found none of them. The plugin was correct;
the preview was running `apps/server/dist`, built before the plugin existed.
Nothing was wrong with the code and everything was wrong with the conclusion
that would have been drawn from unit tests alone.

## 3. Rate limiting had never been observed to work

**The debt.** `app.ts` skips the rate limit plugin entirely when
`NODE_ENV=test`, with a comment ending "Rate limiting gets dedicated coverage in
M6." That skip is necessary — the suite signs in dozens of times against a
ten-attempt budget — but it meant every rate limit in the product was configured
and never once exercised.

A protection disabled in every test is a protection nobody has seen work.
`{ max: 10 }` in a config object is a claim, not evidence.

**The guard.** `rate-limit.test.ts` builds a second app with `NODE_ENV` forced
to `development`, which is the only difference, and drives the same route
configuration the real server uses: the eleventh sign-in is refused, the refusal
carries `Retry-After`, setup refuses the sixth, and the global ceiling is
announced on ordinary responses so a client can see it coming.

## What was looked at and found already correct

Recorded because a security pass that only lists problems reads as if nothing
else was checked.

- Session cookies: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` in production.
- The attachment download route already set `nosniff` and served the type it
  determined rather than the uploader's. The global header duplicates it
  deliberately — a defence in exactly one place is one refactor from none.
- `lib/outbound-url.ts` refuses private and loopback ranges for webhooks, and
  the call-provider exception is deliberate and argued in `calls.md`.
- The logger redacts `authorization`, `cookie`, `set-cookie`, and any field
  named `password`, `smtpPassword` or `apiSecret`.
- `removeAdditional: false` is deliberate and documented; the reason is a
  discriminated-union bug, not laxity.
- Error responses disclose nothing internal — already covered by `app.test.ts`.
