import { expect, test, type Page } from "@playwright/test";

import { resetDatabase } from "../fixtures/database.js";

/**
 * Announcements through the interface — the demo script, executable.
 *
 *   Owner creates 第一営業所 and two members
 *     -> writes tomorrow's shared plan
 *     -> adds a paragraph for 田中 only
 *     -> targets the branch, publishes
 *   田中 signs in, sees the shared plan AND his own paragraph, acknowledges
 *   佐藤 signs in, sees the shared plan and NOT 田中's paragraph
 *   Owner sees 1/2 with 田中's name and the time he confirmed
 *
 * The paragraph-per-person half is the part no ordinary announcement board
 * does, and the part this project was started for.
 */

const OWNER = {
  name: "山田 太郎",
  email: "owner@atarimae.test",
  password: "owner-password-strong",
};

const TANAKA = { name: "田中 一郎", email: "tanaka@atarimae.test" };
const SATO = { name: "佐藤 花子", email: "sato@atarimae.test" };
const MEMBER_PASSWORD = "member-password-strong";

const BRANCH = "第一営業所";
const TITLE = "明日の予定";
const SHARED_BODY = "朝礼は8時30分から。全員参加してください。";
const TANAKA_TASK = "8:30 第一営業所集合、その後A区域を担当";

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("current-user")).toBeVisible();
}

