import { spawn } from "node:child_process";

const runtimeMode =
  process.env.COMPUTERD_RUNTIME_MODE ?? (process.platform === "darwin" ? "development" : "systemd");

const child = spawn(
  "pnpm",
  ["--filter", "@computerd/server", "dev"],
  {
    env: {
      ...process.env,
      COMPUTERD_RUNTIME_MODE: runtimeMode,
    },
    stdio: "inherit",
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
