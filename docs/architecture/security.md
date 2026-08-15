# Security

What is defended, how, and what is not defended at all. The last section is the
one worth reading before deploying this.

## The threat this product actually has

Most of what Atarimae holds is not secret. An announcement about next month's
shift roster is not a trade secret, and treating it as one produces software
nobody uses.

What Atarimae holds that _is_ valuable is **a record that somebody read
something**. 確認 says that a named person saw a named revision at a named time,
and `docs/architecture/announcement-model.md` spends its length on making that
record impossible to produce by accident. An attack on this system that mattered
would not be one that reads announcements. It would be one that produces an
acknowledgement nobody made, or destroys one somebody did.

That reordering is why the security work here is not the usual list in the usual
order.

## Clickjacking is the product-specific one

`frame-ancestors 'none'`, plus `X-Frame-Options: DENY` for older browsers.

A page that can be framed can be covered with a transparent overlay, and then a
click aimed at something else lands on 確認. Every constraint in the
announcement model would still hold: the row would be well-formed, the revision
id would be right, the timestamp would be real. The record would be correct and
the claim it exists to support — that this person read this — would be false.

There is no constraint in a database that can catch this. It has to be stopped
in the browser, which is why the header is not optional and why it is asserted
by a test rather than left to a plugin's defaults.

## The rest of the headers

Set by `apps/server/src/plugins/security-headers.ts` on every response, from an
`onSend` hook — including error responses and static files, because a header
that depends on which branch produced the reply is a header that is missing
exactly where somebody is probing.

| Header                            | The failure it closes                                                     |
| --------------------------------- | ------------------------------------------------------------------------- |
| `content-security-policy`         | Stored XSS becomes a bug rather than an account takeover                  |
| `x-content-type-options: nosniff` | An uploaded file whose bytes look like HTML rendering as a page from here |
| `x-frame-options: DENY`           | The above, for browsers that predate `frame-ancestors`                    |
| `referrer-policy: no-referrer`    | Internal uuids leaving the building in a `Referer`                        |
| `cross-origin-opener-policy`      | Another origin holding a handle on this window                            |
| `cross-origin-resource-policy`    | Another origin loading an attachment as an image or a script              |
| `permissions-policy`              | Camera, microphone, location — none of which this application asks for    |
| `strict-transport-security`       | Production only, where TLS is a documented requirement                    |

The CSP allows no inline script, no `eval` and no inline style. That is
affordable because the built client happens to need none of them — one external
module script, one external stylesheet, no `style` attributes, no blob URLs —
and it is written down here so that a future concession has to be argued for
rather than absorbed.

HSTS is deliberately one year with **no `includeSubDomains` and no `preload`**.
This is somebody's own domain, and the neighbouring subdomain is as likely to be
a printer's status page on plain HTTP as anything else. Breaking an unrelated
internal service from a header set by the announcement board is not a trade this
project makes on an operator's behalf.

## Identity and sessions

- Passwords are Argon2id (`@node-rs/argon2`), never stored or logged.
- The session cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure`
  whenever `NODE_ENV=production`. `SameSite=Lax` is what stops a cross-site form
  post from acting as the signed-in user; there is no separate CSRF token
  because there is no state-changing `GET`.
- One account works on several devices at once, and signing in on a second never
  invalidates the first. That is a product rule, not an oversight — see the
  tagline.
- Sessions are rows, so revoking one takes effect on the next request rather
  than when a token happens to expire.
- API tokens belong to service accounts, not people. What a leaked one still
  cannot do is in `docs/architecture/service-accounts.md`.

## Rate limiting, and who "you" are

300 requests a minute globally; ten sign-in attempts per fifteen minutes; five
first-run setup attempts per fifteen minutes. The tight two are the endpoints
that do Argon2 work on unauthenticated input, which makes them both the
password-guessing target and a cheap way to burn every core the server has.

The budget is keyed on the authenticated user where there is one, and on
`request.ip` otherwise — so several people behind one office NAT do not share a
budget once they have signed in.

**Which makes `request.ip` a security-relevant value, and it is only as
trustworthy as the header it comes from.** See `TRUSTED_PROXY_IPS` below, and
`docs/engineering/m6a-security.md` for the defect that made this section exist.

Rate limiting is skipped when `NODE_ENV=test`, because the rest of the suite
signs in dozens of times. `rate-limit.test.ts` builds its own app with that skip
turned off — a protection that is disabled in every test is a protection nobody
has ever seen work.

## Uploads

Four rules, each closing a specific hole, in
`docs/architecture/attachments.md`. In summary: the extension must be on an
allow-list, the bytes must match what the extension claims, the stored path is
generated here and never derived from the uploaded name, and permission is
checked again on download because a link is not a capability.

No virus scanning. Stated plainly because it is the thing people assume: the
rules verify what a file _is_, not whether its contents are hostile.

## Outbound requests

A webhook is a URL an administrator supplies, and the server then fetches it —
which is a server-side request forgery engine unless it is constrained.
`lib/outbound-url.ts` refuses private and loopback ranges, and
`docs/architecture/webhooks.md` says why the timestamp is signed with the body.

Call providers are the deliberate exception: a provider URL _may_ point inside
the network, because a self-hosted meeting server on the LAN is the ordinary
case. The reasoning for the asymmetry is in `docs/architecture/calls.md` — the
difference is that nobody's browser follows a webhook, and everybody's browser
follows a call link.

## Backups

The archive contains password hashes and every message. The encryption key is
deliberately _not_ in it. See `docs/architecture/backup.md`.

## What is not defended

Stated plainly so none of it is a surprise.

- **No TLS.** Use a reverse proxy. Sign-in does not work without it in
  production, because the cookie is `Secure`.
- **No two-factor authentication.** A password is the whole of it.
- **No account lockout.** Rate limiting slows guessing; it never locks a real
  person out of their own account, which for a shift-roster board is the worse
  failure.
- **No virus scanning of uploads.**
- **No audit of reads.** `audit_logs` records changes, not who looked at what.
- **No protection against a hostile administrator.** An Owner can read
  everything and change everything. The audit log records that they did, which
  is a different guarantee from preventing it.
- **No dependency scanning in CI.** `pnpm audit` is not wired in.
- **No penetration test.** Nobody has attacked this but its author.

## Testing it

`security-headers.test.ts` asserts the headers reach a real response — on a 200,
a 404, a 500 and a 401, because the interesting case is the branch nobody looks
at. `rate-limit.test.ts` proves the limits refuse, say how long to wait, and
cannot be bought around with a header.

The policy was also checked against the running interface rather than only
asserted: the built client served by the container's own static route, loaded in
a browser, with the service worker registering and the realtime socket opening
under the full CSP and no violations reported. A CSP that breaks the application
is a CSP that gets deleted.
