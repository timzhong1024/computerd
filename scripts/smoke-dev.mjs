import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const serverUrl = "http://127.0.0.1:3000";
const webUrl = "http://127.0.0.1:4173";

const server = spawn(resolve(process.cwd(), "node_modules/.bin/vite-node"), ["src/index.ts"], {
  cwd: resolve(process.cwd(), "apps/server"),
  env: { ...process.env, HOST: "127.0.0.1", PORT: "3000", COMPUTERD_USE_FIXTURE: "1" },
  stdio: "inherit",
});

const web = spawn(
  resolve(process.cwd(), "node_modules/.bin/vite"),
  ["--host", "127.0.0.1", "--port", "4173", "--strictPort"],
  {
    cwd: resolve(process.cwd(), "apps/web"),
    env: process.env,
    stdio: "inherit",
  },
);

try {
  await waitForJson(`${serverUrl}/healthz`, (payload) => payload.status === "ok");
  await waitForJson(
    `${serverUrl}/api/host-units`,
    (payload) =>
      Array.isArray(payload) && payload.some((unit) => unit.unitName === "docker.service"),
  );
  await waitForText(webUrl, "<title>Computerd</title>");
  await waitForText(webUrl, '<div id="root"></div>');
  await waitForText(webUrl, "/src/main.tsx");
  console.log("smoke: all checks passed");
} finally {
  server.kill("SIGTERM");
  web.kill("SIGTERM");
}

async function waitForJson(url, predicate) {
  await waitFor(async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Expected ${url} to be healthy, got ${response.status}`);
    }

    const payload = await response.json();
    if (!predicate(payload)) {
      throw new Error(`Unexpected JSON payload from ${url}`);
    }
  });
}

async function waitForText(url, expectedText) {
  await waitFor(async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Expected ${url} to be healthy, got ${response.status}`);
    }

    const body = await response.text();
    if (!body.includes(expectedText)) {
      throw new Error(`Expected ${url} to contain "${expectedText}"`);
    }
  });
}

async function waitFor(check) {
  let lastError;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      await delay(200);
    }
  }

  throw lastError;
}
