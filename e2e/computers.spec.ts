import { expect, test } from "@playwright/test";

test("creates and starts a terminal computer", async ({ page }) => {
  await page.goto("/");
  const computerName = `lab-terminal-${Date.now()}`;

  await page.getByLabel("Name").fill(computerName);
  await page.getByRole("button", { name: "Create computer" }).click();

  const computerButton = page.getByRole("button", { name: new RegExp(computerName, "i") });
  await expect(computerButton).toBeVisible();
  await computerButton.click();
  await page.getByTestId("computer-action-start").click();

  await expect(page.getByTestId("computer-state")).toHaveText("running");
  await expect(page.getByTestId("open-console-link")).toBeVisible();
});

test("creates and opens a browser computer", async ({ page }) => {
  await page.goto("/");
  const computerName = `research-browser-${Date.now()}`;

  await page.getByLabel("Name").fill(computerName);
  await page.getByLabel("Profile").selectOption("browser");
  await page.getByRole("button", { name: "Create computer" }).click();

  const computerButton = page.getByRole("button", { name: new RegExp(computerName, "i") });
  await expect(computerButton).toBeVisible();
  await computerButton.click();
  await page.getByTestId("computer-action-start").click();

  await expect(page.getByTestId("computer-state")).toHaveText("running");
  await expect(page.getByTestId("open-monitor-link")).toContainText("Open browser");
  await page.getByTestId("open-monitor-link").click();
  await expect(page.getByRole("heading", { name: computerName })).toBeVisible();
  await expect(page.getByTestId("novnc-shell")).toBeVisible();
});
