import { expect, test } from "@playwright/test";

test("creates and starts a host computer", async ({ page }) => {
  await page.goto("/");
  const computerName = `lab-host-${Date.now()}`;

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
  const popupPromise = page.waitForEvent("popup");
  await page.getByTestId("open-monitor-link").click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");

  await expect(popup).toHaveTitle(new RegExp(`${computerName} - Computerd Browser`, "i"));
  await expect(popup.getByTestId("novnc-shell")).toBeVisible();
});

test("creates and opens a container exec shell", async ({ page }) => {
  await page.goto("/");
  const computerName = `workspace-container-${Date.now()}`;

  await page.getByLabel("Name").fill(computerName);
  await page.getByLabel("Profile").selectOption("container");
  await page.getByRole("button", { name: "Create computer" }).click();

  const computerButton = page.getByRole("button", { name: new RegExp(computerName, "i") });
  await expect(computerButton).toBeVisible();
  await computerButton.click();
  await page.getByTestId("computer-action-start").click();

  await expect(page.getByTestId("computer-state")).toHaveText("running");
  await expect(page.getByTestId("open-exec-link")).toBeVisible();
  await page.getByTestId("open-exec-link").click();

  await expect(page).toHaveURL(new RegExp(`/computers/${computerName}/exec$`));
  await expect(page.getByText("Console shell")).toBeVisible();
  await expect(page.getByTestId("console-shell")).toBeVisible();
});

test("rejects container exec shell after the container stops", async ({ page }) => {
  await page.goto("/");
  const computerName = `stopped-container-${Date.now()}`;

  await page.getByLabel("Name").fill(computerName);
  await page.getByLabel("Profile").selectOption("container");
  await page.getByRole("button", { name: "Create computer" }).click();

  const computerButton = page.getByRole("button", { name: new RegExp(computerName, "i") });
  await expect(computerButton).toBeVisible();
  await computerButton.click();
  await page.getByTestId("computer-action-start").click();
  await expect(page.getByTestId("computer-state")).toHaveText("running");

  await page.getByTestId("computer-action-stop").click();
  await expect(page.getByTestId("computer-state")).toHaveText("stopped");

  await page.getByTestId("open-exec-link").click();
  await expect(page).toHaveURL(new RegExp(`/computers/${computerName}/exec$`));
  await expect(page.getByRole("alert")).toContainText(
    `Computer "${computerName}" must be running before opening exec sessions.`,
  );
});

test("deletes a created container computer", async ({ page }) => {
  await page.goto("/");
  const computerName = `delete-container-${Date.now()}`;

  await page.getByLabel("Name").fill(computerName);
  await page.getByLabel("Profile").selectOption("container");
  await page.getByRole("button", { name: "Create computer" }).click();

  const computerButton = page.getByRole("button", { name: new RegExp(computerName, "i") });
  await expect(computerButton).toBeVisible();
  await computerButton.click();
  await page.getByTestId("computer-action-delete").click();

  await expect(page.getByRole("button", { name: new RegExp(computerName, "i") })).toHaveCount(0);
});

test("deletes a created host computer", async ({ page }) => {
  await page.goto("/");
  const computerName = `delete-host-${Date.now()}`;

  await page.getByLabel("Name").fill(computerName);
  await page.getByRole("button", { name: "Create computer" }).click();

  const computerButton = page.getByRole("button", { name: new RegExp(computerName, "i") });
  await expect(computerButton).toBeVisible();
  await computerButton.click();
  await page.getByTestId("computer-action-delete").click();

  await expect(page.getByRole("button", { name: new RegExp(computerName, "i") })).toHaveCount(0);
});
