/*
 * Atarimae service worker.
 *
 * Hand-written, and a classic worker rather than a module one: module service
 * workers are still not supported on Safari, and iOS is the platform a PWA is
 * most needed on. A build-time plugin would have brought Workbox with it for
 * about sixty lines of routing.
 *
 * WHAT THIS DOES NOT DO, ON PURPOSE
 *
 * It never caches an API response, and it never queues a write to send later.
 *
 * That is not laziness, it is the product's own rule. This application exists
 * to argue that a system must not report success while doing nothing, and an
 * offline-capable client is the easiest place in the world to break that:
 *
 *   - A cached announcement list shown as though current is a person reading
 *     yesterday's instructions believing they are today's.
 *   - A queued acknowledgement is worse. An acknowledgement records that this
 *     person saw this exact content at this exact time. Replaying one an hour
 *     later stamps the wrong time, and possibly against a revision that has
 *     since been superseded — a confirmation of something nobody confirmed.
 *
 * So: the shell is cached, so the app opens instead of showing a dinosaur, and
 * everything that carries meaning goes to the network or fails visibly.
 */

// Bump to evict everything from previous versions on activate.
const CACHE = "atarimae-shell-v1";

/**
 * Announcements read while online, kept so they can be read again offline.
 *
 * Separate from the shell cache because its lifetime is different: the shell
 * belongs to the build, this belongs to the *session*. It holds one person's
 * announcements, and the next person to use a shared PC in the office must not
 * be able to read them — so signing out empties it.
 */
const READS = "atarimae-reads-v1";

/** Stamped onto a cached copy so the interface can say how old it is. */
const FETCHED_AT = "x-atarimae-fetched-at";

/**
 * Fetched on install so a first-run offline visit still has something.
 * The hashed assets are not listed: their names change every build, and they
 * are picked up on first use by the immutable rule below.
 */
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg", "/icon-maskable.svg"];

/**
 * The hashed bundles, read out of the shell rather than from a build manifest.
 *
 * Without this the first offline visit gets the HTML and nothing else: the
 * page that installed the worker had already fetched its own scripts, without
 * the worker in the loop, so they were never cached and the application
 * renders as a blank page.
 *
 * A build plugin would inject the list. Parsing the one file that references
 * them costs eight lines and no dependency, and it cannot drift from the build
 * because it *is* the build's output.
 */
async function precacheAssets(cache) {
  const response = await fetch("/", { cache: "reload" });
  if (!response.ok) return;

  const html = await response.text();
  const urls = new Set(html.match(/\/assets\/[A-Za-z0-9._-]+/g) ?? []);

  await Promise.allSettled([...urls].map((url) => cache.add(url)));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Individually, not addAll: addAll rejects the whole install if any one
      // request fails, and a missing icon must not leave the app with no
      // worker at all.
      await Promise.allSettled(SHELL.map((url) => cache.add(url)));
      await precacheAssets(cache);
    })(),
  );
});

/*
 * Deliberately NOT skipWaiting() above.
 *
 * A new worker taking over a page that is already running swaps the rules
 * under it mid-session, and the tab ends up mixing two builds. Instead the new
 * worker waits, the application notices and offers "新しいバージョンがありま
 * す", and this message is what the button sends.
 */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    void self.skipWaiting();
  }

  /*
   * Sent on sign-out. Without it, the announcements one person read stay
   * readable offline by whoever uses that machine next — which in an office
   * with one shared PC is not a hypothetical.
   */
  if (event.data && event.data.type === "FORGET_READS") {
    event.waitUntil(caches.delete(READS));
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name !== CACHE && name !== READS)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

/**
 * `ignoreVary` on every lookup, and it is load-bearing.
 *
 * The server sends `Vary: Origin` on static files. A precached entry is stored
 * against the worker's own request, which carries no `Origin`; the page then
 * asks for the same bundle with `crossorigin` on the script tag, which does.
 * Vary matching sees two different requests and misses — so the application
 * loaded offline as a blank page, with everything correctly sitting in the
 * cache and none of it being found.
 *
 * Nothing here is keyed by anything but the URL, and for the hashed bundles
 * the URL *is* the version, so varying on a header cannot be meaningful.
 */
const MATCH = { ignoreVary: true };

/** Vite emits these with a content hash, so a given name never changes. */
function isImmutableAsset(url) {
  return url.pathname.startsWith("/assets/");
}

function isApi(url) {
  return url.pathname.startsWith("/api/");
}

/**
 * The one API path that may be read offline.
 *
 * Deliberately a whitelist of exactly two shapes — the list and one
 * announcement — and deliberately a regular expression rather than a
 * `startsWith`. Attachments live under `/api` too, and a prefix match that
 * grew to include them would write somebody's uploaded files into a cache that
 * outlives their session.
 *
 * `docs/architecture/pwa.md` set the condition for this exception: cached
 * content must carry the time it was fetched, on screen, every time. That is
 * what FETCHED_AT is for, and there is an E2E test that fails if the line is
 * missing.
 */
