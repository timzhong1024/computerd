import { createControlPlane } from "@computerd/control-plane";
import { createMcpHandler } from "./transport/http/create-mcp-handler";
import { createApp } from "./transport/http/create-app";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const controlPlane = createControlPlane();
const app = createApp({
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
  createMonitorSession: controlPlane.createMonitorSession,
  openMonitorAttach: controlPlane.openMonitorAttach,
  createScreenshot: controlPlane.createScreenshot,
  getComputer: controlPlane.getComputer,
  createComputer: controlPlane.createComputer,
  deleteComputer: controlPlane.deleteComputer,
  startComputer: controlPlane.startComputer,
  stopComputer: controlPlane.stopComputer,
  restartComputer: controlPlane.restartComputer,
  listHostUnits: controlPlane.listHostUnits,
  getHostUnit: controlPlane.getHostUnit,
  updateBrowserViewport: controlPlane.updateBrowserViewport,
});

app.listen(port, host, () => {
  console.log(`Computerd server listening on http://${host}:${port}`);
});
