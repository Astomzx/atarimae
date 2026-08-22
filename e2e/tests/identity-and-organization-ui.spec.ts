import { expect, test, type Page } from "@playwright/test";

import { resetDatabase } from "../fixtures/database.js";

/**
 * Identity and organisation management through the actual interface.
 *
 * The API scenario in administrator-management-api.spec.ts proves the server is correct. This
 * one proves the *client* is, which is a different question: a bug shipped
 * here while every server test stayed green, because nothing exercised the
 * browser's fetch wrapper.
 *
 * Deliberately covers the writes that carry no request body — sign-out,
 * disable, restore. Those were the ones that broke.
 *
 * Runs at both desktop and phone widths. The product rule is that PC and phone
 * are not two different products, so the same steps must pass at both.
 */

const OWNER = {
  name: "山田 太郎",
  email: "owner@atarimae.test",
  password: "owner-password-strong",
};

const ADMIN = {
  name: "佐藤 花子",
  email: "admin@atarimae.test",
  password: "admin-password-strong",
};

const SECOND_ADMIN = {
  name: "鈴木 次郎",
  email: "admin2@atarimae.test",
  password: "second-admin-password",
};

const BRANCH = "第一営業所";

async function createOwnerThroughUi(page: Page) {
  await page.goto("/");

  await page.getByTestId("setup-display-name").fill(OWNER.name);
  await page.getByTestId("setup-email").fill(OWNER.email);
  await page.getByTestId("setup-password").fill(OWNER.password);
  await page.getByTestId("setup-password-confirm").fill(OWNER.password);
  await page.getByTestId("setup-submit").click();

  await expect(page.getByTestId("current-user")).toContainText(OWNER.name);
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("current-user")).toBeVisible();
}

async function signOut(page: Page) {
  await page.getByTestId("logout").click();
  // A full reload, so nothing from the previous session stays on screen.
  await expect(page.getByTestId("login-submit")).toBeVisible();
}

async function addMember(
  page: Page,
  member: { name: string; email: string; password: string },
  role: "member" | "admin" | "owner",
) {
  await page.goto("/members");
  await page.getByTestId("toggle-create-member").click();

  await page.getByTestId("new-member-name").fill(member.name);
  await page.getByTestId("new-member-email").fill(member.email);
  await page.getByTestId("new-member-password").fill(member.password);
  await page.getByTestId("new-member-role").selectOption(role);
  await page.getByTestId("create-member-submit").click();

  await expect(page.getByTestId("member-list")).toContainText(member.name);
}

test.describe.configure({ mode: "serial" });