async function signOut(page: Page) {
  await page.getByTestId("logout").click();
  await expect(page.getByTestId("login-submit")).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test.describe("tomorrow's plan, per person", () => {
  test.beforeAll(async () => {
    await resetDatabase();
  });

  test("1. the organisation is set up with a branch and two members", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("setup-display-name").fill(OWNER.name);
    await page.getByTestId("setup-email").fill(OWNER.email);
    await page.getByTestId("setup-password").fill(OWNER.password);
    await page.getByTestId("setup-password-confirm").fill(OWNER.password);
    await page.getByTestId("setup-submit").click();
    await expect(page.getByTestId("current-user")).toContainText(OWNER.name);

    await page.goto("/org-units");
    await page.getByTestId("new-org-unit-name").fill(BRANCH);
    await page.getByTestId("new-org-unit-kind").selectOption("branch");
    await page.getByTestId("create-org-unit").click();
    await expect(page.getByTestId("org-unit-list")).toContainText(BRANCH);

    for (const member of [TANAKA, SATO]) {
      await page.goto("/members");
      await page.getByTestId("toggle-create-member").click();
      await page.getByTestId("new-member-name").fill(member.name);
      await page.getByTestId("new-member-email").fill(member.email);
      await page.getByTestId("new-member-password").fill(MEMBER_PASSWORD);
      await page.getByTestId("new-member-org-unit").selectOption({ label: BRANCH });
      await page.getByTestId("create-member-submit").click();
      await expect(page.getByTestId("member-list")).toContainText(member.name);
    }
  });

  test("2. the Owner writes tomorrow's shared plan as a draft", async ({ page }) => {
    await signIn(page, OWNER.email, OWNER.password);

    await page.goto("/announcements");
    await page.getByTestId("toggle-create-announcement").click();
    await page.getByTestId("new-announcement-title").fill(TITLE);
    await page.getByTestId("new-announcement-body").fill(SHARED_BODY);
    await page.getByTestId("create-announcement-submit").click();

    await expect(page.getByTestId("announcement-list")).toContainText(TITLE);
    // Nothing is visible to anybody until it is published.
    await expect(page.getByTestId("announcement-list")).toContainText("下書き");
  });

  test("3. a paragraph is added for 田中 only, before publishing", async ({ page }) => {
    await signIn(page, OWNER.email, OWNER.password);
    await page.goto("/announcements");
    await page.getByRole("link", { name: TITLE }).click();

    await expect(page.getByTestId("detail-status")).toHaveText("下書き");

    await page.getByTestId(`personal-input-${TANAKA.email}`).fill(TANAKA_TASK);
    await page.getByTestId(`personal-save-${TANAKA.email}`).click();
    await expect(page.getByTestId("notice")).toContainText(
      "個人ごとの内容を保存しました",
    );
  });

  test("4. the branch is selected and the reach is shown before publishing", async ({
    page,
  }) => {
    await signIn(page, OWNER.email, OWNER.password);
    await page.goto("/announcements");
    await page.getByRole("link", { name: TITLE }).click();

    await page.getByTestId(`target-unit-${BRANCH}`).click();

    // The editor states how many people this reaches, so "this would go to
    // nobody" is visible in advance rather than discovered afterwards.
    await expect(page.getByTestId("notice")).toContainText("2 名が対象");
    await expect(page.getByTestId("resolved-count")).toContainText("2 名");
  });

  test("5. publishing reports exactly what it did", async ({ page }) => {
    await signIn(page, OWNER.email, OWNER.password);
    await page.goto("/announcements");
    await page.getByRole("link", { name: TITLE }).click();

    await page.getByTestId("publish").click();

    // Not a bare "success": the count of people reached, obligations created
    // and notifications queued.
    await expect(page.getByTestId("notice")).toContainText("2名に公開しました");
    await expect(page.getByTestId("notice")).toContainText("確認依頼 2件");
    await expect(page.getByTestId("detail-status")).toHaveText("公開中");
  });

  /**
   * The half that matters: a shared plan, plus the line that belongs to this
   * person and to nobody else.
   */
  test("6. 田中 sees the shared plan and his own paragraph", async ({ page }) => {
    await signIn(page, TANAKA.email, MEMBER_PASSWORD);

    // The home screen leads with what is waiting on him.
    await expect(page.getByTestId("pending-count")).toContainText("1");

    await page.goto("/my/announcements");
    await expect(page.getByTestId("announcement-title")).toHaveText(TITLE);
    await expect(page.getByTestId("announcement-card")).toContainText(SHARED_BODY);
    await expect(page.getByTestId("personal-body")).toContainText(TANAKA_TASK);
  });

  test("7. 佐藤 sees the shared plan and not 田中's paragraph", async ({ page }) => {
    await signIn(page, SATO.email, MEMBER_PASSWORD);
    await page.goto("/my/announcements");

    await expect(page.getByTestId("announcement-card")).toContainText(SHARED_BODY);
    await expect(page.getByTestId("personal-body")).toHaveCount(0);
    await expect(page.getByTestId("announcement-card")).not.toContainText(TANAKA_TASK);
  });

  test("8. 田中 acknowledges", async ({ page }) => {
    await signIn(page, TANAKA.email, MEMBER_PASSWORD);
    await page.goto("/my/announcements");

    await page.getByTestId("acknowledge").click();
    await expect(page.getByTestId("acknowledged-at")).toContainText("確認済み");

    // Nothing outstanding remains on his home screen.
    await page.goto("/");
    await expect(page.getByTestId("no-pending")).toBeVisible();
  });

  test("9. the Owner sees 1/2 with the name and the time", async ({ page }) => {
    await signIn(page, OWNER.email, OWNER.password);
    await page.goto("/announcements");
    await page.getByRole("link", { name: TITLE }).click();

    await expect(page.getByTestId("ack-rate")).toContainText("1");
    await expect(page.getByTestId("ack-rate")).toContainText("/ 2 名が確認済み");

    await expect(page.getByTestId("acknowledged-list")).toContainText(TANAKA.name);
    await expect(page.getByTestId("pending-list")).toContainText(SATO.name);
  });

  test("10. disabling 佐藤 removes her from the denominator, keeping 田中's confirmation", async ({
    page,
  }) => {
    await signIn(page, OWNER.email, OWNER.password);

    await page.goto("/members");
    const row = page.locator(".list__item", { hasText: SATO.email });
    await row.getByRole("button", { name: "停止" }).click();

    await page.goto("/announcements");
    await page.getByRole("link", { name: TITLE }).click();

    // 1/1, not 1/2: somebody who cannot sign in must not hold the rate below
    // 100% forever. 田中's acknowledgement is untouched.
    await expect(page.getByTestId("ack-rate")).toContainText("/ 1 名が確認済み");
    await expect(page.getByTestId("acknowledged-list")).toContainText(TANAKA.name);
    await expect(page.getByTestId("pending-list")).not.toContainText(SATO.name);
  });

  test("11. a member cannot reach the administrative screens", async ({ page }) => {
    await signIn(page, TANAKA.email, MEMBER_PASSWORD);

    await expect(page.getByRole("link", { name: "公告管理" })).toHaveCount(0);

    await page.goto("/announcements");
    await expect(page.getByTestId("toggle-create-announcement")).toHaveCount(0);

    await signOut(page);
  });
});
