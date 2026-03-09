import { spawn } from "node:child_process";

const runtimeMode =
  process.env.COMPUTERD_RUNTIME_MODE ?? (process.platform === "darwin" ? "development" : "systemd");

const children = [
  spawn(
    "pnpm",
    ["--filter", "@computerd/server", "dev"],
    {
      env: {
        ...process.env,
        COMPUTERD_RUNTIME_MODE: runtimeMode,
      },
      stdio: "inherit",
    },
  ),
  spawn("pnpm", ["--filter", "@computerd/web", "dev"], {
    env: process.env,
    stdio: "inherit",
  }),
];

let exiting = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (exiting) {
      return;
    }

    exiting = true;
    for (const child of children) {
      child.kill(signal);
    }
  });
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (exiting) {
      return;
    }

    exiting = true;
    for (const sibling of children) {
      if (sibling.pid !== child.pid) {
        sibling.kill("SIGTERM");
      }
    }

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}
