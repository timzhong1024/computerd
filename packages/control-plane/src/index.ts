import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  createComputerCapabilities,
  type BrowserRuntime,
  type ComputerConsoleSession,
  type ComputerDetail,
  type ComputerMonitorSession,
  type ComputerSummary,
  type CreateBrowserComputerInput,
  type CreateComputerInput,
  type CreateTerminalComputerInput,
  type HostUnitDetail,
  type HostUnitSummary,
  type TerminalRuntime,
} from "@computerd/core";
import { createConsoleRuntimePaths } from "./systemd/console-runtime";
import { createFileComputerMetadataStore } from "./systemd/metadata-store";
import { createSystemdRuntime } from "./systemd/runtime";
import type {
  ConsoleAttachLease,
  ComputerMetadataStore,
  ComputerRuntimePort,
  PersistedBrowserComputer,
  PersistedComputer,
  PersistedTerminalComputer,
  UnitRuntimeState,
} from "./systemd/types";

export class ComputerConflictError extends Error {
  constructor(name: string) {
    super(`Computer "${name}" already exists.`);
    this.name = "ComputerConflictError";
  }
}

export class ComputerNotFoundError extends Error {
  constructor(name: string) {
    super(`Computer "${name}" was not found.`);
    this.name = "ComputerNotFoundError";
  }
}

export class HostUnitNotFoundError extends Error {
  constructor(unitName: string) {
    super(`Host unit "${unitName}" was not found.`);
    this.name = "HostUnitNotFoundError";
  }
}

export class UnsupportedComputerFeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedComputerFeatureError";
  }
}

export class ComputerConsoleUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputerConsoleUnavailableError";
  }
}

export interface ControlPlane {
  createConsoleSession: (name: string) => Promise<ComputerConsoleSession>;
  createComputer: (input: CreateComputerInput) => Promise<ComputerDetail>;
  createMonitorSession: (name: string) => Promise<ComputerMonitorSession>;
  deleteComputer: (name: string) => Promise<void>;
  getComputer: (name: string) => Promise<ComputerDetail>;
  listComputers: () => Promise<ComputerSummary[]>;
  listHostUnits: () => Promise<HostUnitSummary[]>;
  getHostUnit: (unitName: string) => Promise<HostUnitDetail>;
  restartComputer: (name: string) => Promise<ComputerDetail>;
  startComputer: (name: string) => Promise<ComputerDetail>;
  stopComputer: (name: string) => Promise<ComputerDetail>;
  openConsoleAttach: (name: string) => Promise<ConsoleAttachLease>;
}

export interface CreateControlPlaneOptions {
  metadataStore?: ComputerMetadataStore;
  runtime?: ComputerRuntimePort;
}

type ComputerdRuntimeMode = "development" | "systemd";

