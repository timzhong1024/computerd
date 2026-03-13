import { SystemdControlPlane } from "@computerd/control-plane";
import { ensureVmBridge } from "./runtime/ensure-vm-bridge";
import { createApp } from "./transport/http/create-app";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
ensureVmBridge();
const controlPlane = new SystemdControlPlane();
const app = createApp(controlPlane);

app.listen(port, host, () => {
  console.log(`Computerd server listening on http://${host}:${port}`);
});
