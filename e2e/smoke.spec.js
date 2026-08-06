const { test, expect } = require("@playwright/test");

test("discover page loads", async ({ page }) => {
  await page.goto("/discover");
  await expect(page).toHaveTitle(/Discover universities/);
});

test("healthz reports ok", async ({ request }) => {
  const res = await request.get("/healthz");
  expect(res.ok()).toBe(true);
  expect((await res.json()).status).toBe("ok");
});
