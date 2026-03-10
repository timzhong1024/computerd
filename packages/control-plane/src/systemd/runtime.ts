import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { createBrowserRuntimePaths } from "./browser-runtime";
import type {
  BrowserViewport,
  PersistedBrowserComputer,
  HostUnitDetail,
  HostUnitSummary,
  PersistedComputer,
  UnitRuntimeState,
} from "./types";
import {
  createFileUnitStore,
  type FileUnitStoreOptions,
  type UnitFileStore,
} from "./unit-file-store";
import {
  createSystemdDbusClient,
  type SystemdDbusClient,
  type SystemdDbusClientOptions,
} from "./dbus-client";

export interface SystemdRuntime {
  createAutomationSession: (
    computer: PersistedBrowserComputer,
  ) => Promise<import("./types").ComputerAutomationSession>;
  createMonitorSession: (
    computer: PersistedBrowserComputer,
  ) => Promise<import("./types").ComputerMonitorSession>;
  createPersistentUnit: (computer: PersistedComputer) => Promise<UnitRuntimeState>;
  createScreenshot: (
    computer: PersistedBrowserComputer,
  ) => Promise<import("./types").ComputerScreenshot>;
  deletePersistentUnit: (unitName: string) => Promise<void>;
  getHostUnit: (unitName: string) => Promise<HostUnitDetail | null>;
  getRuntimeState: (unitName: string) => Promise<UnitRuntimeState | null>;
  listHostUnits: () => Promise<HostUnitSummary[]>;
  openAutomationAttach: (
    computer: PersistedBrowserComputer,
  ) => Promise<import("./types").BrowserAutomationLease>;
  openMonitorAttach: (
    computer: PersistedBrowserComputer,
  ) => Promise<import("./types").BrowserMonitorLease>;
  restartUnit: (unitName: string) => Promise<UnitRuntimeState>;
  startUnit: (unitName: string) => Promise<UnitRuntimeState>;
  stopUnit: (unitName: string) => Promise<UnitRuntimeState>;
  updateBrowserViewport: (
    computer: PersistedBrowserComputer,
    viewport: BrowserViewport,
  ) => Promise<void>;
}

export interface CreateSystemdRuntimeOptions {
  dbusClient?: SystemdDbusClient;
  dbusClientOptions?: SystemdDbusClientOptions;
  unitFileStore?: UnitFileStore;
  unitFileStoreOptions: FileUnitStoreOptions;
}

const execFileAsync = promisify(execFile);

export function createSystemdRuntime({
  dbusClientOptions,
  unitFileStoreOptions,
  dbusClient,
  unitFileStore,
}: CreateSystemdRuntimeOptions): SystemdRuntime {
  const resolvedDbusClient = dbusClient ?? createSystemdDbusClient(dbusClientOptions);
  const resolvedUnitFileStore = unitFileStore ?? createFileUnitStore(unitFileStoreOptions);
  const browserRuntimePaths = createBrowserRuntimePaths({
    runtimeRootDirectory: unitFileStoreOptions.browserRuntimeDirectory,
    stateRootDirectory: unitFileStoreOptions.browserStateDirectory,
  });

  return {
    async createMonitorSession(computer) {
      const spec = browserRuntimePaths.specForComputer(computer);
      return {
        computerName: computer.name,
        protocol: "vnc",
        connect: {
          mode: "relative-websocket-path",
          url: `/api/computers/${encodeURIComponent(computer.name)}/monitor/ws`,
        },
        authorization: {
          mode: "none",
        },
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        viewport: spec.viewport,
      };
    },
    async openMonitorAttach(computer) {
      const spec = browserRuntimePaths.specForComputer(computer);
      return {
        computerName: computer.name,
        host: "127.0.0.1",
        port: spec.vncPort,
        release() {},
      };
    },
    async createAutomationSession(computer) {
      return {
        computerName: computer.name,
        protocol: "cdp",
        connect: {
          mode: "relative-websocket-path",
          url: `/api/computers/${encodeURIComponent(computer.name)}/automation/ws`,
        },
        authorization: {
          mode: "none",
        },
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      };
    },
    async openAutomationAttach(computer) {
      const websocketUrl = await resolveAutomationWebSocketUrl(
        browserRuntimePaths.specForComputer(computer).devtoolsPort,
      );
      return {
        computerName: computer.name,
        url: websocketUrl,
        release() {},
      };
    },
    async createScreenshot(computer) {
      const spec = browserRuntimePaths.specForComputer(computer);
      const { stdout } = await execFileAsync("/usr/bin/bash", [
        "-lc",
        `DISPLAY=${quoteShell(spec.xvfbDisplay)} import -window root png:- | base64`,
      ]);
      return {
        computerName: computer.name,
        format: "png",
        mimeType: "image/png",
        capturedAt: new Date().toISOString(),
        width: spec.viewport.width,
        height: spec.viewport.height,
        dataBase64: stdout.trim(),
      };
    },
    async updateBrowserViewport(computer, viewport) {
      const spec = browserRuntimePaths.specForComputer(computer);
      const runtimeState = await resolvedDbusClient.getRuntimeState(computer.unitName);
      if (runtimeState?.activeState !== "active") {
        return;
      }

      await execFileAsync("/usr/bin/bash", [
        "-lc",
        [
          `DISPLAY=${quoteShell(spec.xvfbDisplay)}`,
          `xrandr -display ${quoteShell(spec.xvfbDisplay)} -s ${viewport.width}x${viewport.height}`,
        ].join(" "),
      ]).catch(async () => {
        await execFileAsync("/usr/bin/bash", [
          "-lc",
          [
            `DISPLAY=${quoteShell(spec.xvfbDisplay)}`,
            `xrandr -display ${quoteShell(spec.xvfbDisplay)} --fb ${viewport.width}x${viewport.height}`,
          ].join(" "),
        ]);
      });

      const websocketUrl = await resolveAutomationWebSocketUrl(spec.devtoolsPort);
      await resizeChromiumWindow(websocketUrl, viewport);
    },
    async createPersistentUnit(computer) {
      await resolvedUnitFileStore.writeUnitFile(computer);
      await resolvedDbusClient.reloadDaemon();
      await resolvedDbusClient.setUnitEnabled(
        computer.unitName,
        computer.lifecycle.autostart === true,
      );
      const runtimeState = await resolvedDbusClient.getRuntimeState(computer.unitName);
      if (runtimeState !== null) {
        return runtimeState;
      }

      return {
        unitName: computer.unitName,
        description: computer.description,
        unitType: "service",
        loadState: "loaded",
        activeState: "inactive",
        subState: "dead",
        execStart:
          computer.profile === "terminal" ? computer.runtime.execStart : "/usr/bin/bash -lc",
        workingDirectory:
          computer.profile === "terminal"
            ? computer.runtime.workingDirectory
            : browserRuntimePaths.specForComputer(computer).stateDirectory,
        environment: undefined,
        cpuWeight: computer.resources.cpuWeight,
        memoryMaxMiB: computer.resources.memoryMaxMiB,
      };
    },
    async deletePersistentUnit(unitName) {
      await resolvedDbusClient.deletePersistentUnit(unitName);
      await resolvedUnitFileStore.deleteUnitFile(unitName);
      await resolvedDbusClient.reloadDaemon();
    },
    getRuntimeState: resolvedDbusClient.getRuntimeState,
    startUnit: resolvedDbusClient.startUnit,
    stopUnit: resolvedDbusClient.stopUnit,
    restartUnit: resolvedDbusClient.restartUnit,
    listHostUnits: resolvedDbusClient.listHostUnits,
    getHostUnit: resolvedDbusClient.getHostUnit,
  };
}

