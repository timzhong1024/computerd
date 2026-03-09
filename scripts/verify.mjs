import { spawn } from "node:child_process";

const steps = [
  ["format", ["format:check"]],
  ["lint", ["lint"]],
  ["typecheck", ["typecheck"]],
  ["test", ["test"]],
  ["test:e2e", ["test:e2e"]],
  ["build", ["build"]],
];

for (const [name, args] of steps) {
  await runStep(name, args);
}

console.log("\nverify: all checks passed");

function runStep(name, args) {
  return new Promise((resolve, reject) => {
    console.log(`\n==> ${name}`);

    const child = spawn("pnpm", args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      if (signal) {
        reject(new Error(`verify failed during ${name}: terminated by signal ${signal}`));
        return;
      }

      reject(new Error(`verify failed during ${name} with exit code ${code ?? "unknown"}`));
    });
  });
}
