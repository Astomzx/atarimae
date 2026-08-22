# The PWA

Installable, and offline-capable in a deliberately narrow way.

## The rule this had to not break

An offline-capable client is the easiest place in this whole product to
contradict its own thesis. Two obvious features would do it:

- **Caching API responses.** A list served from a cache and shown as though
  current is a driver reading yesterday's instructions believing they are
  today's.
- **Queuing writes to send later.** Worse. An acknowledgement records that a
  named person confirmed a named revision at a named time. Replaying one an
  hour later stamps the wrong time, possibly against a revision that has since
  been superseded — a confirmation of something nobody confirmed.

So the service worker caches the **shell**, plus one deliberate exception added
during the security and offline review and named below. Everything else carrying meaning goes to the network or
does not happen.

| Request                            | What the worker does                                    |
| ---------------------------------- | ------------------------------------------------------- |
| Navigation                         | Network first, cached shell as a fallback               |
| `/assets/*` (content-hashed)       | Cache first — the name is the version                   |
| `/api/v1/my/announcements[/id]`    | Network first, cached answer as a fallback, **stamped** |
| `/api/v1/auth/me`, `/setup/status` | The same, because without them nothing renders at all   |
| Any other `/api/*`                 | **Never touched.** Not cached, not served               |
| Manifest, icons                    | Network, cache as a fallback                            |
| Anything not GET                   | **Never touched**                                       |

Network **first**, never cache first: a roster that changed this morning must
not be served from yesterday because the cache was quicker. The cache is a
fallback for having no network, not a performance trick.

The exception is a list of exact patterns rather than a prefix. Attachments live
under `/api` too, and a prefix match that let one through would write somebody's
private file into a cache that outlives their session — on a shared PC in an
office. That is asserted directly: a test walks every cache and fails on any
entry outside the permitted set.

The session-scoped honest limit that comes with it: offline, a session an
administrator revoked still looks valid here. Nothing can be _done_ with it —
acknowledging offline fails and has its own test — but yesterday's roster stays
readable until the network returns. That is the trade this exception is.

## What actually happens offline

The application opens — the shell and the hashed bundles are cached — and a
banner says it is offline and that nothing can be sent.

The announcement list is the **one** thing served from a cache, and only on the
terms set out above: every entry carries, on screen and unmissably, the time it
was fetched. A driver in a basement saw nothing at all before;
yesterday's roster stamped 取得 昨日 18:32 beats nothing, and the stamp is the
whole of the argument, so an E2E test fails without it. Nothing else is cached,
and acknowledging offline still does not happen.

Pressing 確認しました offline does not record anything. The end-to-end test
checks that against the database rather than the screen, because the screen is
the thing that could be lying.

**A nuance found by testing rather than reasoning**: a request made as the
connection drops is not always rejected. Chromium's offline emulation — and a
real connection lost mid-flight — can leave it pending, and it completes when
the network returns. That is fine and stays honest: the interface shows it as
in flight and never as done, and the acknowledgement is stamped when the server
actually receives it, which is a moment at which the person genuinely had seen
the content and pressed the button. What does not exist is a queue that
survives the tab closing and replays later.

## Offline is decided by requests, not by `navigator.onLine`

`navigator.onLine` means "there is a network interface", not "the server
answers". A laptop on café wifi that wants a login page reports online. So does
Chromium under an emulated offline profile — which is how this was found, with
the banner refusing to appear in a test that had cut the network.

The banner is therefore driven by the API client: a `fetch` that rejects marks
the server unreachable, any response at all marks it reachable. The claim on
screen is "this cannot be sent right now", so the evidence for it is a request
that could not be sent. The `online`/`offline` events are still listened to as
a fast first signal.

## Updates are a button, not folklore

The worker does **not** `skipWaiting()` on install. A new worker taking over a
running page swaps the rules underneath it and the tab ends up mixing two
builds. Instead it waits, the application notices and offers 新しいバージョン
があります, and the button posts `SKIP_WAITING` and reloads once the new worker
has actually taken control.

Navigation is network-first for the same reason: `index.html` must never be
served stale after a deploy.

## Two things that cost an afternoon

Both were invisible until the thing was actually run offline.

**The bundles were cached and could not be found.** The server sends
`Vary: Origin` on static files. The worker precaches with its own request,
which carries no `Origin`; the page then asks for the same bundle with
`crossorigin` on the script tag, which does. Cache matching honoured `Vary`,
saw two different requests, and missed — so the app loaded offline as a blank
page with everything correctly sitting in the cache. Every lookup now passes
`ignoreVary`, which is safe because nothing here is keyed by anything but the
URL, and for a hashed bundle the URL _is_ the version.

**The offline banner lived in the wrong place.** It was inside `Layout`. Offline,
the setup check fails and the whole application falls back to "cannot reach the
server" — which never renders `Layout`, so the one message explaining _why_
never appeared. It sits above the router now.

## Deliberately not done

- **No build plugin.** The precache list is parsed out of the built
  `index.html` by the worker at install. It cannot drift from the build because
  it is the build's output, and it costs no dependency.
- **A classic worker, not a module one.** Module service workers are still
  unsupported on Safari, and iOS is where a PWA matters most.
- ~~No push notifications.~~ **Wired up.** The previously unused tables are now
  reached: VAPID keys in `system_settings`, aes128gcm encryption in
  `apps/server/src/lib/web-push.ts`, and `push` and `notificationclick`
  handlers in the worker. The payload carries a title, a line of body text and
  a path — never the announcement, because a notification sits on a lock screen
  in a break room. Permission is asked for only when somebody presses the
  button on the device page.
- ~~No offline reading of announcements.~~ **Reversed after review**, deliberately
  and with the condition this file set attached — see
  `docs/architecture/reconsidering.md`. A driver in a basement saw nothing at
  all; yesterday's roster, clearly stamped with when it was fetched, beats
  that. The stamp is the whole of the argument, so it is unmissable and an E2E
  test fails without it. Reading only: acknowledging offline still fails, and
  still has its own test.

## Testing it

The worker only registers in a production build — one that pins the shell
fights hot reload — so the PWA spec runs against `vite preview` under its own
Playwright project, with `context.setOffline` for the offline half.