export function createControlPlane(
  environment: NodeJS.ProcessEnv = process.env,
  options: CreateControlPlaneOptions = {},
): ControlPlane {
  const usesDefaultPersistence =
    options.metadataStore === undefined && options.runtime === undefined;
  if (resolveRuntimeMode(environment) === "development") {
    return createDevelopmentControlPlane();
  }

  const metadataStore =
    options.metadataStore ??
    createFileComputerMetadataStore({
      directory: environment.COMPUTERD_METADATA_DIR ?? "/var/lib/computerd/computers",
    });
  const consoleRuntimePaths = createConsoleRuntimePaths({
    runtimeDirectory: environment.COMPUTERD_TERMINAL_RUNTIME_DIR ?? "/run/computerd/terminals",
  });
  const runtime =
    options.runtime ??
    createSystemdRuntime({
      unitFileStoreOptions: {
        directory: environment.COMPUTERD_UNIT_DIR ?? "/etc/systemd/system",
        terminalRuntimeDirectory: consoleRuntimePaths.runtimeDirectory,
      },
    });
  const activeConsoleAttaches = new Set<string>();

  return {
    async listComputers() {
      const records = await metadataStore.listComputers();
      const summaries = await Promise.all(
        records.map((record) => toComputerSummary(record, runtime)),
      );
      return summaries.sort(compareByName);
    },
    async getComputer(name) {
      const record = await requireComputer(metadataStore, name);
      return await toComputerDetail(record, runtime);
    },
    async createComputer(input) {
      assertSupportedCreateInput(input);
      if (usesDefaultPersistence) {
        await ensureDirectories(environment);
      }
      const unitName = toUnitName(input.name);
      const records = await metadataStore.listComputers();
      if (records.some((record) => record.name === input.name || record.unitName === unitName)) {
        throw new ComputerConflictError(input.name);
      }
      if ((await runtime.getRuntimeState(unitName)) !== null) {
        throw new ComputerConflictError(input.name);
      }

      const record = createPersistedComputer(input);
      if (record.profile !== "terminal") {
        throw new UnsupportedComputerFeatureError(
          `Computer profile "${record.profile}" is not supported in the DBus runtime yet.`,
        );
      }
      await runtime.createPersistentUnit(record);
      await metadataStore.putComputer(record);
      return await toComputerDetail(record, runtime);
    },
    async createMonitorSession(name) {
      const record = await requireComputer(metadataStore, name);
      if (record.access.display?.mode !== "virtual-display") {
        throw new UnsupportedComputerFeatureError(
          `Computer "${name}" does not support monitor sessions.`,
        );
      }

      return createStubMonitorSession(record.name);
    },
    async createConsoleSession(name) {
      const record = await requireComputer(metadataStore, name);
      if (record.profile !== "terminal") {
        throw new UnsupportedComputerFeatureError(
          `Computer "${name}" does not support console sessions.`,
        );
      }
      if (record.access.console?.mode !== "pty") {
        throw new UnsupportedComputerFeatureError(
          `Computer "${name}" does not support console sessions.`,
        );
      }

      await requireConsoleAvailable(record, runtime, consoleRuntimePaths);
      return createConsoleSession(record.name);
    },
    async openConsoleAttach(name) {
      const record = await requireComputer(metadataStore, name);
      if (record.profile !== "terminal") {
        throw new UnsupportedComputerFeatureError(
          `Computer "${name}" does not support console sessions.`,
        );
      }
      if (record.access.console?.mode !== "pty") {
        throw new UnsupportedComputerFeatureError(
          `Computer "${name}" does not support console sessions.`,
        );
      }

      await requireConsoleAvailable(record, runtime, consoleRuntimePaths);
      if (activeConsoleAttaches.has(name)) {
        throw new ComputerConsoleUnavailableError(
          `Computer "${name}" already has an active console connection.`,
        );
      }

      activeConsoleAttaches.add(name);
      const spec = consoleRuntimePaths.specForComputer(record);
      return {
        command: "tmux",
        args: ["-S", spec.socketPath, "attach-session", "-t", spec.sessionName],
        computerName: name,
        release() {
          activeConsoleAttaches.delete(name);
        },
      };
    },
    async deleteComputer(name) {
      const record = await requireComputer(metadataStore, name);
      await runtime.deletePersistentUnit(record.unitName);
      if (record.profile === "terminal") {
        await consoleRuntimePaths.cleanupComputerDirectory(record);
      }
      await metadataStore.deleteComputer(name);
    },
    async startComputer(name) {
      const record = await requireComputer(metadataStore, name);
      await runtime.startUnit(record.unitName);
      if (record.profile === "terminal") {
        await waitForConsoleRuntimeReady(record, runtime, consoleRuntimePaths);
      }
      const updated = {
        ...record,
        lastActionAt: new Date().toISOString(),
      } satisfies PersistedComputer;
      await metadataStore.putComputer(updated);
      return await toComputerDetail(updated, runtime);
    },
    async stopComputer(name) {
      const record = await requireComputer(metadataStore, name);
      await runtime.stopUnit(record.unitName);
      const updated = {
        ...record,
        lastActionAt: new Date().toISOString(),
      } satisfies PersistedComputer;
      await metadataStore.putComputer(updated);
      return await toComputerDetail(updated, runtime);
    },
    async restartComputer(name) {
      const record = await requireComputer(metadataStore, name);
      await runtime.restartUnit(record.unitName);
      if (record.profile === "terminal") {
        await waitForConsoleRuntimeReady(record, runtime, consoleRuntimePaths);
      }
      const updated = {
        ...record,
        lastActionAt: new Date().toISOString(),
      } satisfies PersistedComputer;
      await metadataStore.putComputer(updated);
      return await toComputerDetail(updated, runtime);
    },
    async listHostUnits() {
      return await runtime.listHostUnits();
    },
    async getHostUnit(unitName) {
      const detail = await runtime.getHostUnit(unitName);
      if (detail === null) {
        throw new HostUnitNotFoundError(unitName);
      }

      return detail;
    },
  };
}

