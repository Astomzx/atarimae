import { expect, test, type Page } from "@playwright/test";

import { resetDatabase } from "../fixtures/database.js";

/**
 * M5 through the interface: something other than a person uses the API.
 *
 *   Owner creates a service account for the dispatch system
 *     -> issues a token, sees it once
 *   The token posts an announcement, as the dispatch system
 *   The token cannot issue itself another token
 *   Revoking it stops the next request
 *
 * The point of a service account is the last two. A token that can mint
 * tokens cannot be revoked; a token belonging to a person dies when they
 * leave.
 */

const OWNER = {
  name: "山田 太郎",
  email: "owner@atarimae.test",
  password: "owner-password-strong",
};

const ACCOUNT = "配車システム";

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("current-user")).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test.describe("M5: an integration of its own", () => {
  /** Captured from the one screen that will ever show it. */
  let token = "";

  test.beforeAll(async () => {
    await resetDatabase();
  });

  test("1. the organisation is set up", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("setup-display-name").fill(OWNER.name);
    await page.getByTestId("setup-email").fill(OWNER.email);
    await page.getByTestId("setup-password").fill(OWNER.password);
    await page.getByTestId("setup-password-confirm").fill(OWNER.password);
    await page.getByTestId("setup-submit").click();
    await expect(page.getByTestId("current-user")).toContainText(OWNER.name);
  });

  test("2. the Owner creates a service account for the dispatch system", async ({
    page,
  }) => {
    await signIn(page, OWNER.email, OWNER.password);

    await page.goto("/service-accounts");
    await expect(page.getByTestId("no-service-accounts")).toBeVisible();

    await page.getByTestId("toggle-create-service-account").click();
    await page.getByTestId("new-service-account-name").fill(ACCOUNT);
    await page.getByTestId("new-service-account-role").selectOption("admin");
    await page
      .getByTestId("new-service-account-description")
      .fill("毎朝の配車表を取り込みます");
    await page.getByTestId("create-service-account-submit").click();

    await expect(page.getByTestId("service-account-list")).toContainText(ACCOUNT);
    await expect(page.getByTestId("service-account-list")).toContainText(
      "有効なトークン 0 件",
    );
  });

  /**
   * The token is on screen once. There is no "show it again" because the
   * server keeps a hash and genuinely cannot answer that question.
   */
  test("3. a token is issued, and shown exactly once", async ({ page }) => {
    await signIn(page, OWNER.email, OWNER.password);
    await page.goto("/service-accounts");

    await page.getByTestId(`tokens-${ACCOUNT}`).click();
    await page.getByTestId("new-token-name").fill("夜間取り込み");
    await page.getByTestId("issue-token").click();

    const value = page.getByTestId("issued-token-value");
    await expect(value).toBeVisible();
    token = (await value.textContent()) ?? "";
    expect(token.startsWith("atk_")).toBe(true);

    await expect(page.getByTestId("issued-token")).toContainText(
      "この画面を閉じると二度と表示できません",
    );

    await page.getByTestId("dismiss-issued-token").click();
    await expect(page.getByTestId("issued-token")).toHaveCount(0);

    // Reloading does not bring it back — the list holds a prefix, not a token.
    await page.reload();
    await page.getByTestId(`tokens-${ACCOUNT}`).click();
    await expect(page.getByTestId("token-list")).toContainText("夜間取り込み");
    await expect(page.locator("body")).not.toContainText(token);
  });

  test("4. the token acts as the dispatch system, not as a person", async ({
    request,
  }) => {
    const me = await request.get("/api/v1/auth/me", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(me.status()).toBe(200);
    expect(await me.json()).toMatchObject({ displayName: ACCOUNT, role: "admin" });

    const created = await request.post("/api/v1/announcements", {
      headers: { authorization: `Bearer ${token}` },
      data: { title: "明日の配車", body: "8時30分出発です。" },
    });

    expect(created.status()).toBe(201);
  });

  /**
   * The containment rule. Without it, ending a leak by revoking the token
   * leaves behind whatever that token created in the meantime.
   */
  test("5. the token cannot issue itself another token", async ({ request }) => {
    const accounts = await request.get("/api/v1/service-accounts", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(accounts.status()).toBe(403);
    expect((await accounts.json()).code).toBe("TOKEN_AUTH_NOT_ALLOWED");
  });

  test("6. the service account is not a colleague", async ({ page }) => {
    await signIn(page, OWNER.email, OWNER.password);

    // Not in the member directory, and not somebody you can start a chat with.
    await page.goto("/members");
    await expect(page.getByTestId("member-list")).not.toContainText(ACCOUNT);

    await page.goto("/chat");
    await page.getByTestId("toggle-new-conversation").click();
    await expect(page.locator("body")).not.toContainText(ACCOUNT);
  });

  /**
   * The other direction. The interesting part is the refusal: a webhook the
   * server fetches on its own network is a request forger, so an address
   * inside the network is rejected before anything is stored.
   */
  test("7. a webhook is registered, and its secret shown once", async ({ page }) => {
    await signIn(page, OWNER.email, OWNER.password);
    await page.goto("/service-accounts");

    await expect(page.getByTestId("no-webhooks")).toBeVisible();
    await page.getByTestId("toggle-create-webhook").click();

    await page.getByTestId("new-webhook-url").fill("https://hooks.example.test/atarimae");
    await page.getByTestId("webhook-event-announcement.acknowledged").click();
    await page.getByTestId("create-webhook-submit").click();

    const secret = page.getByTestId("issued-secret-value");
    await expect(secret).toBeVisible();
    expect(((await secret.textContent()) ?? "").startsWith("whsec_")).toBe(true);

    await page.getByTestId("dismiss-issued-secret").click();
    await expect(page.getByTestId("webhook-list")).toContainText(
      "hooks.example.test/atarimae",
    );
  });

  test("8. a webhook pointing inside the network is refused", async ({ page }) => {
    await signIn(page, OWNER.email, OWNER.password);
    await page.goto("/service-accounts");

    await page.getByTestId("toggle-create-webhook").click();
    await page
      .getByTestId("new-webhook-url")
      .fill("http://169.254.169.254/latest/meta-data/");
    await page.getByTestId("create-webhook-submit").click();

    await expect(page.getByTestId("create-webhook-error")).toContainText("社内アドレス");
  });

  /**
   * The queue is written in the same transaction as the publish, so the
   * delivery exists whether or not anything is listening yet.
   */
  test("9. publishing queues a delivery, and the log says so", async ({ page }) => {
    await signIn(page, OWNER.email, OWNER.password);

    await page.goto("/announcements");
    await page.getByTestId("toggle-create-announcement").click();
    await page.getByTestId("new-announcement-title").fill("配車連絡");
    await page.getByTestId("new-announcement-body").fill("本日の配車です。");
    await page.getByTestId("create-announcement-submit").click();
    await page.getByRole("link", { name: "配車連絡" }).click();
    await page.getByTestId("target-all").click();
    await page.getByTestId("publish").click();
    await expect(page.getByTestId("notice")).toContainText("公開しました");

    await page.goto("/service-accounts");
    await page.getByTestId("webhook-deliveries").click();

    // Queued, and visible without anybody reading a server log.
    await expect(page.getByTestId("delivery-list")).toContainText("公告の公開");
  });

  test("10. revoking stops the very next request", async ({ page, request }) => {
    await signIn(page, OWNER.email, OWNER.password);
    await page.goto("/service-accounts");
    await page.getByTestId(`tokens-${ACCOUNT}`).click();

    await page.getByTestId("revoke-token-夜間取り込み").click();
    await expect(page.getByTestId("token-list")).toContainText("失効済み");

    const after = await request.get("/api/v1/auth/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.status()).toBe(401);
  });
});