const OFFLINE_READABLE = [
  /*
   * The announcements themselves: the list, and one by id.
   */
  /^\/api\/v1\/my\/announcements(\/[0-9a-fA-F-]{36})?$/,

  /*
   * And the two the application cannot start without.
   *
   * Without these the root falls back to "サーバーに接続できません" before it
   * ever renders an announcement, and every byte cached above is unreachable —
   * which is precisely what the first attempt at this did. Caching the
   * roster but not the question "is anybody signed in" is caching nothing.
   *
   * Both are session-scoped and go when the session does. The honest limit:
   * offline, a session revoked by an administrator still looks valid here.
   * Nothing can be *done* with it — acknowledging offline fails, and has its
   * own test — but yesterday's roster stays readable until the network comes
   * back. That is the trade this whole exception is.
   */
  /^\/api\/v1\/auth\/me$/,
  /^\/api\/v1\/setup\/status$/,
];

function isOfflineReadable(url) {
  return OFFLINE_READABLE.some((pattern) => pattern.test(url.pathname));
}

/**
 * Network first, and remember the answer with the time it arrived.
 *
 * Never cache first. A roster that changed this morning must not be served
 * from yesterday because the cache was quicker — the cache is a fallback for
 * having no network, not a performance trick.
 */
async function readThrough(request) {
  try {
    const response = await fetch(request);

    if (response.ok) {
      /*
       * Stored with the timestamp baked into the headers rather than kept in
       * a side table. A cache entry and a separate record of when it was
       * written are two things that can disagree, and the one that would be
       * wrong is the one shown to somebody deciding whether to trust it.
       */
      const stamped = new Response(response.clone().body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      });
      stamped.headers.set(FETCHED_AT, new Date().toISOString());

      const cache = await caches.open(READS);
      await cache.put(request, stamped);
    }

    return response;
  } catch (error) {
    const cached = await caches.match(request, { ...MATCH, cacheName: READS });
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Only GET is ever eligible. A POST reaching a cache would be the queued
  // write this worker refuses to have.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  /*
   * The API is never touched. Not cached on the way out, not answered from
   * anywhere on the way back. Offline, these requests fail — and the interface
   * says so, which is the honest answer to "is this current?".
   *
   * Attachments live under /api too, so private files are never written to a
   * cache that outlives the session either.
   *
   * One exception, added after an explicit decision recorded in
   * `docs/architecture/reconsidering.md`: announcements may be read offline,
   * because a driver in a basement currently sees nothing at all and
   * yesterday's roster clearly stamped with when it was fetched is better than
   * that. Only reading — acknowledging offline still fails, and still has a
   * test saying so.
   */
  if (isApi(url)) {
    if (isOfflineReadable(url)) event.respondWith(readThrough(request));
    return;
  }

  /*
   * Navigation: network first, cache as a fallback.
   *
   * This order matters. index.html must never be served stale after a deploy —
   * cache-first here would strand a browser on the previous build until the
   * worker happened to update.
   */
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(CACHE);
          cache.put("/", response.clone());
          return response;
        } catch {
          const cached = await caches.match("/", MATCH);
          if (cached) return cached;
          throw new Error("offline and no cached shell");
        }
      })(),
    );
    return;
  }

  // Hashed assets: cache first. The name is the version, so a hit is never
  // stale by construction.
  if (isImmutableAsset(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request, MATCH);
        if (cached) return cached;

        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE);
          cache.put(request, response.clone());
        }
        return response;
      })(),
    );
    return;
  }

  // Everything else same-origin — the manifest, the icons. Network when it
  // can, cache when it cannot.
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE);
          cache.put(request, response.clone());
        }
        return response;
      } catch {
        const cached = await caches.match(request, MATCH);
        if (cached) return cached;
        throw new Error("offline and not cached");
      }
    })(),
  );
});

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

/**
 * A notification the server encrypted to this device.
 *
 * The payload carries only a title, a line of body text and a path — never the
 * announcement itself. A notification is shown by the operating system and can
 * sit on a lock screen in a break room, so it says that something needs
 * confirming and makes the person open the application to read it.
 *
 * `showNotification` is not optional. Every browser that delivers a push
 * requires one to be shown, and a handler that decides a message is not worth
 * displaying gets the subscription revoked for "silent push" — losing every
 * future notification, not just this one.
 */
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // A message we cannot read still has to become a notification.
  }

  const title = payload.title || "Atarimae";
  const body = payload.body || "確認が必要なお知らせがあります。";
  const path = typeof payload.path === "string" ? payload.path : "/my/announcements";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon.svg",
      badge: "/icon.svg",
      lang: "ja",
      // Replaces rather than stacks. Three reminders about the same roster on
      // a lock screen is how people learn to swipe them away unread.
      tag: path,
      renotify: true,
      data: { path },
    }),
  );
});

/**
 * Opening the announcement, reusing a window if one is already open.
 *
 * A second window pointed at the same server is the desktop client's problem
 * too, for the same reason: two copies disagree about what has been read.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const path = (event.notification.data && event.notification.data.path) || "/";
  const target = new URL(path, self.location.origin).href;

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      for (const client of clients) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if ("navigate" in client) await client.navigate(target);
          return;
        }
      }

      await self.clients.openWindow(target);
    })(),
  );
});
