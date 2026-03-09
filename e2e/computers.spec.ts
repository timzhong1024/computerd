import { expect, test } from "@playwright/test";

test("creates and starts a terminal computer", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Name").fill("lab-terminal");
  await page.getByRole("button", { name: "Create computer" }).click();

  const computerButton = page.getByRole("button", { name: /lab-terminal terminal/i });
  await expect(computerButton).toBeVisible();
  await computerButton.click();
  await page.getByTestId("computer-action-start").click();

  await expect(page.getByTestId("computer-state")).toHaveText("running");
  await expect(page.getByText("docker.service")).toBeVisible();
});

test("creates a browser computer without introducing a new top-level kind", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Name").fill("research-browser");
  await page.getByLabel("Profile").selectOption("browser");
  await page.getByLabel("Start URL").fill("https://example.com");
  await page.getByRole("button", { name: "Create computer" }).click();

  const browserButton = page.getByRole("button", { name: /research-browser browser/i });
  await expect(browserButton).toBeVisible();
  await browserButton.click();
  await expect(page.getByText(/chromium -> https:\/\/example.com/i)).toBeVisible();
});
