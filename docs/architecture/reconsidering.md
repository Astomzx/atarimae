# Six decisions, up for reconsideration

Everything else on the "deliberately not done" lists is being built. These six
are not, yet, because each was refused for a stated reason rather than for want
of time — and CLAUDE.md's first rule is that a settled decision needs an
explicit discussion, not a quiet refactor.

This document is that discussion, laid out so it can be had one item at a time.
For each: what the reason was, what overturning it costs, and whether it touches
the product's argument or only its convenience.

Nothing here has been changed. That is the point.

日本語版: `reconsidering.ja.md`. The two say the same thing; if they ever stop
agreeing, the Japanese one is the one the author reads and therefore the one
that is right.

---

## 1. Offline reading of announcements

> It is the feature people ask for first and the one that would break the rule
> at the top of this file. — `pwa.md`

**The reason.** The rule is that the service worker caches the shell and
nothing that carries meaning. A cached announcement list shown as current is "a
driver reading yesterday's instructions believing they are today's". That
sentence is the product's thesis applied to a cache.

**What overturning costs.** Not much code — the worker already has a cache and
the client already has TanStack Query. The cost is entirely in the interface:
`pwa.md` names the condition, which is that cached content must carry the time
it was fetched, **on screen, every time**. Not a subtle badge; a line the reader
cannot miss. And "every time" has to survive future layout work, which means it
belongs in the component that renders an announcement, not in a wrapper somebody
can forget.

**Does it touch the argument?** Yes, directly, and it is the one item here where
doing it well is _more_ honest than not doing it. A driver in a basement with no
signal currently sees nothing. Showing them yesterday's roster clearly stamped
"取得 昨日 18:32" is better than showing nothing, **provided** the stamp is
unmissable and acknowledgement stays impossible offline (which it already is,
and has an E2E test).

**Recommendation: do it**, with the on-screen timestamp as a hard requirement
and an E2E test that fails if it is absent. This is the item most likely to be
worth reversing.

---

## 2. Account lockout after repeated failures

> Rate limiting slows guessing; it never locks a real person out of their own
> account, which for a shift-roster board is the worse failure. — `security.md`

**The reason.** Lockout converts an availability problem into a denial of
service that anyone can trigger against a named colleague by typing their email
and guessing wrong five times. For software whose job is telling people when
their shift is, being unable to sign in at 05:00 is worse than the attack
lockout prevents.

**What overturning costs.** Small to build, and it introduces the attack above
unless it is scoped carefully — lock the _source address_ rather than the
account, or require an administrator to unlock, which is a person who may be
asleep.

**Does it touch the argument?** It touches "the basics should just work". An
account you cannot get into is the opposite of that.

**Recommendation: keep it as it is.** Sign-in already refuses after ten attempts
per address per fifteen minutes, and that is now tested. If more is wanted, the
honest addition is _notifying_ the account owner of repeated failures, not
locking them out.

---

## 3. Backup over HTTP

> A full dump streamed through the application is an endpoint that returns the
> entire database, and no permission check is worth that much. — `backup.md`

**The reason.** The endpoint would be a single request that exfiltrates
everything: password hashes, every message, every attachment. One authorisation
bug, one stolen Owner session, one leaked API token, and the whole system is
gone in one call. The current design requires shell access to the host.

**What overturning costs.** The build is easy and the risk is permanent.

**Does it touch the argument?** It touches the security posture rather than the
thesis. But note the asymmetry: the feature saves an operator one `docker
compose exec`, and the failure loses them everything.

**Recommendation: keep it as it is.** If the goal is "an organisation can take
its own data and leave" without a terminal, the safer shape is the CSV export
that already exists per announcement, extended rather than replaced by a
whole-database endpoint.

---

## 4. Encryption of the backup archive

> Adding a second key to lose in order to protect a file the operator already
> has to store safely moves the problem rather than solving it. — `backup.md`

**The reason.** The archive already excludes `ENCRYPTION_KEY_CURRENT`
deliberately. Encrypting the archive introduces a second key with the same
lose-it-and-it-is-gone property, and operators who lose keys lose both.

**What overturning costs.** Moderate. The honest version is not a new key but
_age_/GPG support — encrypt to a public key the operator already manages, so
this project never holds a secret it can lose.

**Does it touch the argument?** No. This is a genuine engineering trade with no
thesis attached.

**Recommendation: do it, but only as "encrypt to a key you already have".**
Never generate or store a key here. `pnpm backup --encrypt-to <recipient>`
shelling out to `age` if present, refusing clearly if not.

---

## 5. Embedding the call room

> Embedding it would mean a vendor's SDK on every page, which is precisely the
> lock-in a configurable provider exists to avoid. — `calls.md`

**The reason.** 通話 is deliberately "the provider carries the media, Atarimae
carries everything else". An embedded SDK reverses that: the vendor's JavaScript
runs on every page of your announcement board, and swapping providers stops
being a settings change.

**What overturning costs.** It would also require relaxing the CSP that M6a just
established — `frame-src 'none'` and `script-src 'self'` both exist for reasons
written down in `security.md`, and the frame one guards acknowledgement against
clickjacking.

**Does it touch the argument?** Yes, twice: provider independence and the CSP.

**Recommendation: keep it as it is.** If the separate window is the actual
complaint, that is a window-management problem with better answers than an
embedded SDK.

---

## 6. Protection against a hostile administrator

> An Owner can read everything and change everything. The audit log records
> that they did, which is a different guarantee from preventing it.
> — `security.md`

**The reason.** Prevention here means end-to-end encryption or multi-party
authorisation. Both are large, and both fight the product: an Owner who cannot
read an announcement cannot administer the board, and a small company does not
have two people to co-sign a shift change at 05:00.

**What overturning costs.** Very large, and it changes what the product is.

**Does it touch the argument?** Yes. "An administrator can add an
administrator" is on the front page. A system that distrusts its own
administrators is a different product.

**Recommendation: keep it as it is**, and consider the smaller honest step
instead: make the audit log _visible_ to non-administrators for actions taken on
their own account, so a hostile Owner is detectable by the person affected
rather than only by another Owner.

---

## Summary

|                                     | Recommendation                                       |
| ----------------------------------- | ---------------------------------------------------- |
| 1. Offline reading of announcements | **Done** (M6a) — unmissable fetch time, E2E-enforced |
| 2. Account lockout                  | Keep; notify instead of locking                      |
| 3. Backup over HTTP                 | Keep; extend CSV export instead                      |
| 4. Encrypting the archive           | **Done** (M6a) — `--encrypt-to`, no key held here    |
| 5. Embedding the call room          | Keep                                                 |
| 6. Hostile administrator            | Keep; show people their own audit trail              |

Two to build, four to leave — and three of the four have a smaller, honest
alternative worth doing instead.
