import { fileURLToPath } from "node:url";
import { SystemdControlPlane } from "@computerd/control-plane";
import { ensureVmBridge } from "./runtime/ensure-vm-bridge";
import { createApp } from "./transport/http/create-app";

const defaultHost = process.env.HOST ?? "127.0.0.1";
const defaultPort = Number.parseInt(process.env.PORT ?? "3000", 10);

interface StartServerOptions {
  host?: string;
  port?: number;
  ensureVmBridge?: () => void;
  controlPlane?: SystemdControlPlane;
  createApp?: typeof createApp;
  logger?: Pick<typeof console, "log" | "error">;
}

export function startServer(options: StartServerOptions = {}) {
  const host = options.host ?? defaultHost;
  const port = options.port ?? defaultPort;
  const logger = options.logger ?? console;
  const ensureVmBridgeFn = options.ensureVmBridge ?? ensureVmBridge;
  const controlPlane = options.controlPlane ?? new SystemdControlPlane();
  const createAppFn = options.createApp ?? createApp;

  ensureVmBridgeFn();
  const app = createAppFn(controlPlane);

  void controlPlane.networkProvider.ensureConfiguredNetworks().catch((error: unknown) => {
    logger.error("Failed to ensure configured networks during startup.", error);
  });

  app.listen(port, host, () => {
    logger.log(`Computerd server listening on http://${host}:${port}`);
  });

  return { app, controlPlane };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer();
}
