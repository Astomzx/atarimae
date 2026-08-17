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
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== CACHE).map((name) => caches.delete(name)),
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
   */
  if (isApi(url)) return;

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
