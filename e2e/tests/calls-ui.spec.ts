import { expect, test, type Browser, type Page } from "@playwright/test";

import { resetDatabase } from "../fixtures/database.js";

/**
 * 通話 through the interface — calls over the network, as LINE and WeChat
 * do them.
 *
 *   Nothing is configured, so pressing 通話 says so instead of failing
 *   The Owner points Atarimae at a meeting service
 *   A call starts in a channel, and 田中 is told wherever he is in the app
 *   Leaving ends it, and the conversation keeps the record
 *
 * The one worth having a test for is the third: being told. A call somebody
 * only discovers by opening the right conversation is not a call.
 */

const OWNER = {
  name: "山田 太郎",
  email: "owner@atarimae.test",
  password: "owner-password-strong",
};

const TANAKA = { name: "田中 一郎", email: "tanaka@atarimae.test" };
const MEMBER_PASSWORD = "member-password-strong";

const CHANNEL = "全体連絡";
const MEET = "https://meet.example.test/{room}";

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("current-user")).toBeVisible();
}

async function openAs(browser: Browser, email: string, password: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email, password);
  return { context, page };
}

async function openChannel(page: Page) {
  await page.goto("/chat");
  await page.getByTestId(`channel-row-${CHANNEL}`).getByText(CHANNEL).click();
  await expect(page.getByTestId("channel-title")).toHaveText(CHANNEL);
}

test.describe.configure({ mode: "serial" });

