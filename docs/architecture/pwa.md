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

So the service worker caches the **shell** and nothing else. Everything
carrying meaning goes to the network or does not happen.

| Request                      | What the worker does                      |
| ---------------------------- | ----------------------------------------- |
| Navigation                   | Network first, cached shell as a fallback |
| `/assets/*` (content-hashed) | Cache first — the name is the version     |
| `/api/*`                     | **Never touched.** Not cached, not served |
| Manifest, icons              | Network, cache as a fallback              |
| Anything not GET             | **Never touched**                         |

`/api` covers attachments, so no private file is written to a cache that
outlives the session. That is asserted directly: a test walks every cache and
fails if any entry's path starts with `/api/`.

## What actually happens offline

The application opens — the shell and the hashed bundles are cached — and a
banner says it is offline and that nothing can be sent. The announcement list
is **empty rather than stale**, because there is nothing to serve it from.

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
- **No push notifications.** The tables exist from M2 and nothing is wired up.
- **No offline reading of announcements.** It is the feature people ask for
  first and the one that would break the rule at the top of this file. If it is
  ever added, the content has to carry the time it was fetched, on screen,
  every time.

## Testing it

The worker only registers in a production build — one that pins the shell
fights hot reload — so the PWA spec runs against `vite preview` under its own
Playwright project, with `context.setOffline` for the offline half.
