import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import type {
  ComputerMetadataStore,
  ComputerRuntimePort,
  PersistedComputer,
  PersistedTerminalComputer,
  UnitRuntimeState,
} from "./systemd/types";
import {
  ComputerConsoleUnavailableError,
  ComputerConflictError,
  ComputerNotFoundError,
  createControlPlane,
} from "./index";

test("creates and manages a terminal computer with persisted metadata", async () => {
  const metadataStore = createMemoryMetadataStore();
  const runtime = createMemoryRuntime("/tmp/computerd-test-terminals");
  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
      COMPUTERD_TERMINAL_RUNTIME_DIR: "/tmp/computerd-test-terminals",
    },
    { metadataStore, runtime },
  );

  const created = await controlPlane.createComputer({
    name: "lab-terminal",
    profile: "terminal",
    resources: {
      cpuWeight: 200,
      memoryMaxMiB: 512,
    },
    lifecycle: {
      autostart: true,
    },
    runtime: {
      execStart: "/usr/bin/bash",
      workingDirectory: "/workspace",
      environment: {
        FOO: "bar",
      },
    },
  });

  expect(created.profile).toBe("terminal");
  expect(created.state).toBe("stopped");
  expect(created.resources).toMatchObject({
    cpuWeight: 200,
    memoryMaxMiB: 512,
  });

  const started = await controlPlane.startComputer("lab-terminal");
  expect(started.state).toBe("running");

  const stopped = await controlPlane.stopComputer("lab-terminal");
  expect(stopped.state).toBe("stopped");

  const restarted = await controlPlane.restartComputer("lab-terminal");
  expect(restarted.state).toBe("running");

  const detail = await controlPlane.getComputer("lab-terminal");
  expect(detail.runtime).toMatchObject({
    execStart: "/usr/bin/bash",
    workingDirectory: "/workspace",
    environment: {
      FOO: "bar",
    },
  });

  const list = await controlPlane.listComputers();
  expect(list).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "lab-terminal", state: "running" })]),
  );
});

test("creates and manages a browser computer with persisted metadata", async () => {
  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
      COMPUTERD_BROWSER_RUNTIME_DIR: "/tmp/computerd-test-browsers",
      COMPUTERD_BROWSER_STATE_DIR: "/tmp/computerd-test-browser-state",
    },
    {
      metadataStore: createMemoryMetadataStore(),
      runtime: createMemoryRuntime("/tmp/computerd-test-terminals"),
    },
  );

  const created = await controlPlane.createComputer({
    name: "research-browser",
    profile: "browser",
    runtime: {
      browser: "chromium",
      persistentProfile: true,
      viewport: {
        width: 1280,
        height: 800,
      },
    },
  });

  expect(created.profile).toBe("browser");
  if (created.profile !== "browser") {
    throw new TypeError("Expected browser detail");
  }
  expect(created.runtime.browser).toBe("chromium");
  expect(created.runtime.profileDirectory).toContain("research-browser");
  expect(created.runtime.display.viewport).toEqual({
    width: 1280,
    height: 800,
  });
});

test("updates browser viewport and persists it across detail reads", async () => {
  const metadataStore = createMemoryMetadataStore();
  const runtime = createMemoryRuntime("/tmp/computerd-test-terminals");
  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
      COMPUTERD_BROWSER_RUNTIME_DIR: "/tmp/computerd-test-browsers",
      COMPUTERD_BROWSER_STATE_DIR: "/tmp/computerd-test-browser-state",
    },
    { metadataStore, runtime },
  );

  await controlPlane.createComputer({
    name: "research-browser",
    profile: "browser",
    runtime: {
      browser: "chromium",
      persistentProfile: true,
    },
  });

  const updated = await controlPlane.updateBrowserViewport("research-browser", {
    width: 1600,
    height: 1000,
  });

  expect(updated.profile).toBe("browser");
  if (updated.profile !== "browser") {
    throw new TypeError("Expected browser detail");
  }

  expect(updated.runtime.display.viewport).toEqual({
    width: 1600,
    height: 1000,
  });

  const detail = await controlPlane.getComputer("research-browser");
  expect(detail.profile).toBe("browser");
  if (detail.profile !== "browser") {
    throw new TypeError("Expected browser detail");
  }

  expect(detail.runtime.display.viewport).toEqual({
    width: 1600,
    height: 1000,
  });
});

