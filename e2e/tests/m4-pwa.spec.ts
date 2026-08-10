import { expect, test, type Page } from "@playwright/test";

import { query, resetDatabase } from "../fixtures/database.js";

/**
 * M4, the PWA half — against the production build, which is the only mode
 * where the service worker registers.
 *
 * The installable part is easy and mostly a manifest. The part worth testing
 * is what the application does when the network is gone, because an
 * offline-capable client is the easiest place in this whole product to break
 * its own rule:
 *
 *   - a cached list shown as current is yesterday's instructions read as
 *     today's
 *   - a queued acknowledgement is a confirmation of something nobody confirmed
 *
 * So the claims here are that the shell opens offline, and that nothing else
 * pretends to work.
 */

const OWNER = {
  name: "山田 太郎",
  email: "owner@atarimae.test",
  password: "owner-password-strong",
};

const TITLE = "明日の予定";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(OWNER.email);
  await page.getByTestId("login-password").fill(OWNER.password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("current-user")).toBeVisible();
}

/** The worker installs asynchronously; nothing offline works until it has. */
async function waitForServiceWorker(page: Page) {
  await page.waitForFunction(
    () => navigator.serviceWorker.controller !== null,
    undefined,
    { timeout: 20_000 },
  );
}

test.describe.configure({ mode: "serial" });

test.describe("M4: installable, and honest offline", () => {
  test.beforeAll(async () => {
    await resetDatabase();
  });

  test("1. the manifest describes something installable", async ({ page, request }) => {
    const response = await request.get("/manifest.webmanifest");
    expect(response.status()).toBe(200);

    const manifest = await response.json();
    expect(manifest).toMatchObject({
      name: "Atarimae",
      lang: "ja",
      start_url: "/",
      display: "standalone",
    });

    // Installability needs an icon, and Android crops one to the launcher's
    // shape unless a maskable variant says how.
    const purposes = manifest.icons.map((icon: { purpose: string }) => icon.purpose);
    expect(purposes).toContain("any");
    expect(purposes).toContain("maskable");

    for (const icon of manifest.icons) {
      expect((await request.get(icon.src)).status(), icon.src).toBe(200);
    }

    // The page has to point at it, or none of the above is ever read.
    await page.goto("/login");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      "href",
      "/manifest.webmanifest",
    );
  });

  test("2. the organisation is set up and an announcement is waiting", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("setup-display-name").fill(OWNER.name);
    await page.getByTestId("setup-email").fill(OWNER.email);
    await page.getByTestId("setup-password").fill(OWNER.password);
    await page.getByTestId("setup-password-confirm").fill(OWNER.password);
    await page.getByTestId("setup-submit").click();
    await expect(page.getByTestId("current-user")).toContainText(OWNER.name);

    await page.goto("/announcements");
    await page.getByTestId("toggle-create-announcement").click();
    await page.getByTestId("new-announcement-title").fill(TITLE);
    await page.getByTestId("new-announcement-body").fill("朝礼は8時30分から。");
    await page.getByTestId("create-announcement-submit").click();

    // The create form asks for acknowledgement by default, which is what makes
    // step 6 possible.
    await page.getByRole("link", { name: TITLE }).click();
    await page.getByTestId("target-all").click();
    await page.getByTestId("publish").click();
    await expect(page.getByTestId("notice")).toContainText("公開しました");
  });

  test("3. the service worker takes over", async ({ page }) => {
    await signIn(page);
    await waitForServiceWorker(page);

    const scope = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return registration?.scope ?? null;
    });

    expect(scope).toContain("/");
  });

  /**
   * The point of the shell cache: the application opens, rather than the
   * browser's own error page.
   */
  test("4. the app still opens with the network gone", async ({ page, context }) => {
    await signIn(page);
    await waitForServiceWorker(page);

    await context.setOffline(true);
    try {
      await page.reload();
      // Rendered by our own JavaScript, from cache — not a browser error page.
      await expect(page.getByTestId("offline-bar")).toBeVisible();
      await expect(page.locator("#root")).not.toBeEmpty();
    } finally {
      await context.setOffline(false);
    }
  });

  test("5. and says so, rather than showing stale content as current", async ({
    page,
    context,
  }) => {
    await signIn(page);
    await waitForServiceWorker(page);

    // Seen while online, so it is definitely in the browser's memory.
    await page.goto("/my/announcements");
    await expect(page.getByTestId("announcement-title")).toHaveText(TITLE);

    await context.setOffline(true);
    try {
      await page.reload();

      await expect(page.getByTestId("offline-bar")).toContainText("オフライン");
      await expect(page.getByTestId("offline-bar")).toContainText("最新ではない可能性");

      /*
       * The announcement must NOT come back from a cache. The service worker
       * never stores an API response, so this list is empty or errored — it
       * does not quietly show yesterday's plan as though it were today's.
       */
      await expect(page.getByTestId("announcement-title")).toHaveCount(0);
    } finally {
      await context.setOffline(false);
    }
  });

  /**
   * The one that ties this to the rest of the product.
   *
   * An acknowledgement records that this person saw this exact content at this
   * exact time. Queuing one to send later would stamp the wrong time, possibly
   * against a revision since superseded — a confirmation of something nobody
   * confirmed. So offline it fails, visibly, and stays unacknowledged.
   */
  test("6. an acknowledgement offline fails instead of pretending", async ({
    page,
    context,
  }) => {
    await signIn(page);
    await waitForServiceWorker(page);

    await page.goto("/my/announcements");
    await expect(page.getByTestId("acknowledge")).toBeVisible();

    await context.setOffline(true);
    try {
      await page.getByTestId("acknowledge").click();

      // Still offered, so the interface has not claimed anything happened.
      await expect(page.getByTestId("acknowledge")).toBeVisible();

      // Nothing on screen says it was confirmed.
      await expect(page.getByTestId("acknowledged-at")).toHaveCount(0);

      /*
       * The claim that actually matters, checked where it cannot be faked.
       * An acknowledgement is a record that a named person confirmed a named
       * revision at a named time — if none was written, none is owed.
       */
      const rows = await query("SELECT id FROM announcement_acknowledgements");
      expect(rows, "nothing may be recorded while offline").toHaveLength(0);
    } finally {
      await context.setOffline(false);
    }

    /*
     * Back online it goes through, so nothing was permanently broken.
     *
     * The request made while offline may have failed outright or may still
     * have been pending — Chromium's offline emulation stalls some requests
     * rather than rejecting them, and a real dropped connection does both
     * depending on when it dropped. Either way the button is pressed again if
     * it is still there, and either way exactly one acknowledgement exists at
     * the end. What must never happen is a second one.
     */
    await page.reload();
    const button = page.getByTestId("acknowledge");
    if ((await button.count()) > 0) await button.click();

    await expect(page.getByTestId("acknowledged-at")).toContainText("確認済み");
    expect(await query("SELECT id FROM announcement_acknowledgements")).toHaveLength(1);
  });

  /**
   * Attachments and message bodies live under /api, so nothing private is
   * written to a cache that outlives the session.
   */
  test("7. nothing from the API is in the cache", async ({ page }) => {
    await signIn(page);
    await waitForServiceWorker(page);
    await page.goto("/my/announcements");
    await expect(page.getByTestId("announcement-card")).toBeVisible();

    const cachedApi = await page.evaluate(async () => {
      const names = await caches.keys();
      const urls: string[] = [];
      for (const name of names) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) urls.push(request.url);
      }
      return urls.filter((url) => new URL(url).pathname.startsWith("/api/"));
    });

    expect(cachedApi).toEqual([]);
  });
});