function createPersistedComputer(input: CreateComputerInput): PersistedComputer {
  const timestamp = new Date().toISOString();
  const common = {
    name: input.name,
    unitName: toUnitName(input.name),
    description: input.description,
    createdAt: timestamp,
    lastActionAt: timestamp,
    profile: input.profile,
    access:
      input.access ??
      (input.profile === "terminal"
        ? {
            console: {
              mode: "pty" as const,
              writable: true,
            },
            logs: true,
          }
        : {
            display: {
              mode: "virtual-display" as const,
            },
            logs: true,
          }),
    resources: {
      cpuWeight: input.resources?.cpuWeight,
      memoryMaxMiB: input.resources?.memoryMaxMiB,
    },
    storage: input.storage ?? {
      rootMode: "persistent" as const,
    },
    network: input.network ?? {
      mode: "host" as const,
    },
    lifecycle: input.lifecycle ?? {},
  };

  if (input.profile === "terminal") {
    return {
      ...common,
      profile: "terminal",
      runtime: input.runtime,
    };
  }

  return {
    ...common,
    profile: "browser",
    runtime: input.runtime,
  };
}

async function requireComputer(metadataStore: ComputerMetadataStore, name: string) {
  const record = await metadataStore.getComputer(name);
  if (record === null) {
    throw new ComputerNotFoundError(name);
  }

  return record;
}

async function requireConsoleAvailable(
  record: PersistedTerminalComputer,
  runtime: ComputerRuntimePort,
  consoleRuntimePaths: ReturnType<typeof createConsoleRuntimePaths>,
) {
  const isReady = await waitForConsoleRuntimeReady(record, runtime, consoleRuntimePaths, 3_000);
  if (!isReady) {
    const runtimeState = await runtime.getRuntimeState(record.unitName);
    if (mapComputerState(runtimeState) !== "running") {
      throw new ComputerConsoleUnavailableError(
        `Computer "${record.name}" must be running before opening a console.`,
      );
    }

    throw new ComputerConsoleUnavailableError(
      `Computer "${record.name}" console runtime is not ready yet.`,
    );
  }
}

async function waitForConsoleRuntimeReady(
  record: PersistedTerminalComputer,
  runtime: ComputerRuntimePort,
  consoleRuntimePaths: ReturnType<typeof createConsoleRuntimePaths>,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const runtimeState = await runtime.getRuntimeState(record.unitName);
    if (mapComputerState(runtimeState) !== "running") {
      return false;
    }

    if (await consoleRuntimePaths.hasSocket(record)) {
      return true;
    }

    await delay(100);
  }

  return false;
}

async function toComputerSummary(
  record: PersistedComputer,
  runtime: ComputerRuntimePort,
): Promise<ComputerSummary> {
  const state = mapComputerState(await runtime.getRuntimeState(record.unitName));
  return {
    name: record.name,
    unitName: record.unitName,
    profile: record.profile,
    state,
    description: record.description,
    createdAt: record.createdAt,
    access: record.access,
    capabilities: createComputerCapabilities(record.profile, state),
  };
}