test("deletes a running computer by stopping runtime and removing metadata", async () => {
  const metadataStore = createMemoryMetadataStore();
  const runtime = createMemoryRuntime("/tmp/computerd-test-terminals");
  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
      COMPUTERD_TERMINAL_RUNTIME_DIR: "/tmp/computerd-test-terminals",
    },
    { metadataStore, runtime },
  );

  await controlPlane.createComputer({
    name: "lab-terminal",
    profile: "terminal",
    runtime: {
      execStart: "/usr/bin/bash",
    },
  });
  await controlPlane.startComputer("lab-terminal");

  await controlPlane.deleteComputer("lab-terminal");

  await expect(controlPlane.getComputer("lab-terminal")).rejects.toBeInstanceOf(
    ComputerNotFoundError,
  );
});

test("returns lightweight host inspect objects", async () => {
  const controlPlane = createControlPlane({ COMPUTERD_RUNTIME_MODE: "development" });

  const hostUnits = await controlPlane.listHostUnits();
  const docker = await controlPlane.getHostUnit("docker.service");

  expect(hostUnits).toEqual(
    expect.arrayContaining([expect.objectContaining({ unitName: "docker.service" })]),
  );
  expect(docker.execStart).toContain("dockerd");
});

test("development console sessions attach to a local bash shell without requiring running state", async () => {
  const controlPlane = createControlPlane({ COMPUTERD_RUNTIME_MODE: "development" });

  await expect(controlPlane.createConsoleSession("starter-terminal")).resolves.toMatchObject({
    computerName: "starter-terminal",
    protocol: "ttyd",
  });

  const lease = await controlPlane.openConsoleAttach("starter-terminal");
  expect(lease).toMatchObject({
    command: "/bin/bash",
    args: ["-i", "-l"],
    computerName: "starter-terminal",
  });
  lease.release();
});

test("rejects duplicate names and unknown computers", async () => {
  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
    },
    {
      metadataStore: createMemoryMetadataStore(),
      runtime: createMemoryRuntime("/tmp/computerd-test-terminals"),
    },
  );
  await controlPlane.createComputer({
    name: "lab-terminal",
    profile: "terminal",
    runtime: {
      execStart: "/usr/bin/bash",
    },
  });

  await expect(
    controlPlane.createComputer({
      name: "lab-terminal",
      profile: "terminal",
      runtime: {
        execStart: "/usr/bin/bash",
      },
    }),
  ).rejects.toBeInstanceOf(ComputerConflictError);

  await expect(controlPlane.getComputer("missing")).rejects.toBeInstanceOf(ComputerNotFoundError);
});

test("creates browser automation, monitor, screenshot, and console sessions from seeded capabilities", async () => {
  const metadataStore = createMemoryMetadataStore();
  const runtime = createMemoryRuntime("/tmp/computerd-test-terminals");
  await metadataStore.putComputer(createBrowserComputerRecord());
  const terminalRecord = createTerminalComputerRecord();
  await metadataStore.putComputer(terminalRecord);
  await runtime.createPersistentUnit(createBrowserComputerRecord());
  await runtime.createPersistentUnit(terminalRecord);

  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
      COMPUTERD_TERMINAL_RUNTIME_DIR: "/tmp/computerd-test-terminals",
    },
    { metadataStore, runtime },
  );

  await controlPlane.startComputer("research-browser");
  const monitorSession = await controlPlane.createMonitorSession("research-browser");
  const audioSession = await controlPlane.createAudioSession("research-browser");
  const automationSession = await controlPlane.createAutomationSession("research-browser");
  const screenshot = await controlPlane.createScreenshot("research-browser");
  await controlPlane.startComputer("starter-terminal");
  await ensureSocket("/tmp/computerd-test-terminals", "starter-terminal");
  const consoleSession = await controlPlane.createConsoleSession("starter-terminal");

  expect(monitorSession).toMatchObject({
    computerName: "research-browser",
    protocol: "vnc",
    connect: {
      mode: "relative-websocket-path",
      url: "/api/computers/research-browser/monitor/ws",
    },
  });
  expect(automationSession).toMatchObject({
    computerName: "research-browser",
    protocol: "cdp",
    connect: {
      mode: "relative-websocket-path",
      url: "/api/computers/research-browser/automation/ws",
    },
  });
  expect(audioSession).toMatchObject({
    computerName: "research-browser",
    protocol: "http-audio-stream",
    connect: {
      mode: "relative-websocket-path",
      url: "/api/computers/research-browser/audio",
    },
    mimeType: "audio/ogg",
  });
  expect(screenshot).toMatchObject({
    computerName: "research-browser",
    format: "png",
    mimeType: "image/png",
  });
  expect(consoleSession).toMatchObject({
    computerName: "starter-terminal",
    protocol: "ttyd",
    connect: {
      mode: "relative-websocket-path",
      url: "/api/computers/starter-terminal/console/ws",
    },
  });
});

