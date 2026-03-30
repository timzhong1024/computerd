import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { dirname } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

async function main() {
  const port = await reservePort();
  const appDirectory = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: appDirectory,
    env: {
      ...process.env,
      COMPUTERD_RUNTIME_MODE: "development",
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    await waitForHealthz(port, child, () => `${stdout}${stderr}`);
  } finally {
    child.kill("SIGTERM");
    await waitForExit(child).catch(() => {
      child.kill("SIGKILL");
    });
  }
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to reserve an ephemeral port."));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function waitForHealthz(port, child, output) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Built server exited early with code ${child.exitCode}.\n${output()}`.trim());
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {}

    await delay(100);
  }

  throw new Error(`Built server did not become healthy in time.\n${output()}`.trim());
}

async function waitForExit(child) {
  return await new Promise((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
    setTimeout(() => reject(new Error("Timed out waiting for built server to exit.")), 2_000);
  });
}

await main();
