import { expect, test } from "@playwright/test";

/**
 * Smoke test.
 *
 * Small, but it proves the whole chain is wired: browser -> Vite -> proxy ->
 * Fastify -> PostgreSQL, at both desktop and phone widths.
 *
 * Deliberately makes no assumption about whether the organisation has been
 * initialised — other specs reset the database, and this one must pass either
 * way. It asserts only what is true in both cases.
 */

test("an unauthenticated visitor reaches an entry screen, never the app", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Atarimae", level: 1 })).toBeVisible();

  // Either first-run setup or sign-in, depending on whether an Owner exists.
  // What must never happen is the application shell rendering without a session.
  const entry = page.getByTestId("setup-submit").or(page.getByTestId("login-submit"));
  await expect(entry).toBeVisible();

  await expect(page.getByTestId("current-user")).toHaveCount(0);
});

test("protected routes are not reachable without a session", async ({ page }) => {
  await page.goto("/members");

  const entry = page.getByTestId("setup-submit").or(page.getByTestId("login-submit"));
  await expect(entry).toBeVisible();
  await expect(page.getByTestId("member-list")).toHaveCount(0);
});

test("the API answers directly", async ({ request }) => {
  const response = await request.get("/api/v1/health");

  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({
    status: "ok",
    checks: { database: "ok" },
  });
});

test("unknown routes return the shared error shape", async ({ request }) => {
  const response = await request.get("/api/v1/nope");

  expect(response.status()).toBe(404);

  const body = (await response.json()) as { code: string; requestId?: string };
  expect(body.code).toBe("NOT_FOUND");
  expect(body.requestId).toBeTruthy();
});
