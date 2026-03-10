import { createComputerdClient } from "../packages/sdk/src/index";

async function main() {
  const baseUrl = process.env.COMPUTERD_BASE_URL ?? "http://127.0.0.1:3000";
  const name = process.argv[2] ?? "chrome1";
  const client = createComputerdClient({ baseUrl });

  const browser = await client.connectPlaywright(name);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  console.log(`Attached to ${name}`);
  console.log(`Current page count: ${context.pages().length}`);

  await page.goto("https://example.com");
  console.log(`Title: ${await page.title()}`);

  const screenshotPath = `${name}-page.png`;
  await page.screenshot({ path: screenshotPath });
  console.log(`Saved page screenshot to ${screenshotPath}`);

  await browser.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