async function toComputerDetail(
  record: PersistedComputer,
  runtime: ComputerRuntimePort,
): Promise<ComputerDetail> {
  const runtimeState = await runtime.getRuntimeState(record.unitName);
  const summary = await toComputerSummary(record, runtime);
  const common = {
    ...summary,
    resources: {
      cpuWeight: runtimeState?.cpuWeight ?? record.resources.cpuWeight,
      memoryMaxMiB: runtimeState?.memoryMaxMiB ?? record.resources.memoryMaxMiB,
    },
    storage: record.storage,
    network: record.network,
    lifecycle: record.lifecycle,
    status: {
      lastActionAt: record.lastActionAt,
      primaryUnit: record.unitName,
    },
  };

  if (record.profile === "terminal") {
    return {
      ...common,
      profile: "terminal",
      runtime: {
        execStart: runtimeState?.execStart ?? record.runtime.execStart,
        workingDirectory: runtimeState?.workingDirectory ?? record.runtime.workingDirectory,
        environment: runtimeState?.environment ?? record.runtime.environment,
      },
    };
  }

  return {
    ...common,
    profile: "browser",
    runtime: record.runtime,
  };
}

function mapComputerState(runtimeState: UnitRuntimeState | null) {
  return runtimeState?.activeState === "active" ? ("running" as const) : ("stopped" as const);
}

function assertSupportedCreateInput(
  input: CreateComputerInput,
): asserts input is CreateTerminalComputerInput {
  if (input.profile !== "terminal") {
    throw new UnsupportedComputerFeatureError(
      `Computer profile "${input.profile}" is not supported in the DBus runtime yet.`,
    );
  }

  if (input.storage?.rootMode === "ephemeral") {
    throw new UnsupportedComputerFeatureError(
      '`storage.rootMode="ephemeral"` is not supported yet.',
    );
  }

  if (input.network?.mode === "isolated") {
    throw new UnsupportedComputerFeatureError('`network.mode="isolated"` is not supported yet.');
  }

  if (input.resources?.tasksMax !== undefined) {
    throw new UnsupportedComputerFeatureError(
      "`resources.tasksMax` is not wired to the DBus runtime yet.",
    );
  }
}

