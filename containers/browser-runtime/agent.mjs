#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";

const browserName = process.env.COMPUTERD_BROWSER_NAME ?? "browser";
const profileDirectory = process.env.COMPUTERD_BROWSER_PROFILE_DIR ?? "/computerd/state/profile";
const runtimeDirectory = process.env.COMPUTERD_BROWSER_RUNTIME_DIR ?? "/computerd/runtime";
const controlSocketPath =
  process.env.COMPUTERD_BROWSER_CONTROL_SOCKET ?? join(runtimeDirectory, "control.sock");
const devtoolsPort = Number.parseInt(process.env.COMPUTERD_BROWSER_DEVTOOLS_PORT ?? "9222", 10);
const vncPort = Number.parseInt(process.env.COMPUTERD_BROWSER_VNC_PORT ?? "5900", 10);
const displayNumber = process.env.COMPUTERD_BROWSER_DISPLAY ?? ":99";

let viewport = parseViewport(process.env.COMPUTERD_BROWSER_VIEWPORT ?? "1440x900");
let children = createEmptyChildren();
let shuttingDown = false;

await ensureDirectories();
await startStack();
await startControlServer();

process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));

async function ensureDirectories() {
  await mkdir(profileDirectory, { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true });
  await mkdir(dirname(controlSocketPath), { recursive: true });
  await rm(controlSocketPath, { force: true });
}

async function startControlServer() {
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        respondJson(response, {
          controlReady: true,
          vncReady: isRunning(children.x11vnc),
          cdpReady: isRunning(children.chromium),
          viewport,
        });
        return;
      }

      if (request.method === "POST" && request.url === "/screenshot") {
        const screenshot = await captureScreenshot();
        respondJson(response, {
          screenshot: {
            computerName: browserName,
            format: "png",
            mimeType: "image/png",
            capturedAt: new Date().toISOString(),
            width: viewport.width,
            height: viewport.height,
            dataBase64: screenshot.toString("base64"),
          },
        });
        return;
      }

      if (request.method === "POST" && request.url === "/resize") {
        const body = await readJsonBody(request);
        viewport = parseViewportBody(body);
        await restartStack();
        respondJson(response, {
          appliedViewport: viewport,
          restarted: true,
        });
        return;
      }

      response.statusCode = 404;
      response.end("not found");
    } catch (error) {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(controlSocketPath, () => resolve(undefined));
  });
}

async function restartStack() {
  await stopStack();
  await startStack();
}

async function startStack() {
  children.xvfb = spawn(
    "Xvfb",
    [displayNumber, "-screen", "0", `${viewport.width}x${viewport.height}x24`, "-nolisten", "tcp"],
    { stdio: "inherit" },
  );

  await waitFor(250);

  const commonEnv = {
    ...process.env,
    DISPLAY: displayNumber,
    HOME: join(runtimeDirectory, "home"),
    XDG_RUNTIME_DIR: runtimeDirectory,
  };
  await mkdir(commonEnv.HOME, { recursive: true });

  children.chromium = spawn(
    "chromium",
    [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profileDirectory}`,
      `--remote-debugging-address=0.0.0.0`,
      `--remote-debugging-port=${devtoolsPort}`,
      `--window-size=${viewport.width},${viewport.height}`,
      "about:blank",
    ],
    {
      env: commonEnv,
      stdio: "inherit",
    },
  );

  children.x11vnc = spawn(
    "x11vnc",
    ["-display", displayNumber, "-forever", "-shared", "-rfbport", `${vncPort}`, "-nopw"],
    {
      env: commonEnv,
      stdio: "inherit",
    },
  );
}

async function stopStack() {
  await Promise.all([
    stopChild(children.x11vnc),
    stopChild(children.chromium),
    stopChild(children.xvfb),
  ]);
  children = createEmptyChildren();
}

async function captureScreenshot() {
  return await runCapture("import", ["-display", displayNumber, "-window", "root", "png:-"]);
}

async function shutdown(code) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await stopStack();
  await rm(controlSocketPath, { force: true });
  process.exit(code);
}

function createEmptyChildren() {
  return {
    chromium: null,
    x11vnc: null,
    xvfb: null,
  };
}

function isRunning(child) {
  return child !== null && child.exitCode === null && child.killed === false;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    child.once("exit", () => resolve(undefined));
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, 1_000);
  });
}

async function runCapture(command, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseViewport(value) {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid viewport: ${value}`);
  }
  return {
    width: Number.parseInt(match[1], 10),
    height: Number.parseInt(match[2], 10),
  };
}

function parseViewportBody(body) {
  if (
    typeof body !== "object" ||
    body === null ||
    typeof body.width !== "number" ||
    typeof body.height !== "number"
  ) {
    throw new Error("Expected JSON body with numeric width and height.");
  }
  return {
    width: Math.max(1, Math.trunc(body.width)),
    height: Math.max(1, Math.trunc(body.height)),
  };
}

function respondJson(response, payload) {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}

async function waitFor(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
