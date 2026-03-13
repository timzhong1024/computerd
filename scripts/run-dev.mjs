import { spawn } from "node:child_process";
import { Socket } from "node:net";

const runtimeMode =
  process.env.COMPUTERD_RUNTIME_MODE ?? (process.platform === "darwin" ? "development" : "systemd");
const serverHost = process.env.HOST ?? "127.0.0.1";
const serverPort = Number.parseInt(process.env.PORT ?? "3000", 10);

const children = [];

if (await isPortReachable(serverHost, serverPort)) {
  console.error(
    `Computerd dev server port ${serverHost}:${serverPort} is already in use. Stop the existing process or use a different PORT.`,
  );
  process.exit(1);
}

children.push(
  spawn("pnpm", ["--filter", "@computerd/server", "dev"], {
    env: {
      ...process.env,
      COMPUTERD_RUNTIME_MODE: runtimeMode,
    },
    stdio: "inherit",
  }),
);

children.push(
  spawn("pnpm", ["--filter", "@computerd/web", "dev"], {
    env: process.env,
    stdio: "inherit",
  }),
);

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

function isPortReachable(host, port) {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;

    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(750);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
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