async function resizeChromiumWindow(websocketUrl: string, viewport: BrowserViewport) {
  const targetsResponse = await sendCdpCommand(websocketUrl, "Target.getTargets");
  const pageTarget = findPageTargetId(targetsResponse);
  if (pageTarget === null) {
    return;
  }

  const windowResponse = await sendCdpCommand(websocketUrl, "Browser.getWindowForTarget", {
    targetId: pageTarget,
  });
  const windowId = readWindowId(windowResponse);
  if (windowId === null) {
    return;
  }

  await sendCdpCommand(websocketUrl, "Browser.setWindowBounds", {
    windowId,
    bounds: {
      width: viewport.width,
      height: viewport.height,
      left: 0,
      top: 0,
    },
  });
}

async function sendCdpCommand(
  websocketUrl: string,
  method: string,
  params?: Record<string, unknown>,
) {
  const websocket = new WebSocket(websocketUrl);
  await onceWebSocketOpen(websocket);

  const id = 1;
  const responsePromise = new Promise<unknown>((resolve, reject) => {
    const messageHandler = (data: Buffer) => {
      const payload = JSON.parse(data.toString("utf8")) as {
        id?: unknown;
        result?: unknown;
        error?: unknown;
      };
      if (payload.id !== id) {
        return;
      }

      websocket.off("message", messageHandler);
      websocket.off("close", closeHandler);
      websocket.close();

      if (payload.error !== undefined) {
        reject(new Error(`CDP ${method} failed: ${JSON.stringify(payload.error)}`));
        return;
      }

      resolve(payload.result ?? null);
    };

    const closeHandler = () => {
      reject(new Error(`CDP websocket closed before ${method} completed.`));
    };

    websocket.on("message", messageHandler);
    websocket.once("close", closeHandler);
    websocket.send(JSON.stringify({ id, method, params }));
  });

  return await responsePromise.finally(() => {
    if (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING) {
      websocket.close();
    }
  });
}

function findPageTargetId(payload: unknown) {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("targetInfos" in payload) ||
    !Array.isArray(payload.targetInfos)
  ) {
    return null;
  }

  const pageTarget = payload.targetInfos.find(
    (target): target is { targetId: string; type: string } =>
      typeof target === "object" &&
      target !== null &&
      "targetId" in target &&
      typeof target.targetId === "string" &&
      "type" in target &&
      target.type === "page",
  );

  return pageTarget?.targetId ?? null;
}

function readWindowId(payload: unknown) {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "windowId" in payload &&
    typeof payload.windowId === "number"
  ) {
    return payload.windowId;
  }

  return null;
}

function onceWebSocketOpen(websocket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      websocket.off("open", openHandler);
      websocket.off("error", errorHandler);
    };

    const openHandler = () => {
      cleanup();
      resolve();
    };

    const errorHandler = () => {
      cleanup();
      reject(new Error(`Failed to connect to CDP websocket at ${websocket.url}.`));
    };

    websocket.once("open", openHandler);
    websocket.once("error", errorHandler);
  });
}

async function resolveAutomationWebSocketUrl(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!response.ok) {
    throw new Error(`Chromium DevTools endpoint is unavailable on port ${port}.`);
  }

  const payload = (await response.json()) as { webSocketDebuggerUrl?: unknown };
  if (
    typeof payload.webSocketDebuggerUrl !== "string" ||
    payload.webSocketDebuggerUrl.length === 0
  ) {
    throw new Error(`Chromium DevTools endpoint on port ${port} did not return a websocket URL.`);
  }

  return payload.webSocketDebuggerUrl;
}

function quoteShell(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