test("waits for terminal console runtime readiness during start", async () => {
  const metadataStore = createMemoryMetadataStore();
  const terminalRecord = createTerminalComputerRecord();
  await metadataStore.putComputer(terminalRecord);
  const runtimeDirectory = "/tmp/computerd-delayed-terminals";
  await cleanupSocket(runtimeDirectory, terminalRecord.name);

  const runtime: ComputerRuntimePort = {
    async deleteBrowserRuntimeIdentity() {},
    async ensureBrowserRuntimeIdentity() {},
    async prepareBrowserRuntime() {},
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
      };
    },
    async createAudioSession(computer) {
      return {
        computerName: computer.name,
        protocol: "http-audio-stream",
        connect: {
          mode: "relative-websocket-path",
          url: `/api/computers/${encodeURIComponent(computer.name)}/audio`,
        },
        authorization: {
          mode: "none",
        },
        mimeType: "audio/ogg",
      };
    },
    async createMonitorSession(computer) {
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
      };
    },
    async createPersistentUnit(computer) {
      return {
        unitName: computer.unitName,
        description: computer.description,
        unitType: "service",
        loadState: "loaded",
        activeState: "inactive",
        subState: "dead",
        execStart:
          computer.profile === "terminal" ? computer.runtime.execStart : "/usr/bin/bash -lc",
      };
    },
    async createScreenshot(computer) {
      return {
        computerName: computer.name,
        format: "png",
        mimeType: "image/png",
        capturedAt: new Date().toISOString(),
        width: 1440,
        height: 900,
        dataBase64: Buffer.from("screenshot").toString("base64"),
      };
    },
    async deletePersistentUnit() {},
    async getRuntimeState() {
      return runtimeState;
    },
    async getHostUnit() {
      return null;
    },
    async listHostUnits() {
      return [];
    },
    async openAutomationAttach(computer) {
      return {
        computerName: computer.name,
        url: "ws://127.0.0.1:9222/devtools/browser/test",
        release() {},
      };
    },
    async openAudioStream(computer) {
      return {
        computerName: computer.name,
        command: "ffmpeg",
        args: ["-f", "ogg", "pipe:1"],
        targetSelector: `computerd.computer.name=${computer.name}`,
        release() {},
      };
    },
    async openMonitorAttach(computer) {
      return {
        computerName: computer.name,
        host: "127.0.0.1",
        port: 5900,
        release() {},
      };
    },
    async restartUnit() {
      return runtimeState;
    },
    async startUnit() {
      setTimeout(() => {
        void ensureSocket(runtimeDirectory, terminalRecord.name);
      }, 150);

      return runtimeState;
    },
    async stopUnit() {
      return runtimeState;
    },
    async updateBrowserViewport() {},
  };
  const runtimeState: UnitRuntimeState = {
    unitName: terminalRecord.unitName,
    description: terminalRecord.description,
    unitType: "service",
    loadState: "loaded",
    activeState: "active",
    subState: "running",
    execStart: terminalRecord.runtime.execStart,
  };

  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
      COMPUTERD_TERMINAL_RUNTIME_DIR: runtimeDirectory,
    },
    { metadataStore, runtime },
  );

  const started = await controlPlane.startComputer("starter-terminal");

  expect(started.state).toBe("running");
  await expect(controlPlane.createConsoleSession("starter-terminal")).resolves.toMatchObject({
    computerName: "starter-terminal",
  });
});

