import { spawn } from "node:child_process";

const MAX_FAILURE_LINES = 120;

export async function runVerifySteps({ label, successMessage, failurePrefix, steps }) {
  const startedAt = Date.now();

  for (const [name, args] of steps) {
    await runStep(name, args);
  }

  console.log(`${label}: ${successMessage} (${formatDuration(Date.now() - startedAt)})`);

  function runStep(name, args) {
    return new Promise((resolve, reject) => {
      const stepStartedAt = Date.now();
      process.stdout.write(`${label}: ${name} ... `);

      const child = spawn("pnpm", args, {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });

      child.on("error", reject);
      child.on("exit", (code, signal) => {
        const duration = formatDuration(Date.now() - stepStartedAt);

        if (code === 0) {
          console.log(`ok (${duration})`);
          resolve();
          return;
        }

        console.log(`failed (${duration})`);

        const output = [stdout, stderr].filter(Boolean).join("");
        const trimmedOutput = trimToLastLines(output, MAX_FAILURE_LINES);
        if (trimmedOutput) {
          console.error(`\n${name} output (last ${MAX_FAILURE_LINES} lines):\n${trimmedOutput}`);
        }

        if (signal) {
          reject(new Error(`${failurePrefix} during ${name}: terminated by signal ${signal}`));
          return;
        }

        reject(new Error(`${failurePrefix} during ${name} with exit code ${code ?? "unknown"}`));
      });
    });
  }
}

function trimToLastLines(text, maxLines) {
  const normalized = text.trim();
  if (!normalized) {
    return "";
  }

  const lines = normalized.split("\n");
  return lines.slice(-maxLines).join("\n");
}

function formatDuration(durationMs) {
  const seconds = durationMs / 1000;
  return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
}