test.describe("通話", () => {
  test.beforeAll(async () => {
    await resetDatabase();
  });

  test("1. the organisation, a member and a channel", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("setup-display-name").fill(OWNER.name);
    await page.getByTestId("setup-email").fill(OWNER.email);
    await page.getByTestId("setup-password").fill(OWNER.password);
    await page.getByTestId("setup-password-confirm").fill(OWNER.password);
    await page.getByTestId("setup-submit").click();
    await expect(page.getByTestId("current-user")).toContainText(OWNER.name);

    await page.goto("/members");
    await page.getByTestId("toggle-create-member").click();
    await page.getByTestId("new-member-name").fill(TANAKA.name);
    await page.getByTestId("new-member-email").fill(TANAKA.email);
    await page.getByTestId("new-member-password").fill(MEMBER_PASSWORD);
    await page.getByTestId("create-member-submit").click();
    await expect(page.getByTestId("member-list")).toContainText(TANAKA.name);

    await page.goto("/chat");
    await page.getByTestId("toggle-create-channel").click();
    await page.getByTestId("new-channel-name").fill(CHANNEL);
    await page.getByTestId("create-channel-submit").click();
    await expect(page.getByTestId("channel-title")).toHaveText(CHANNEL);
  });

  /**
   * Not a broken button and not a 500: there is nowhere to hold a call, and
   * the administrator is the one who can fix it.
   */
  test("2. with nothing configured, 通話 says why", async ({ page }) => {
    await signIn(page, OWNER.email, OWNER.password);
    await openChannel(page);

    await page.getByTestId("start-call").click();

    await expect(page.getByTestId("call-error")).toContainText(
      "通話サービスが設定されていません",
    );
  });

  test("3. the Owner points Atarimae at a meeting service", async ({ page }) => {
    await signIn(page, OWNER.email, OWNER.password);
    await page.goto("/service-accounts");

    await expect(page.getByTestId("no-call-providers")).toBeVisible();
    await page.getByTestId("toggle-create-call-provider").click();
    await page.getByTestId("new-call-provider-name").fill("社内 Jitsi");
    await page.getByTestId("new-call-provider-url").fill(MEET);
    await page.getByTestId("create-call-provider-submit").click();

    await expect(page.getByTestId("call-provider-list")).toContainText("社内 Jitsi");
  });

  /**
   * A template with no {room} puts every call in the organisation into one
   * room — two unrelated conversations hearing each other, while looking like
   * the product working.
   */
  test("4. a room URL with no {room} is refused", async ({ page }) => {
    await signIn(page, OWNER.email, OWNER.password);
    await page.goto("/service-accounts");

    await page.getByTestId("toggle-create-call-provider").click();
    await page.getByTestId("new-call-provider-name").fill("壊れた設定");
    await page.getByTestId("new-call-provider-url").fill("https://meet.example.test/");
    await page.getByTestId("create-call-provider-submit").click();

    await expect(page.getByTestId("create-call-provider-error")).toContainText("{room}");
  });

  /**
   * The half that matters. 田中 is looking at the announcements screen, not at
   * the conversation, and still finds out.
   */
  test("5. a call rings wherever the other person is", async ({ browser }) => {
    const owner = await openAs(browser, OWNER.email, OWNER.password);
    const tanaka = await openAs(browser, TANAKA.email, MEMBER_PASSWORD);

    try {
      // 田中 joins the channel, then goes somewhere else entirely.
      await tanaka.page.goto("/chat");
      await tanaka.page.getByTestId(`join-${CHANNEL}`).click();
      await tanaka.page.goto("/my/announcements");

      await openChannel(owner.page);

      // The room opens in its own window; the popup is not what is being
      // tested, so it is simply accepted and closed.
      const popup = owner.page.waitForEvent("popup").catch(() => null);
      await owner.page.getByTestId("start-call").click();
      await (await popup)?.close();

      await expect(tanaka.page.getByTestId("incoming-call")).toContainText(OWNER.name);

      // Answering puts him on the call and shows the conversation it is in.
      const answered = tanaka.page.waitForEvent("popup").catch(() => null);
      await tanaka.page.getByTestId("answer-call").click();
      await (await answered)?.close();

      await expect(tanaka.page.getByTestId("channel-title")).toHaveText(CHANNEL);
      await expect(tanaka.page.getByTestId("live-call")).toContainText("2 名");
      // On it, so he is offered the way out rather than the way in.
      await expect(tanaka.page.getByTestId("leave-call")).toBeVisible();
    } finally {
      await owner.context.close();
      await tanaka.context.close();
    }
  });

  /**
   * The last person out ends it. Without a way to leave, one closed laptop
   * would leave the conversation showing 通話中 forever — and since a channel
   * holds only one live call, it could never start another.
   */
  /**
   * The other shape. A call belongs to a channel, and a one-to-one
   * conversation is a channel — so this is the same mechanism, and the reason
   * it gets its own test is that "the same mechanism" is a claim.
   */
  test("6. a one-to-one call, between two people and nobody else", async ({
    browser,
  }) => {
    const owner = await openAs(browser, OWNER.email, OWNER.password);
    const tanaka = await openAs(browser, TANAKA.email, MEMBER_PASSWORD);

    try {
      await owner.page.goto("/chat");
      await owner.page.getByTestId("toggle-new-conversation").click();
      await owner.page.getByTestId(`start-conversation-${TANAKA.email}`).click();
      await expect(owner.page.getByTestId("channel-title")).toHaveText(TANAKA.name);

      const popup = owner.page.waitForEvent("popup").catch(() => null);
      await owner.page.getByTestId("start-call").click();
      await (await popup)?.close();

      // 田中 is told, wherever he is, and it is named after the caller.
      await expect(tanaka.page.getByTestId("incoming-call")).toContainText(OWNER.name);

      const answered = tanaka.page.waitForEvent("popup").catch(() => null);
      await tanaka.page.getByTestId("answer-call").click();
      await (await answered)?.close();

      await expect(tanaka.page.getByTestId("channel-title")).toHaveText(OWNER.name);
      await expect(tanaka.page.getByTestId("live-call")).toContainText("2 名");

      await tanaka.page.getByTestId("leave-call").click();
      await owner.page.getByTestId("leave-call").click();
      await expect(owner.page.getByTestId("start-call")).toBeVisible();
    } finally {
      await owner.context.close();
      await tanaka.context.close();
    }
  });

  test("7. leaving ends it, and the conversation keeps the record", async ({ page }) => {
    await signIn(page, OWNER.email, OWNER.password);
    await openChannel(page);

    // 田中 is still on it from the previous step, so the Owner leaving is not
    // the end of it.
    await expect(page.getByTestId("live-call")).toBeVisible();
    await page.getByTestId("leave-call").click();
    await expect(page.getByTestId("live-call")).toContainText("1 名");

    // The last one out ends it.
    const tanakaSession = await page.context().browser()!.newContext();
    try {
      const tanakaPage = await tanakaSession.newPage();
      await signIn(tanakaPage, TANAKA.email, MEMBER_PASSWORD);
      await openChannel(tanakaPage);
      await tanakaPage.getByTestId("leave-call").click();
      await expect(tanakaPage.getByTestId("start-call")).toBeVisible();
    } finally {
      await tanakaSession.close();
    }

    await page.reload();
    await expect(page.getByTestId("live-call")).toHaveCount(0);
    await expect(page.getByTestId("start-call")).toBeVisible();

    // Kept in the conversation: it happened, who was on it, and how long.
    await expect(page.getByTestId("call-history")).toContainText("2 名が参加");
  });

  /**
   * The room inside Atarimae, when an administrator says the provider permits
   * it. Last on purpose: it changes where every call after it goes.
   *
   * What this test can show is the interface — no window, a frame with the room
   * in it, the two permissions it asks for, and a way out for the case a
   * browser cannot report. What it cannot show is the policy: here the document
   * comes from Vite, which sends no CSP, where in production it is served by
   * the API and carries `frame-src`. That half is in the server tests.
   */
  test("8. an embeddable provider puts the room in the conversation", async ({
    page,
  }) => {
    await signIn(page, OWNER.email, OWNER.password);
    await page.goto("/service-accounts");

    await page.getByTestId("toggle-create-call-provider").click();
    await page.getByTestId("new-call-provider-name").fill("埋め込み Jitsi");
    await page.getByTestId("new-call-provider-url").fill(MEET);
    await page.getByTestId("new-call-provider-embeddable").check();
    await page.getByTestId("create-call-provider-submit").click();

    await expect(page.getByTestId("call-provider-list")).toContainText("アプリ内に表示");

    /*
     * A full load rather than clicking through: the policy travels with the
     * document, so this is the step an operator has to take as well, and the
     * interface says so on the form.
     */
    await openChannel(page);

    // Nothing may open a window this time. If one does, the frame is not what
    // the person got.
    let windows = 0;
    page.on("popup", () => {
      windows += 1;
    });

    await page.getByTestId("start-call").click();

    const frame = page.getByTestId("call-frame");
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute(
      "src",
      /^https:\/\/meet\.example\.test\/atarimae-/,
    );
    // The header delegates camera and microphone to the provider; this is the
    // frame asking for what was delegated. One without the other is a meeting
    // room that cannot hear anybody.
    await expect(frame).toHaveAttribute("allow", /camera/);
    await expect(frame).toHaveAttribute("allow", /microphone/);
    expect(windows).toBe(0);

    // A browser cannot tell whether the provider refused to be framed, so
    // there is always a way out of an empty panel.
    await expect(page.getByTestId("open-call-window")).toBeVisible();

    await page.getByTestId("leave-call").click();
    await expect(page.getByTestId("call-frame")).toHaveCount(0);
  });
});
