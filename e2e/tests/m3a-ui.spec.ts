import { expect, test, type Browser, type Page } from "@playwright/test";

import { resetDatabase } from "../fixtures/database.js";

/**
 * M3a through the interface.
 *
 *   Owner opens a channel for the branch and writes to it
 *   田中 finds it, joins, and answers
 *   Owner names 田中 in a message -> he is told he was named, not just that
 *     there is something new
 *   Owner and 佐藤 have a one-to-one conversation nobody else can read
 *   A message written in one window appears in another without a reload
 *
 * The last one is the only part of chat that cannot be checked by reading the
 * database, and the first thing anybody notices when it stops working.
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
const CHANNEL = "全体連絡";
const PRIVATE_CHANNEL = "運営メモ";

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("current-user")).toBeVisible();
}

/**
 * Signing out is a full page load, not a client-side navigation. Waiting for
 * the login form is what keeps the next `goto` from racing it and being
 * aborted mid-flight.
 */
async function signOut(page: Page) {
  await page.getByTestId("logout").click();
  await expect(page.getByTestId("login-submit")).toBeVisible();
}

async function send(page: Page, body: string) {
  await page.getByTestId("message-input").fill(body);
  await page.getByTestId("send-message").click();
  await expect(page.getByTestId("message-input")).toHaveValue("");
}

/** A second, independent browser session — a colleague at their own desk. */
async function openAs(browser: Browser, email: string, password: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email, password);
  return { context, page };
}

test.describe.configure({ mode: "serial" });

