import { spawn } from "node:child_process";

if (process.platform === "darwin" && process.env.FORCE_E2E !== "1") {
  console.log("test:e2e skipped on macOS; set FORCE_E2E=1 to run anyway.");
  process.exit(0);
}

const child = spawn("playwright", ["test"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

child.on("error", (error) => {
  throw error;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
