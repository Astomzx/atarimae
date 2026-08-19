# What embedding the call room found

Item 5 of `reconsidering.md` — the one refused on the strength of a CSP reading
that turned out to be a misreading. Building it found one real defect, one
browser fact that changes the interface, and one place where the same rule was
about to be written down twice.

Each with the test that now prevents it, in the style of `m0-regressions.md`.

## 1. A placeholder host reached the CSP without complaint

**The bug.** `frameOriginOf` refused anything that was not a URL, which sounds
like enough:

```ts
const parsed = new URL(url);
if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
return parsed.origin;
```

`{` and `}` are not forbidden host code points. So a provider configured with a
template whose host is the placeholder —

```
https://{room}.meet.example.test/
```

— parses happily, and its origin is `https://{room}.meet.example.test`. That
string then went into a response header:

```
Content-Security-Policy: ... frame-src https://{room}.meet.example.test; ...
```

A CSP source that can never match anything, in a header no browser reports a
problem with. The administrator would have ticked the box, the setting would have
saved, and every call would have been a blank rectangle — the exact failure this
project's third rule is about, except in a response header rather than a 200.

**How it was found.** Not by review. A test written to assert the refusal —
"refuses a template whose host is not fixed" — got a 201 back. The test was
written expecting the URL parser to throw, and the interesting part is that the
_test_ was based on the same wrong belief as the code. What made it a finding was
running it.

**The fix.** `frameOriginOf` checks the hostname against what a CSP
`host-source` can actually express (letters, digits, dots, hyphens) rather than
against what a URL parser will accept. An IPv6 literal is refused by the same
rule, because `host-source` has no way to write one — better a 422 at
configuration time than a directive that quietly never matches.

**The guard.** `security-headers.test.ts`, "refuses a host that is still a
placeholder" — which asserts the surprising half first, so the reason the check
exists cannot be lost:

```ts
expect(new URL("https://{room}.meet.example.test/").origin).toContain("{room}");
expect(frameOriginOf("https://{room}.meet.example.test/")).toBeNull();
```

Plus "refuses an address a CSP cannot name" for the IPv6 case, and
`calls.test.ts` for the 422 through the API.

## 2. A browser cannot tell you the frame was refused

**Not a defect — a constraint that shapes the feature.** A page holding a
cross-origin iframe cannot tell whether the frame loaded or was refused by the
provider's own `X-Frame-Options`. The `load` event fires either way and nothing
inside is readable.

Three consequences, all of them visible in the interface:

- **Embedding is asked for, never detected.** "Try it and fall back" does not
  exist, so an administrator who knows their provider has to say so, and the
  default is the behaviour already known to work.
- **There is always a way out of an empty panel.** 別の窓で開く sits under the
  frame permanently, not conditionally — the condition it would depend on is the
  one that cannot be evaluated.
- **The one refusal that _is_ reported gets handled.** A CSP refusal fires
  `securitypolicyviolation` on the document, unlike the provider's. That matters
  because the policy travels with the document: a page loaded before an
  administrator changed the setting is still enforcing the old `frame-src`, the
  server says yes, and this browser says no. The client listens, falls back to a
  link, and the form says the setting takes effect after a reload.

**The guard.** `callRoom.test.ts` covers the four-way decision — frame, window,
link, navigate — as a pure function, including both directions of the race
between what the client guessed and what the server answered. The interface half
is in `m5-calls.spec.ts` test 8: a frame with `camera` and `microphone` in its
`allow`, no window opened, and the way out on screen.

## 3. Two spellings of "the default provider"

**The near-miss.** `frame-src` has to name the origin of the provider a call is
actually held with. The routes chose that provider with
`ORDER BY is_default DESC, created_at`; the header refresh, written separately,
had `WHERE embeddable AND is_default`.

Those agree until an organisation has two providers. A default that is not
embeddable next to an embeddable one that is not the default, and the header
names an origin no call ever goes to — while the call itself lands somewhere the
CSP refuses. Both halves wrong, from two queries that each looked right.

**The fix.** One exported `DEFAULT_PROVIDER_ORDER`, used by both, and
`embeddable` read from the chosen row rather than filtered on in the WHERE
clause. Which provider is used, and whether it may be framed, are two questions
and only the first one has an ordering.

**The guard.** `calls.test.ts`, "names the provider calls actually use, not
another embeddable one".

## What did not have to change

Worth recording, because it was the whole reason this was affordable.

| Directive                | Moved?                                                              |
| ------------------------ | ------------------------------------------------------------------- |
| `frame-ancestors 'none'` | No. This is the 確認 clickjacking defence                           |
| `script-src 'self'`      | No. An iframe is not an SDK                                         |
| `frame-src`              | Yes — by exactly one origin                                         |
| `Permissions-Policy`     | Yes — camera and microphone, to that origin only, never to this one |

The `Permissions-Policy` half is not optional and is easy to forget: without it
the CSP allows the frame and the browser still denies it a microphone, which is a
meeting room that loads and cannot hear anybody, with nothing on screen
explaining why.
