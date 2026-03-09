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
  UnsupportedComputerFeatureError,
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

test("rejects unsupported browser computers", async () => {
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

  await expect(
    controlPlane.createComputer({
      name: "research-browser",
      profile: "browser",
      runtime: {
        browser: "chromium",
        persistentProfile: true,
      },
    }),
  ).rejects.toBeInstanceOf(UnsupportedComputerFeatureError);
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

test("creates stub monitor and console sessions from seeded capabilities", async () => {
  const metadataStore = createMemoryMetadataStore();
  const runtime = createMemoryRuntime("/tmp/computerd-test-terminals");
  await metadataStore.putComputer(createBrowserComputerRecord());
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

  const monitorSession = await controlPlane.createMonitorSession("research-browser");
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
  expect(consoleSession).toMatchObject({
    computerName: "starter-terminal",
    protocol: "ttyd",
    connect: {
      mode: "relative-websocket-path",
      url: "/api/computers/starter-terminal/console/ws",
    },
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

  await expect(controlPlane.createMonitorSession("starter-terminal")).rejects.toBeInstanceOf(
    UnsupportedComputerFeatureError,
  );
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
      startUrl: "https://example.com",
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

  return {
    async createPersistentUnit(computer) {
      await ensureSocket(runtimeDirectory, computer.name);
      const state: UnitRuntimeState = {
        unitName: computer.unitName,
        description: computer.description,
        unitType: "service",
        loadState: "loaded",
        activeState: "inactive",
        subState: "dead",
        execStart: computer.runtime.execStart,
        workingDirectory: computer.runtime.workingDirectory,
        environment: computer.runtime.environment,
        cpuWeight: computer.resources.cpuWeight,
        memoryMaxMiB: computer.resources.memoryMaxMiB,
      };
      states.set(computer.unitName, state);
      return state;
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
    async restartUnit(unitName) {
      const state = requireState(states, unitName);
      await ensureSocket(runtimeDirectory, unitNameToComputerName(unitName));
      state.activeState = "active";
      state.subState = "running";
      return state;
    },
    async startUnit(unitName) {
      const state = requireState(states, unitName);
      await ensureSocket(runtimeDirectory, unitNameToComputerName(unitName));
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
