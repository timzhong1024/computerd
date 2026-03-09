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
  await expect(page.getByText("docker.service")).toBeVisible();
});

test("rejects browser computer creation in the current runtime", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Name").fill("research-browser");
  await page.getByLabel("Profile").selectOption("browser");
  await page.getByLabel("Start URL").fill("https://example.com");
  await page.getByRole("button", { name: "Create computer" }).click();

  await expect(page.getByRole("alert")).toContainText(
    'Computer profile "browser" is not supported in the DBus runtime yet.',
  );
});
