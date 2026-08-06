import { expect, test } from "@playwright/test";

/**
 * M0 smoke test.
 *
 * Small, but it proves the whole chain is wired: browser -> Vite -> proxy ->
 * Fastify -> PostgreSQL, at both desktop and phone widths. Every later
 * acceptance scenario builds on this being true.
 */

test("the shell renders and reports a healthy system", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Atarimae", level: 1 })).toBeVisible();

  // Resolves once the health query settles.
  await expect(page.getByTestId("health-status")).toHaveText("正常");
  await expect(page.getByTestId("health-database")).toHaveText("接続済み");
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