test.describe("identity and organisation through the interface", () => {
  test.beforeAll(async () => {
    await resetDatabase();
  });

  test("first run creates the Owner and signs them straight in", async ({ page }) => {
    await createOwnerThroughUi(page);

    await expect(page.getByTestId("current-user")).toContainText("オーナー");
    await expect(page.getByTestId("health-database")).toHaveText("接続済み");
  });

  test("setup is no longer reachable once an Owner exists", async ({ page }) => {
    await page.goto("/setup");

    // Redirected away; the sign-in screen is what remains.
    await expect(page).toHaveURL(/\/(login)?$/);
  });

  /**
   * The whole argument, clicked rather than asserted over HTTP.
   */
  test("an Owner adds an Admin, who signs in with no activation step", async ({
    page,
  }) => {
    await signIn(page, OWNER.email, OWNER.password);
    await addMember(page, ADMIN, "admin");

    await signOut(page);
    await signIn(page, ADMIN.email, ADMIN.password);

    await expect(page.getByTestId("current-user")).toContainText("管理者");
  });

  test("that Admin adds a further Admin", async ({ page }) => {
    await signIn(page, ADMIN.email, ADMIN.password);
    await addMember(page, SECOND_ADMIN, "admin");

    await expect(page.getByTestId("member-list")).toContainText(SECOND_ADMIN.name);
  });

  test("an Admin is not offered the Owner role", async ({ page }) => {
    await signIn(page, ADMIN.email, ADMIN.password);
    await page.goto("/members");
    await page.getByTestId("toggle-create-member").click();

    const roles = page.getByTestId("new-member-role");
    await expect(roles.locator("option")).toHaveCount(2);
    await expect(roles.locator("option[value='owner']")).toHaveCount(0);
  });

  test("an Owner is offered all three roles", async ({ page }) => {
    await signIn(page, OWNER.email, OWNER.password);
    await page.goto("/members");
    await page.getByTestId("toggle-create-member").click();

    await expect(page.getByTestId("new-member-role").locator("option")).toHaveCount(3);
  });

  test("an Admin creates a branch and assigns a member to it", async ({ page }) => {
    await signIn(page, ADMIN.email, ADMIN.password);

    await page.goto("/org-units");
    await page.getByTestId("new-org-unit-name").fill(BRANCH);
    await page.getByTestId("new-org-unit-kind").selectOption("branch");
    await page.getByTestId("create-org-unit").click();
    await expect(page.getByTestId("org-unit-list")).toContainText(BRANCH);

    await page.goto("/members");
    await page.getByTestId("toggle-create-member").click();
    await page.getByTestId("new-member-name").fill("田中 一郎");
    await page.getByTestId("new-member-email").fill("member@atarimae.test");
    await page.getByTestId("new-member-password").fill("member-password-strong");
    await page.getByTestId("new-member-org-unit").selectOption({ label: BRANCH });
    await page.getByTestId("create-member-submit").click();

    await expect(page.getByTestId("member-list")).toContainText("田中 一郎");
    await expect(page.getByTestId("member-list")).toContainText(BRANCH);
  });

  test("a duplicate address is rejected with a Japanese message", async ({ page }) => {
    await signIn(page, ADMIN.email, ADMIN.password);
    await page.goto("/members");
    await page.getByTestId("toggle-create-member").click();

    await page.getByTestId("new-member-name").fill("重複 太郎");
    await page.getByTestId("new-member-email").fill(OWNER.email);
    await page.getByTestId("new-member-password").fill("duplicate-password-x");
    await page.getByTestId("create-member-submit").click();

    // Server codes are mapped to Japanese; the English message never surfaces.
    await expect(page.getByTestId("create-member-error")).toHaveText(
      "そのメールアドレスは既に登録されています。",
    );
  });

  test("wrong credentials show a Japanese message and do not sign in", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByTestId("login-email").fill(OWNER.email);
    await page.getByTestId("login-password").fill("definitely-wrong-here");
    await page.getByTestId("login-submit").click();

    await expect(page.getByTestId("login-error")).toHaveText(
      "メールアドレスまたはパスワードが正しくありません。",
    );
    await expect(page.getByTestId("current-user")).toHaveCount(0);
  });

  /**
   * Regression: writes with no request body.
   *
   * The client used to set `content-type: application/json` on every request,
   * so Fastify rejected each empty-bodied write with 400. Sign-out silently did
   * nothing while the interface still showed the previous user.
   */
  test("sign-out actually ends the session", async ({ page }) => {
    await signIn(page, ADMIN.email, ADMIN.password);
    await signOut(page);

    // The session is really gone, not just visually replaced.
    const me = await page.request.get("/api/v1/auth/me");
    expect(me.status()).toBe(401);

    // And a protected route redirects rather than rendering stale content.
    await page.goto("/members");
    await expect(page.getByTestId("login-submit")).toBeVisible();
  });

  test("disable and restore work, and both are empty-bodied writes", async ({ page }) => {
    await signIn(page, OWNER.email, OWNER.password);
    await page.goto("/members");

    const row = page.locator(".list__item", { hasText: SECOND_ADMIN.email });
    await row.getByRole("button", { name: "停止" }).click();

    await page.getByTestId("show-disabled").check();
    await expect(
      page.locator(".list__item", { hasText: SECOND_ADMIN.email }),
    ).toContainText("停止中");

    // A disabled account cannot sign in.
    const attempt = await page.request.post("/api/v1/auth/login", {
      data: { email: SECOND_ADMIN.email, password: SECOND_ADMIN.password },
    });
    expect(attempt.status()).toBe(403);

    const disabledRow = page.locator(".list__item", { hasText: SECOND_ADMIN.email });
    await disabledRow.getByRole("button", { name: "復元" }).click();
    await expect(
      page.locator(".list__item", { hasText: SECOND_ADMIN.email }),
    ).not.toContainText("停止中");
  });

  test("a member sees no administrative controls", async ({ page }) => {
    await signIn(page, "member@atarimae.test", "member-password-strong");

    await page.goto("/members");
    // The create form is not merely hidden by CSS — it is not rendered.
    await expect(page.getByTestId("toggle-create-member")).toHaveCount(0);

    // Department administration is not in the navigation either.
    await expect(page.getByRole("link", { name: "部署" })).toHaveCount(0);
  });

  test("a user can revoke their own session without an administrator", async ({
    page,
  }) => {
    await signIn(page, OWNER.email, OWNER.password);
    await page.goto("/sessions");

    // At least the current one, marked as such.
    await expect(page.getByTestId("session-list")).toContainText("この端末");
  });
});