test("rejects sessions for unsupported capabilities", async () => {
  const metadataStore = createMemoryMetadataStore();
  await metadataStore.putComputer(createTerminalComputerRecord());
  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
    },
    { metadataStore, runtime: createMemoryRuntime("/tmp/computerd-test-terminals") },
  );

  await expect(controlPlane.createMonitorSession("starter-terminal")).rejects.toBeInstanceOf(Error);
  await expect(controlPlane.createAudioSession("starter-terminal")).rejects.toBeInstanceOf(Error);
  await expect(controlPlane.createConsoleSession("starter-terminal")).rejects.toBeInstanceOf(
    ComputerConsoleUnavailableError,
  );
});

test("acquires and releases a single active console attach", async () => {
  const metadataStore = createMemoryMetadataStore();
  const runtime = createMemoryRuntime("/tmp/computerd-test-terminals");
  const terminalRecord = createTerminalComputerRecord();
  await metadataStore.putComputer(terminalRecord);
  await runtime.createPersistentUnit(terminalRecord);
  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
      COMPUTERD_TERMINAL_RUNTIME_DIR: "/tmp/computerd-test-terminals",
    },
    { metadataStore, runtime },
  );
  await controlPlane.startComputer("starter-terminal");

  const lease = await controlPlane.openConsoleAttach("starter-terminal");
  expect(lease.command).toBe("tmux");
  await expect(controlPlane.openConsoleAttach("starter-terminal")).rejects.toBeInstanceOf(
    ComputerConsoleUnavailableError,
  );
  lease.release();

  await expect(controlPlane.openConsoleAttach("starter-terminal")).resolves.toMatchObject({
    computerName: "starter-terminal",
  });
});

function createMemoryMetadataStore(): ComputerMetadataStore {
  const records = new Map<string, PersistedComputer>();

  return {
    async deleteComputer(name) {
      records.delete(name);
    },
    async getComputer(name) {
      return records.get(name) ?? null;
    },
    async listComputers() {
      return [...records.values()];
    },
    async putComputer(computer) {
      records.set(computer.name, structuredClone(computer));
    },
  };
}

function createBrowserComputerRecord(): PersistedComputer {
  return {
    name: "research-browser",
    unitName: "computerd-research-browser.service",
    profile: "browser",
    description: "Seeded browser computer",
    createdAt: "2026-03-09T08:00:00.000Z",
    lastActionAt: "2026-03-09T08:00:00.000Z",
    access: {
      display: {
        mode: "virtual-display",
      },
      logs: true,
    },
    resources: {},
    storage: {
      rootMode: "persistent",
    },
    network: {
      mode: "host",
    },
    lifecycle: {},
    runtime: {
      browser: "chromium",
      persistentProfile: true,
      runtimeUser: "computerd-b-research-browser",
    },
  };
}

function createTerminalComputerRecord(): PersistedTerminalComputer {
  return {
    name: "starter-terminal",
    unitName: "computerd-starter-terminal.service",
    profile: "terminal",
    description: "Seeded terminal computer",
    createdAt: "2026-03-09T08:00:00.000Z",
    lastActionAt: "2026-03-09T08:00:00.000Z",
    access: {
      console: {
        mode: "pty",
        writable: true,
      },
      logs: true,
    },
    resources: {},
    storage: {
      rootMode: "persistent",
    },
    network: {
      mode: "host",
    },
    lifecycle: {},
    runtime: {
      execStart: "/usr/bin/bash",
    },
  };
}

