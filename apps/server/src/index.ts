import { createControlPlane } from "@computerd/control-plane";
import { ensureVmBridge } from "./runtime/ensure-vm-bridge";
import { createMcpHandler } from "./transport/http/create-mcp-handler";
import { createApp } from "./transport/http/create-app";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
ensureVmBridge();
const controlPlane = createControlPlane();
const app = createApp({
  deleteContainerImage: controlPlane.deleteContainerImage,
  createAutomationSession: controlPlane.createAutomationSession,
  createAudioSession: controlPlane.createAudioSession,
  handleMcpRequest: createMcpHandler(controlPlane),
  createConsoleSession: controlPlane.createConsoleSession,
  createExecSession: controlPlane.createExecSession,
  openConsoleAttach: controlPlane.openConsoleAttach,
  openExecAttach: controlPlane.openExecAttach,
  openAutomationAttach: controlPlane.openAutomationAttach,
  openAudioStream: controlPlane.openAudioStream,
  listComputers: () => controlPlane.listComputers(),
  listComputerSnapshots: controlPlane.listComputerSnapshots,
  createMonitorSession: controlPlane.createMonitorSession,
  openMonitorAttach: controlPlane.openMonitorAttach,
  createScreenshot: controlPlane.createScreenshot,
  getComputer: controlPlane.getComputer,
  getImage: controlPlane.getImage,
  createComputer: controlPlane.createComputer,
  createComputerSnapshot: controlPlane.createComputerSnapshot,
  deleteComputer: controlPlane.deleteComputer,
  deleteComputerSnapshot: controlPlane.deleteComputerSnapshot,
  startComputer: controlPlane.startComputer,
  stopComputer: controlPlane.stopComputer,
  restartComputer: controlPlane.restartComputer,
  restoreComputer: controlPlane.restoreComputer,
  listImages: controlPlane.listImages,
  listHostUnits: controlPlane.listHostUnits,
  pullContainerImage: controlPlane.pullContainerImage,
  getHostUnit: controlPlane.getHostUnit,
  updateBrowserViewport: controlPlane.updateBrowserViewport,
});

app.listen(port, host, () => {
  console.log(`Computerd server listening on http://${host}:${port}`);
});
