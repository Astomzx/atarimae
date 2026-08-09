# Service accounts and API tokens

How something other than a person uses the API, and which failure each decision
prevents.

## Why not a personal access token

The obvious design is a token that acts as whoever created it. It fails on a
predictable day: that person leaves, their account is disabled, and the nightly
roster import stops. What is left to point at is somebody's resignation.

An integration must not be anybody's personal property. A service account is an
identity of its own, with its own role, that outlives the staff list.

## Why service accounts are rows in `users`

They author announcements and messages, they appear in `audit_logs`, they are
referenced by `created_by`. Every one of those is a foreign key to `users(id)`.

A separate identity table means making each of those columns nullable and
checking two of them everywhere, forever — and getting it wrong once means a
message with no author.

The cost is the opposite risk: a query that means "people" and says `users` now
silently includes robots. That is paid down explicitly:

| Place                    | What it does            | Why it matters                                                                                      |
| ------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------- |
| `resolveTargetUsers`     | `AND u.kind = 'person'` | A robot in the denominator of an announcement it cannot acknowledge stops the rate at 12/13 forever |
| `GET /users`             | `AND u.kind = 'person'` | Otherwise a robot appears in the member picker, the mention list and "start a conversation"         |
| `openDirectConversation` | `AND u.kind = 'person'` | A one-to-one conversation with something that will never read it                                    |

Each has a test. The announcement one is the reason to care: it fails quietly
and permanently, and nobody can say which recipient is missing.

## What the database refuses

Three CHECK constraints, so the rules are facts rather than intentions:

- `ck_users_kind` — `kind IN ('person', 'service')`
- `ck_service_accounts_have_no_password` — a service account's `password_hash`
  is always NULL, so interactive sign-in is impossible rather than merely
  refused. Sign-in has nothing to compare against.
- `ck_service_accounts_are_not_owners` — Owner is the role that can grant
  Owner. A token holding it is one leak away from being the whole
  organisation, so admin is as high as an integration goes.

The tests assert these by writing directly to the database, not through the
API: a rule enforced only by application code is not enforced.

## Tokens are hashed, never encrypted

The same rule as session tokens, for the same reason. The server only ever
_compares_ a token; it never presents one to anybody. Storing something
decryptable would be keeping a copy of every live credential for no purpose.

SHA-256, not Argon2: the secret is 256 bits from a CSPRNG, so there is nothing
to brute force, and a deliberately slow hash on every API request would be a
self-inflicted rate limit.

The consequence is visible in the interface: the token is shown **once**, at
creation. "Show it to me again" has no answer, because the server genuinely
cannot produce it. Losing one means issuing another and revoking the first.

What is stored alongside is the prefix — `atk_7Fh2Kq` — which is enough to
identify a token in a list for revocation and not enough to use it. The `atk_`
marker also makes the token recognisable to a secret scanner in a leaked file.

The audit log records the prefix and never the token: an audit trail that
records credentials is a second place to steal them from.

## What a token may never do

`denyTokenAuth` refuses token authentication on a small, specific set:

- issuing tokens, and managing service accounts
- signing out, listing sessions, revoking sessions

The first is containment. Without it, a leaked admin token mints a second token
that outlives the revocation of the first, and ending a leak stops being
possible by revoking one row. The second is simply that sessions belong to
people; a token has none.

Everything else an admin can do, an admin token can do. That is the point of it.

## Revocation

Authentication looks the token up on every request and caches nothing, so all
three of these take effect on the very next call:

- revoking the token
- disabling the service account
- the token's `expires_at` passing

`last_used_at` is updated on each request and deliberately not awaited — it
answers "is this integration still running", and must not add latency to the
request that proves it is.

## Limits

- No scopes. A token has the role of its account, and roles are the whole
  permission model. Scopes on top of roles would be a second answer to the same
  question, and the first one to be wrong.
- No rotation flow. Issue a second token, move the integration, revoke the
  first — which works today and needs no feature.