function createMemoryRuntime(runtimeDirectory: string): ComputerRuntimePort {
  const states = new Map<string, UnitRuntimeState>();
  const browserViewports = new Map<string, { width: number; height: number }>();

  return {
    async deleteBrowserRuntimeIdentity() {},
    async ensureBrowserRuntimeIdentity() {},
    async prepareBrowserRuntime() {},
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
      };
    },
    async createAudioSession(computer) {
      return {
        computerName: computer.name,
        protocol: "http-audio-stream",
        connect: {
          mode: "relative-websocket-path",
          url: `/api/computers/${encodeURIComponent(computer.name)}/audio`,
        },
        authorization: {
          mode: "none",
        },
        mimeType: "audio/ogg",
      };
    },
    async createMonitorSession(computer) {
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
        viewport: {
          width:
            browserViewports.get(computer.unitName)?.width ??
            computer.runtime.viewport?.width ??
            1440,
          height:
            browserViewports.get(computer.unitName)?.height ??
            computer.runtime.viewport?.height ??
            900,
        },
      };
    },
    async createPersistentUnit(computer) {
      if (computer.profile === "browser") {
        browserViewports.set(
          computer.unitName,
          computer.runtime.viewport ?? { width: 1440, height: 900 },
        );
      }

      const state: UnitRuntimeState = {
        unitName: computer.unitName,
        description: computer.description,
        unitType: "service",
        loadState: "loaded",
        activeState: "inactive",
        subState: "dead",
        execStart:
          computer.profile === "terminal" ? computer.runtime.execStart : "/usr/bin/bash -lc",
        workingDirectory:
          computer.profile === "terminal" ? computer.runtime.workingDirectory : runtimeDirectory,
        environment: computer.profile === "terminal" ? computer.runtime.environment : undefined,
        cpuWeight: computer.resources.cpuWeight,
        memoryMaxMiB: computer.resources.memoryMaxMiB,
      };
      states.set(computer.unitName, state);
      return state;
    },
    async createScreenshot(computer) {
      const viewport = browserViewports.get(computer.unitName) ?? { width: 1440, height: 900 };
      return {
        computerName: computer.name,
        format: "png",
        mimeType: "image/png",
        capturedAt: new Date().toISOString(),
        width: viewport.width,
        height: viewport.height,
        dataBase64: Buffer.from(`screenshot:${computer.name}`).toString("base64"),
      };
    },
    async deletePersistentUnit(unitName) {
      await cleanupSocket(runtimeDirectory, unitNameToComputerName(unitName));
      states.delete(unitName);
    },
    async getRuntimeState(unitName) {
      return states.get(unitName) ?? null;
    },
    async getHostUnit() {
      return null;
    },
    async listHostUnits() {
      return [];
    },
    async openAutomationAttach(computer) {
      return {
        computerName: computer.name,
        url: `ws://127.0.0.1:9222/devtools/browser/${computer.name}`,
        release() {},
      };
    },
    async openAudioStream(computer) {
      return {
        computerName: computer.name,
        command: "ffmpeg",
        args: ["-f", "ogg", "pipe:1"],
        targetSelector: `computerd.computer.name=${computer.name}`,
        release() {},
      };
    },
    async openMonitorAttach(computer) {
      return {
        computerName: computer.name,
        host: "127.0.0.1",
        port: 5900,
        release() {},
      };
    },
    async restartUnit(unitName) {
      const state = requireState(states, unitName);
      if (state.execStart !== "/usr/bin/bash -lc") {
        await ensureSocket(runtimeDirectory, unitNameToComputerName(unitName));
      }
      state.activeState = "active";
      state.subState = "running";
      return state;
    },
    async startUnit(unitName) {
      const state = requireState(states, unitName);
      if (state.execStart !== "/usr/bin/bash -lc") {
        await ensureSocket(runtimeDirectory, unitNameToComputerName(unitName));
      }
      state.activeState = "active";
      state.subState = "running";
      return state;
    },
    async stopUnit(unitName) {
      const state = requireState(states, unitName);
      await cleanupSocket(runtimeDirectory, unitNameToComputerName(unitName));
      state.activeState = "inactive";
      state.subState = "dead";
      return state;
    },
    async updateBrowserViewport(computer, viewport) {
      browserViewports.set(computer.unitName, viewport);
    },
  };
}

function requireState(states: Map<string, UnitRuntimeState>, unitName: string) {
  const state = states.get(unitName);
  if (!state) {
    throw new ComputerNotFoundError(unitName);
  }

  return state;
}

async function ensureSocket(runtimeDirectory: string, computerName: string) {
  const directory = join(runtimeDirectory, computerName);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "tmux.sock"), "");
}

async function cleanupSocket(runtimeDirectory: string, computerName: string) {
  await rm(join(runtimeDirectory, computerName), { recursive: true, force: true });
}

function unitNameToComputerName(unitName: string) {
  return unitName.replace(/^computerd-/, "").replace(/\.service$/, "");
}