test.describe("M3a: talking to each other", () => {
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

  /**
   * Anybody may create a channel. Needing an administrator for this is how
   * internal tools end up with a support ticket for every new project group.
   */
  test("2. the Owner opens a channel and writes to it", async ({ page }) => {
    await signIn(page, OWNER.email, OWNER.password);

    await page.goto("/chat");
    await page.getByTestId("toggle-create-channel").click();
    await page.getByTestId("new-channel-name").fill(CHANNEL);
    await page.getByTestId("new-channel-description").fill("全員向けの連絡");
    await page.getByTestId("create-channel-submit").click();

    // Creating a channel opens it — a channel you cannot write in yet is not
    // what anybody meant to make.
    await expect(page.getByTestId("channel-title")).toHaveText(CHANNEL);
    await expect(page.getByTestId("no-messages")).toBeVisible();

    await send(page, "明日は8時30分から朝礼です。");
    await expect(page.getByTestId("message-body")).toContainText("8時30分から朝礼");
  });

  test("3. a second channel with the same name is refused", async ({ page }) => {
    await signIn(page, OWNER.email, OWNER.password);

    await page.goto("/chat");
    await page.getByTestId("toggle-create-channel").click();
    await page.getByTestId("new-channel-name").fill(CHANNEL);
    await page.getByTestId("create-channel-submit").click();

    await expect(page.getByTestId("create-channel-error")).toContainText(
      "同じ名前のチャンネルが既に存在します",
    );
  });

  /**
   * A public channel is listed to somebody who has not joined — that is what
   * makes it discoverable — and readable. Posting still requires joining.
   */
  test("4. 田中 finds the channel, reads it, and joins before writing", async ({
    page,
  }) => {
    await signIn(page, TANAKA.email, MEMBER_PASSWORD);

    await page.goto("/chat");
    await expect(page.getByTestId("public-channel-list")).toContainText(CHANNEL);

    // He can read it before joining — otherwise "public" only means it is
    // listed, and joining is a guess.
    await page.getByTestId("public-channel-list").getByText(CHANNEL).click();
    await expect(page.getByTestId("message-log")).toContainText("8時30分から朝礼");
    await expect(page.getByTestId("message-input")).toHaveCount(0);

    await page.getByTestId("join-channel").click();
    await expect(page.getByTestId("message-input")).toBeVisible();

    await send(page, "承知しました。");
    await expect(page.getByTestId("message-log")).toContainText("承知しました。");
  });

  /**
   * The reply quote is stored with the message, so "what was this an answer
   * to" survives however the log is later paged through.
   */
  test("5. 佐藤 answers a specific message", async ({ page }) => {
    await signIn(page, SATO.email, MEMBER_PASSWORD);

    await page.goto("/chat");
    await page.getByTestId(`join-${CHANNEL}`).click();
    await page.getByTestId(`channel-row-${CHANNEL}`).getByText(CHANNEL).click();

    await page.getByTestId("message").first().getByTestId("reply-to-message").click();
    await expect(page.getByTestId("replying-to")).toContainText("8時30分から朝礼");

    await send(page, "了解です。");

    const last = page.getByTestId("message").last();
    await expect(last.getByTestId("reply-quote")).toContainText("8時30分から朝礼");
  });

  /**
   * Being named is a different question from there being something new. Forty
   * unread messages can wait; one addressed to you usually cannot.
   */
  test("6. the Owner names 田中, and 田中 is told he was named", async ({ page }) => {
    await signIn(page, OWNER.email, OWNER.password);

    await page.goto("/chat");
    await page.getByTestId(`channel-row-${CHANNEL}`).getByText(CHANNEL).click();

    await page.getByTestId("message-input").fill("A区域の担当をお願いします ");
    await page.getByTestId(`mention-${TANAKA.name}`).click();
    await page.getByTestId("send-message").click();

    // Written as a name, not as the id the server actually stores.
    const last = page.getByTestId("message").last();
    await expect(last.getByTestId("mention")).toHaveText(`@${TANAKA.name}`);

    await signOut(page);
    await signIn(page, TANAKA.email, MEMBER_PASSWORD);

    await page.goto("/chat");
    await expect(page.getByTestId(`mention-${CHANNEL}`)).toHaveText("@あなた");
    await expect(page.getByTestId(`unread-${CHANNEL}`)).toBeVisible();
    await expect(page.getByTestId("nav-unread")).toBeVisible();
  });

  /** Opening the channel is what marks it read — and it stays read. */
  test("7. reading the channel clears the badge and shows where he was", async ({
    page,
  }) => {
    await signIn(page, TANAKA.email, MEMBER_PASSWORD);

    await page.goto("/chat");
    await page.getByTestId(`channel-row-${CHANNEL}`).getByText(CHANNEL).click();

    await expect(page.getByTestId("unread-divider")).toBeVisible();

    await page.goto("/chat");
    await expect(page.getByTestId(`unread-${CHANNEL}`)).toHaveCount(0);
    await expect(page.getByTestId("nav-unread")).toHaveCount(0);
  });

  /**
   * A conversation is opened by naming the person, and opening it twice must
   * reach the same one — two conversations holding half the history each is
   * worse than none.
   */
  test("8. the Owner and 佐藤 have a one-to-one conversation", async ({ page }) => {
    await signIn(page, OWNER.email, OWNER.password);

    await page.goto("/chat");
    await page.getByTestId("toggle-new-conversation").click();
    await page.getByTestId(`start-conversation-${SATO.email}`).click();

    await expect(page.getByTestId("channel-title")).toHaveText(SATO.name);
    await send(page, "経費の件、確認しました。");

    const conversationUrl = page.url();

    await page.goto("/chat");
    await page.getByTestId("toggle-new-conversation").click();
    await page.getByTestId(`start-conversation-${SATO.email}`).click();

    // The same conversation, with the message still in it.
    await expect(page).toHaveURL(conversationUrl);
    await expect(page.getByTestId("message-log")).toContainText("経費の件");
  });

  test("9. 田中 cannot read that conversation, even with the address", async ({
    browser,
    page,
  }) => {
    await signIn(page, OWNER.email, OWNER.password);
    await page.goto("/chat");
    await page.getByTestId("toggle-new-conversation").click();
    await page.getByTestId(`start-conversation-${SATO.email}`).click();
    await expect(page.getByTestId("channel-title")).toHaveText(SATO.name);
    const conversationUrl = page.url();

    const intruder = await openAs(browser, TANAKA.email, MEMBER_PASSWORD);
    try {
      await intruder.page.goto("/chat");
      await expect(intruder.page.getByTestId("channel-list")).not.toContainText(
        SATO.name,
      );

      await intruder.page.goto(conversationUrl);
      // Not "you are not allowed": a private conversation must not confirm its
      // own existence to somebody outside it.
      await expect(intruder.page.getByTestId("message-log")).not.toContainText(
        "経費の件",
      );
      await expect(intruder.page.locator(".alert--error")).toContainText(
        "対象が見つかりません",
      );
    } finally {
      await intruder.context.close();
    }
  });

  test("10. a private channel is invisible to somebody who is not in it", async ({
    browser,
    page,
  }) => {
    await signIn(page, OWNER.email, OWNER.password);

    await page.goto("/chat");
    await page.getByTestId("toggle-create-channel").click();
    await page.getByTestId("new-channel-name").fill(PRIVATE_CHANNEL);
    await page.getByTestId("new-channel-private").check();
    await page.getByTestId("create-channel-submit").click();
    await expect(page.getByTestId("channel-title")).toHaveText(PRIVATE_CHANNEL);

    const outsider = await openAs(browser, SATO.email, MEMBER_PASSWORD);
    try {
      await outsider.page.goto("/chat");
      await expect(outsider.page.locator("body")).not.toContainText(PRIVATE_CHANNEL);
    } finally {
      await outsider.context.close();
    }
  });

  /**
   * The one thing about chat that cannot be verified from the database: a
   * message written at one desk appearing at another without anybody pressing
   * reload.
   */
  test("11. a message arrives in an open window without a reload", async ({
    browser,
  }) => {
    const owner = await openAs(browser, OWNER.email, OWNER.password);
    const tanaka = await openAs(browser, TANAKA.email, MEMBER_PASSWORD);

    try {
      for (const session of [owner, tanaka]) {
        await session.page.goto("/chat");
        await session.page
          .getByTestId(`channel-row-${CHANNEL}`)
          .getByText(CHANNEL)
          .click();
        await expect(session.page.getByTestId("channel-title")).toHaveText(CHANNEL);
      }

      await send(owner.page, "トラックの鍵は事務所です。");

      // No reload, no navigation: the socket delivered it.
      await expect(tanaka.page.getByTestId("message-log")).toContainText(
        "トラックの鍵は事務所です。",
      );

      // And exactly once in the window that sent it — the author is a member,
      // so their own message comes back over the socket as well as in the
      // response to the request that created it.
      await expect(
        owner.page.getByTestId("message").filter({ hasText: "トラックの鍵" }),
      ).toHaveCount(1);
    } finally {
      await owner.context.close();
      await tanaka.context.close();
    }
  });

  /**
   * A file, sent and received. The interesting half is the refusal: a renamed
   * executable is rejected while the sender is still looking at it, not after
   * somebody downloads it.
   */
  test("12. a file is attached, and a colleague can open it", async ({
    browser,
    page,
  }) => {
    await signIn(page, OWNER.email, OWNER.password);
    await page.goto("/chat");
    await page.getByTestId(`channel-row-${CHANNEL}`).getByText(CHANNEL).click();

    await page.getByTestId("attach-file").setInputFiles({
      name: "作業手順.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n"),
    });

    await expect(page.getByTestId("pending-attachments")).toContainText("作業手順.pdf");

    await page.getByTestId("message-input").fill("手順書を共有します。");
    await page.getByTestId("send-message").click();

    const last = page.getByTestId("message").last();
    await expect(last.getByTestId("attachment-link")).toContainText("作業手順.pdf");

    // 田中 downloads it. The permission is re-checked on the way out, so this
    // proves the whole path and not just the link.
    const tanaka = await openAs(browser, TANAKA.email, MEMBER_PASSWORD);
    try {
      await tanaka.page.goto("/chat");
      await tanaka.page.getByTestId(`channel-row-${CHANNEL}`).getByText(CHANNEL).click();

      const link = tanaka.page.getByTestId("attachment-link").last();
      await expect(link).toContainText("作業手順.pdf");

      const download = tanaka.page.waitForEvent("download");
      await link.click();
      expect((await download).suggestedFilename()).toBe("作業手順.pdf");
    } finally {
      await tanaka.context.close();
    }
  });

  /**
   * The rule that matters most: the extension is a claim and the bytes are the
   * evidence. Refused at the moment the file is chosen.
   */
  test("13. an executable renamed to a spreadsheet is refused", async ({ page }) => {
    await signIn(page, OWNER.email, OWNER.password);
    await page.goto("/chat");
    await page.getByTestId(`channel-row-${CHANNEL}`).getByText(CHANNEL).click();

    await page.getByTestId("attach-file").setInputFiles({
      name: "勤務表.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      // MZ — a Windows executable wearing a spreadsheet's name.
      buffer: Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]),
    });

    await expect(page.getByTestId("upload-error")).toContainText(
      "ファイルの中身が拡張子と一致しません",
    );
    await expect(page.getByTestId("pending-attachments")).toHaveCount(0);
  });

  test("14. a kind of file that is not allowed at all is refused", async ({ page }) => {
    await signIn(page, OWNER.email, OWNER.password);
    await page.goto("/chat");
    await page.getByTestId(`channel-row-${CHANNEL}`).getByText(CHANNEL).click();

    await page.getByTestId("attach-file").setInputFiles({
      name: "setup.exe",
      mimeType: "application/octet-stream",
      buffer: Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
    });

    await expect(page.getByTestId("upload-error")).toContainText(
      "この種類のファイルは添付できません",
    );
  });

  test("15. chat is reachable from the navigation at every width", async ({ page }) => {
    await signIn(page, TANAKA.email, MEMBER_PASSWORD);

    await page.getByRole("link", { name: "チャット" }).click();
    await expect(page.getByTestId("channel-list")).toContainText(CHANNEL);
  });
});