function toUnitName(name: string) {
  return `computerd-${slugify(name)}.service`;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function compareByName(left: ComputerSummary, right: ComputerSummary) {
  return left.name.localeCompare(right.name);
}

function createStubMonitorSession(name: string): ComputerMonitorSession {
  return {
    computerName: name,
    protocol: "vnc",
    connect: {
      mode: "relative-websocket-path",
      url: `/api/computers/${encodeURIComponent(name)}/monitor/ws`,
    },
    authorization: {
      mode: "ticket",
      ticket: "stub-ticket",
    },
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    viewport: {
      width: 1440,
      height: 900,
    },
  };
}

function createConsoleSession(name: string): ComputerConsoleSession {
  return {
    computerName: name,
    protocol: "ttyd",
    connect: {
      mode: "relative-websocket-path",
      url: `/api/computers/${encodeURIComponent(name)}/console/ws`,
    },
    authorization: {
      mode: "none",
    },
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
}

async function ensureDirectories(environment: NodeJS.ProcessEnv) {
  const paths = [
    environment.COMPUTERD_METADATA_DIR ?? "/var/lib/computerd/computers",
    environment.COMPUTERD_UNIT_DIR ?? "/etc/systemd/system",
    environment.COMPUTERD_TERMINAL_RUNTIME_DIR ?? "/run/computerd/terminals",
  ];

  await Promise.all(paths.map((path) => mkdir(path, { recursive: true })));
}

function resolveRuntimeMode(environment: NodeJS.ProcessEnv): ComputerdRuntimeMode {
  return environment.COMPUTERD_RUNTIME_MODE === "development" ? "development" : "systemd";
}

function createDevelopmentControlPlane(): ControlPlane {
  const hostUnits: HostUnitDetail[] = [
    {
      unitName: "docker.service",
      unitType: "service",
      state: "active",
      description: "Docker Engine",
      capabilities: {
        canInspect: true,
      },
      execStart: "/usr/bin/dockerd --host=fd://",
      status: {
        activeState: "active",
        subState: "running",
        loadState: "loaded",
      },
      recentLogs: [],
    },
  ];
  const records = new Map<string, PersistedComputer>();
  const seeded = createPersistedComputer({
    name: "starter-terminal",
    profile: "terminal",
    description: "Development terminal computer for local coding and smoke tests.",
    runtime: {
      execStart: "/usr/bin/bash -i -l",
    },
    access: {
      console: {
        mode: "pty",
        writable: true,
      },
      logs: true,
    },
  });
  if (seeded.profile !== "terminal") {
    throw new TypeError("Expected development seed to be terminal.");
  }
  records.set(seeded.name, seeded);
  const runtimeStates = new Map<string, UnitRuntimeState>([
    [
      seeded.unitName,
      {
        unitName: seeded.unitName,
        description: seeded.description,
        unitType: "service",
        loadState: "loaded",
        activeState: "inactive",
        subState: "dead",
        execStart: seeded.runtime.execStart,
      },
    ],
  ]);
  const consoleRuntimePaths = createConsoleRuntimePaths({
    runtimeDirectory: "/tmp/computerd-development-terminals",
  });
  const activeConsoleAttaches = new Set<string>();

  const runtime: ComputerRuntimePort = {
    async createPersistentUnit(computer) {
      await ensureDevelopmentConsoleSocket(consoleRuntimePaths, computer);
      runtimeStates.set(computer.unitName, {
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
      });
      return runtimeStates.get(computer.unitName)!;
    },
    async deletePersistentUnit(unitName) {
      const record = [...records.values()].find((entry) => entry.unitName === unitName);
      if (record?.profile === "terminal") {
        await cleanupDevelopmentConsoleRuntime(consoleRuntimePaths, record);
      }
      runtimeStates.delete(unitName);
    },
    async getRuntimeState(unitName) {
      return runtimeStates.get(unitName) ?? null;
    },
    async listHostUnits() {
      return hostUnits.map((unit) => ({
        unitName: unit.unitName,
        unitType: unit.unitType,
        state: unit.state,
        description: unit.description,
        capabilities: unit.capabilities,
      }));
    },
    async getHostUnit(unitName) {
      return hostUnits.find((unit) => unit.unitName === unitName) ?? null;
    },
    async restartUnit(unitName) {
      const state = runtimeStates.get(unitName);
      if (!state) {
        throw new ComputerNotFoundError(unitName);
      }

      state.activeState = "active";
      state.subState = "running";
      const record = [...records.values()].find((entry) => entry.unitName === unitName);
      if (record?.profile === "terminal") {
        await ensureDevelopmentConsoleSocket(consoleRuntimePaths, record);
      }
      return state;
    },
    async startUnit(unitName) {
      const state = runtimeStates.get(unitName);
      if (!state) {
        throw new ComputerNotFoundError(unitName);
      }

      state.activeState = "active";
      state.subState = "running";
      const record = [...records.values()].find((entry) => entry.unitName === unitName);
      if (record?.profile === "terminal") {
        await ensureDevelopmentConsoleSocket(consoleRuntimePaths, record);
      }
      return state;
    },
    async stopUnit(unitName) {
      const state = runtimeStates.get(unitName);
      if (!state) {
        throw new ComputerNotFoundError(unitName);
      }

      state.activeState = "inactive";
      state.subState = "dead";
      const record = [...records.values()].find((entry) => entry.unitName === unitName);
      if (record?.profile === "terminal") {
        await cleanupDevelopmentConsoleRuntime(consoleRuntimePaths, record);
      }
      return state;
    },
  };
  const metadataStore: ComputerMetadataStore = {
    async listComputers() {
      return [...records.values()];
    },
    async getComputer(name) {
      return records.get(name) ?? null;
    },
    async putComputer(computer) {
      records.set(computer.name, computer);
    },
    async deleteComputer(name) {
      records.delete(name);
    },
  };

  const controlPlane = createControlPlane(
    {
      ...process.env,
      COMPUTERD_RUNTIME_MODE: "systemd",
      COMPUTERD_TERMINAL_RUNTIME_DIR: consoleRuntimePaths.runtimeDirectory,
    },
    {
      metadataStore,
      runtime,
    },
  );

  return {
    ...controlPlane,
    async createConsoleSession(name) {
      const record = records.get(name);
      if (record === undefined) {
        throw new ComputerNotFoundError(name);
      }
      if (record.profile !== "terminal" || record.access.console?.mode !== "pty") {
        throw new UnsupportedComputerFeatureError(
          `Computer "${name}" does not support console sessions.`,
        );
      }

      await ensureDevelopmentConsoleSocket(consoleRuntimePaths, record);
      return createConsoleSession(record.name);
    },
    async openConsoleAttach(name) {
      const record = records.get(name);
      if (record === undefined) {
        throw new ComputerNotFoundError(name);
      }
      if (record.profile !== "terminal" || record.access.console?.mode !== "pty") {
        throw new UnsupportedComputerFeatureError(
          `Computer "${name}" does not support console sessions.`,
        );
      }

      if (activeConsoleAttaches.has(name)) {
        throw new ComputerConsoleUnavailableError(
          `Computer "${name}" already has an active console connection.`,
        );
      }

      activeConsoleAttaches.add(name);
      if (process.platform !== "darwin") {
        await ensureDevelopmentConsoleSocket(consoleRuntimePaths, record);
        const spec = consoleRuntimePaths.specForComputer(record);
        return {
          command: "tmux",
          args: ["-S", spec.socketPath, "attach-session", "-t", spec.sessionName],
          computerName: name,
          cwd: record.runtime.workingDirectory,
          env: record.runtime.environment,
          release() {
            activeConsoleAttaches.delete(name);
          },
        };
      }

      return {
        command: "/bin/bash",
        args: ["-i", "-l"],
        computerName: name,
        cwd: record.runtime.workingDirectory,
        env: record.runtime.environment,
        release() {
          activeConsoleAttaches.delete(name);
        },
      };
    },
  };
}

async function ensureDevelopmentConsoleSocket(
  consoleRuntimePaths: ReturnType<typeof createConsoleRuntimePaths>,
  computer: PersistedTerminalComputer,
) {
  const spec = await consoleRuntimePaths.ensureComputerDirectory(computer);
  if (process.platform !== "darwin") {
    ensureDevelopmentTmuxSession(spec, computer);
    return;
  }

  await writeFile(spec.socketPath, "");
}

async function cleanupDevelopmentConsoleRuntime(
  consoleRuntimePaths: ReturnType<typeof createConsoleRuntimePaths>,
  computer: PersistedTerminalComputer,
) {
  const spec = consoleRuntimePaths.specForComputer(computer);
  if (process.platform !== "darwin") {
    try {
      execFileSync("tmux", ["-S", spec.socketPath, "kill-session", "-t", spec.sessionName], {
        stdio: "ignore",
      });
    } catch {
      // Ignore missing development tmux sessions during cleanup.
    }
  }

  await consoleRuntimePaths.cleanupComputerDirectory(computer);
}

function ensureDevelopmentTmuxSession(
  spec: ReturnType<ReturnType<typeof createConsoleRuntimePaths>["specForComputer"]>,
  computer: PersistedTerminalComputer,
) {
  try {
    execFileSync("tmux", ["-S", spec.socketPath, "has-session", "-t", spec.sessionName], {
      stdio: "ignore",
    });
    return;
  } catch {
    // Create the session below when it does not exist yet.
  }

  const command = buildDevelopmentTmuxCommand(computer);
  execFileSync(
    "tmux",
    ["-S", spec.socketPath, "new-session", "-d", "-s", spec.sessionName, command],
    {
      stdio: "ignore",
    },
  );
}

function buildDevelopmentTmuxCommand(computer: PersistedTerminalComputer) {
  const segments = ["set -eu"];
  if (computer.runtime.workingDirectory) {
    segments.push(`cd ${escapeShellToken(computer.runtime.workingDirectory)}`);
  }

  if (computer.runtime.environment) {
    for (const [key, value] of Object.entries(computer.runtime.environment)) {
      segments.push(`export ${key}=${escapeShellToken(value)}`);
    }
  }

  segments.push(`exec ${computer.runtime.execStart}`);
  return segments.join("; ");
}

function escapeShellToken(value: string) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export type {
  BrowserRuntime,
  ConsoleAttachLease,
  ComputerConsoleSession,
  ComputerDetail,
  ComputerMonitorSession,
  ComputerSummary,
  CreateBrowserComputerInput,
  CreateComputerInput,
  CreateTerminalComputerInput,
  HostUnitDetail,
  HostUnitSummary,
  TerminalRuntime,
};
