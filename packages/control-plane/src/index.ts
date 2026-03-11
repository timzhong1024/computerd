import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  createComputerCapabilities,
  type ComputerAutomationSession,
  type ComputerAudioSession,
  type ComputerConsoleSession,
  type ComputerExecSession,
  type ComputerDetail,
  type ComputerMonitorSession,
  type ComputerScreenshot,
  type ComputerSummary,
  type CreateBrowserComputerInput,
  type CreateComputerInput,
  type CreateContainerComputerInput,
  type CreateHostComputerInput,
  type CreateVmComputerInput,
  type HostUnitDetail,
  type HostUnitSummary,
  type HostRuntime,
  type UpdateBrowserViewportInput,
} from "@computerd/core";
import { createDockerRuntime } from "./docker/runtime";
import {
  createBrowserRuntimeUser,
  createBrowserRuntimePaths,
  toBrowserRuntimeDetail,
  withBrowserViewport,
} from "./systemd/browser-runtime";
import { createConsoleRuntimePaths } from "./systemd/console-runtime";
import { createFileComputerMetadataStore } from "./systemd/metadata-store";
import { createSystemdRuntime } from "./systemd/runtime";
import {
  createVmRuntimePaths,
  toVmRuntimeDetail,
  withPersistedVmRuntime,
} from "./systemd/vm-runtime";
import type {
  BrowserAutomationLease,
  BrowserAudioStreamLease,
  BrowserMonitorLease,
  ConsoleAttachLease,
  ComputerMetadataStore,
  ComputerRuntimePort,
  PersistedBrowserComputer,
  PersistedComputer,
  PersistedContainerComputer,
  PersistedHostComputer,
  PersistedVmComputer,
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

export class BrokenComputerError extends Error {
  constructor(name: string, action: string) {
    super(`Computer "${name}" is broken because its backing runtime entity is missing. ${action}`);
    this.name = "BrokenComputerError";
  }
}

export interface ControlPlane {
  createAutomationSession: (name: string) => Promise<ComputerAutomationSession>;
  createAudioSession: (name: string) => Promise<ComputerAudioSession>;
  createConsoleSession: (name: string) => Promise<ComputerConsoleSession>;
  createExecSession: (name: string) => Promise<ComputerExecSession>;
  createComputer: (input: CreateComputerInput) => Promise<ComputerDetail>;
  createMonitorSession: (name: string) => Promise<ComputerMonitorSession>;
  createScreenshot: (name: string) => Promise<ComputerScreenshot>;
  deleteComputer: (name: string) => Promise<void>;
  getComputer: (name: string) => Promise<ComputerDetail>;
  listComputers: () => Promise<ComputerSummary[]>;
  listHostUnits: () => Promise<HostUnitSummary[]>;
  getHostUnit: (unitName: string) => Promise<HostUnitDetail>;
  openAutomationAttach: (name: string) => Promise<BrowserAutomationLease>;
  openAudioStream: (name: string) => Promise<BrowserAudioStreamLease>;
  openExecAttach: (name: string) => Promise<ConsoleAttachLease>;
  restartComputer: (name: string) => Promise<ComputerDetail>;
  openMonitorAttach: (name: string) => Promise<BrowserMonitorLease>;
  startComputer: (name: string) => Promise<ComputerDetail>;
  stopComputer: (name: string) => Promise<ComputerDetail>;
  openConsoleAttach: (name: string) => Promise<ConsoleAttachLease>;
  updateBrowserViewport: (
    name: string,
    input: UpdateBrowserViewportInput,
  ) => Promise<ComputerDetail>;
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
  const browserRuntimePaths = createBrowserRuntimePaths({
    runtimeRootDirectory: environment.COMPUTERD_BROWSER_RUNTIME_DIR ?? "/run/computerd/computers",
    stateRootDirectory: environment.COMPUTERD_BROWSER_STATE_DIR ?? "/var/lib/computerd/computers",
  });
  const vmRuntimePaths = createVmRuntimePaths({
    runtimeRootDirectory: environment.COMPUTERD_VM_RUNTIME_DIR ?? "/run/computerd/computers",
    stateRootDirectory: environment.COMPUTERD_VM_STATE_DIR ?? "/var/lib/computerd/computers",
  });
  const runtime =
    options.runtime ??
    createRuntimePort({
      dockerSocketPath: environment.COMPUTERD_DOCKER_SOCKET ?? "/var/run/docker.sock",
      systemdRuntime: createSystemdRuntime({
        unitFileStoreOptions: {
          directory: environment.COMPUTERD_UNIT_DIR ?? "/etc/systemd/system",
          browserRuntimeDirectory:
            environment.COMPUTERD_BROWSER_RUNTIME_DIR ?? "/run/computerd/computers",
          browserStateDirectory:
            environment.COMPUTERD_BROWSER_STATE_DIR ?? "/var/lib/computerd/computers",
          terminalRuntimeDirectory: consoleRuntimePaths.runtimeDirectory,
          vmRuntimeDirectory: environment.COMPUTERD_VM_RUNTIME_DIR ?? "/run/computerd/computers",
          vmStateDirectory: environment.COMPUTERD_VM_STATE_DIR ?? "/var/lib/computerd/computers",
          vmHostBridge: environment.COMPUTERD_VM_BRIDGE ?? "br0",
          vmIsolatedBridge: environment.COMPUTERD_VM_ISOLATED_BRIDGE,
        },
      }),
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
      return await toComputerDetail(
        record,
        runtime,
        browserRuntimePaths,
        vmRuntimePaths,
        environment,
      );
    },
    async createComputer(input) {
      assertSupportedCreateInput(input, environment);
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

      const record = await createPersistedComputer(input, runtime);
      if (record.profile === "browser") {
        await runtime.ensureBrowserRuntimeIdentity(record);
      }
      if (record.profile !== "container") {
        await runtime.createPersistentUnit(record);
      }
      await metadataStore.putComputer(record);
      return await toComputerDetail(
        record,
        runtime,
        browserRuntimePaths,
        vmRuntimePaths,
        environment,
      );
    },
    async createMonitorSession(name) {
      const record = await requireComputer(metadataStore, name);
      const monitorRecord = requireMonitorCapableRecord(record);
      await requireMonitorRunning(monitorRecord, runtime, "monitor sessions");
      return await runtime.createMonitorSession(monitorRecord);
    },
    async createAudioSession(name) {
      const record = await requireComputer(metadataStore, name);
      const browserRecord = requireBrowserRecord(record);
      await requireBrowserRunning(browserRecord, runtime, "audio sessions");
      return await runtime.createAudioSession(browserRecord);
    },
    async openMonitorAttach(name) {
      const record = await requireComputer(metadataStore, name);
      const monitorRecord = requireMonitorCapableRecord(record);
      await requireMonitorRunning(monitorRecord, runtime, "monitor sessions");
      return await runtime.openMonitorAttach(monitorRecord);
    },
    async openAudioStream(name) {
      const record = await requireComputer(metadataStore, name);
      const browserRecord = requireBrowserRecord(record);
      await requireBrowserRunning(browserRecord, runtime, "audio streams");
      return await runtime.openAudioStream(browserRecord);
    },
    async createAutomationSession(name) {
      const record = await requireComputer(metadataStore, name);
      const browserRecord = requireBrowserRecord(record);
      await requireBrowserRunning(browserRecord, runtime, "automation sessions");
      return await runtime.createAutomationSession(browserRecord);
    },
    async openAutomationAttach(name) {
      const record = await requireComputer(metadataStore, name);
      const browserRecord = requireBrowserRecord(record);
      await requireBrowserRunning(browserRecord, runtime, "automation sessions");
      return await runtime.openAutomationAttach(browserRecord);
    },
    async createScreenshot(name) {
      const record = await requireComputer(metadataStore, name);
      const browserRecord = requireBrowserRecord(record);
      await requireBrowserRunning(browserRecord, runtime, "screenshots");
      return await runtime.createScreenshot(browserRecord);
    },
    async createConsoleSession(name) {
      const record = requireConsoleCapableRecord(await requireComputer(metadataStore, name));
      if (!supportsConsoleSessions(record)) {
        throw new UnsupportedComputerFeatureError(
          `Computer "${name}" does not support console sessions.`,
        );
      }

      await requireConsoleAvailable(record, runtime, consoleRuntimePaths);
      return createConsoleSession(record.name);
    },
    async createExecSession(name) {
      const record = await requireComputer(metadataStore, name);
      const containerRecord = requireContainerRecord(record);
      await requireContainerRunning(containerRecord, runtime, "exec sessions");
      return createExecSession(record.name);
    },
    async openConsoleAttach(name) {
      const record = requireConsoleCapableRecord(await requireComputer(metadataStore, name));
      if (!supportsConsoleSessions(record)) {
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
      return createConsoleAttachLease(
        record,
        consoleRuntimePaths,
        environment,
        activeConsoleAttaches,
      );
    },
    async openExecAttach(name) {
      const record = await requireComputer(metadataStore, name);
      const containerRecord = requireContainerRecord(record);
      await requireContainerRunning(containerRecord, runtime, "exec sessions");
      return createContainerExecLease(containerRecord, environment);
    },
    async deleteComputer(name) {
      const record = await requireComputer(metadataStore, name);
      throwIfBroken(
        record,
        await getPersistedComputerRuntimeState(record, runtime),
        "Delete is not supported for broken computers.",
      );
      if (record.profile === "container") {
        await runtime.deleteContainerComputer(record);
      } else if (record.profile === "vm") {
        await runtime.deletePersistentUnit(record.unitName);
        await runtime.deleteVmComputer(record);
      } else {
        await runtime.deletePersistentUnit(record.unitName);
      }
      if (record.profile === "host") {
        await consoleRuntimePaths.cleanupComputerDirectory(record);
      } else if (record.profile === "browser") {
        await runtime.deleteBrowserRuntimeIdentity(record);
      }
      await metadataStore.deleteComputer(name);
    },
    async startComputer(name) {
      const record = await requireComputer(metadataStore, name);
      throwIfBroken(
        record,
        await getPersistedComputerRuntimeState(record, runtime),
        "Start is not supported for broken computers.",
      );
      if (record.profile === "browser") {
        await runtime.prepareBrowserRuntime(record);
        await runtime.createPersistentUnit(record);
        await runtime.startUnit(record.unitName);
      } else if (record.profile === "container") {
        await runtime.startContainerComputer(record);
      } else {
        await runtime.startUnit(record.unitName);
      }
      if (record.profile === "host") {
        await waitForConsoleRuntimeReady(record, runtime, consoleRuntimePaths);
      }
      const updated = {
        ...record,
        lastActionAt: new Date().toISOString(),
      } satisfies PersistedComputer;
      await metadataStore.putComputer(updated);
      return await toComputerDetail(
        updated,
        runtime,
        browserRuntimePaths,
        vmRuntimePaths,
        environment,
      );
    },
    async stopComputer(name) {
      const record = await requireComputer(metadataStore, name);
      throwIfBroken(
        record,
        await getPersistedComputerRuntimeState(record, runtime),
        "Stop is not supported for broken computers.",
      );
      if (record.profile === "container") {
        await runtime.stopContainerComputer(record);
      } else {
        await runtime.stopUnit(record.unitName);
      }
      const updated = {
        ...record,
        lastActionAt: new Date().toISOString(),
      } satisfies PersistedComputer;
      await metadataStore.putComputer(updated);
      return await toComputerDetail(
        updated,
        runtime,
        browserRuntimePaths,
        vmRuntimePaths,
        environment,
      );
    },
    async restartComputer(name) {
      const record = await requireComputer(metadataStore, name);
      throwIfBroken(
        record,
        await getPersistedComputerRuntimeState(record, runtime),
        "Restart is not supported for broken computers.",
      );
      if (record.profile === "browser") {
        await runtime.prepareBrowserRuntime(record);
        await runtime.createPersistentUnit(record);
        await runtime.restartUnit(record.unitName);
      } else if (record.profile === "container") {
        await runtime.restartContainerComputer(record);
      } else {
        await runtime.restartUnit(record.unitName);
      }
      if (record.profile === "host") {
        await waitForConsoleRuntimeReady(record, runtime, consoleRuntimePaths);
      }
      const updated = {
        ...record,
        lastActionAt: new Date().toISOString(),
      } satisfies PersistedComputer;
      await metadataStore.putComputer(updated);
      return await toComputerDetail(
        updated,
        runtime,
        browserRuntimePaths,
        vmRuntimePaths,
        environment,
      );
    },
    async updateBrowserViewport(name, input) {
      const record = await requireComputer(metadataStore, name);
      const browserRecord = requireBrowserRecord(record);
      throwIfBroken(
        browserRecord,
        await runtime.getRuntimeState(browserRecord.unitName),
        "Viewport updates are not supported for broken computers.",
      );
      const updated = withBrowserViewport(browserRecord, input);
      await metadataStore.putComputer(updated);
      await runtime.updateBrowserViewport(updated, input);
      return await toComputerDetail(
        updated,
        runtime,
        browserRuntimePaths,
        vmRuntimePaths,
        environment,
      );
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

async function createPersistedComputer(
  input: CreateComputerInput,
  runtime: ComputerRuntimePort,
): Promise<PersistedComputer> {
  const timestamp = new Date().toISOString();
  const access =
    input.access ??
    (input.profile === "browser"
      ? {
          display: {
            mode: "virtual-display" as const,
          },
          logs: true,
        }
      : input.profile === "vm"
        ? {
            console: {
              mode: "pty" as const,
              writable: true,
            },
            display: {
              mode: "vnc" as const,
            },
            logs: true,
          }
        : {
            console: {
              mode: "pty" as const,
              writable: true,
            },
            logs: true,
          });
  const common = {
    name: input.name,
    unitName: toUnitName(input.name),
    description: input.description,
    createdAt: timestamp,
    lastActionAt: timestamp,
    profile: input.profile,
    access,
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

  if (input.profile === "host") {
    return {
      ...common,
      profile: "host",
      runtime: {
        ...input.runtime,
        command:
          input.runtime.command ?? (access.console?.mode === "pty" ? "/bin/sh -i" : undefined),
      },
    };
  }

  if (input.profile === "container") {
    const containerRuntime = await runtime.createContainerComputer(input, common.unitName);
    return {
      ...common,
      unitName: toContainerUnitName(input.name),
      profile: "container",
      runtime: containerRuntime,
    };
  }

  if (input.profile === "vm") {
    return {
      ...common,
      profile: "vm",
      runtime: await runtime.createVmComputer(input),
    };
  }

  return {
    ...common,
    profile: "browser",
    runtime: {
      ...input.runtime,
      runtimeUser: createBrowserRuntimeUser(input.name),
    },
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
  record: PersistedHostComputer | PersistedContainerComputer | PersistedVmComputer,
  runtime: ComputerRuntimePort,
  consoleRuntimePaths: ReturnType<typeof createConsoleRuntimePaths>,
) {
  if (record.profile === "container") {
    await requireContainerRunning(record, runtime, "console sessions");
    return;
  }

  if (record.profile === "vm") {
    const runtimeState = await runtime.getRuntimeState(record.unitName);
    throwIfBroken(record, runtimeState, "Console sessions are not supported for broken computers.");
    if (mapComputerState(runtimeState) !== "running") {
      throw new ComputerConsoleUnavailableError(
        `Computer "${record.name}" must be running before opening a console.`,
      );
    }

    return;
  }

  throwIfBroken(
    record,
    await runtime.getRuntimeState(record.unitName),
    "Console sessions are not supported for broken computers.",
  );

  const isReady = await waitForConsoleRuntimeReady(record, runtime, consoleRuntimePaths, 3_000);
  if (!isReady) {
    const runtimeState = await runtime.getRuntimeState(record.unitName);
    throwIfBroken(record, runtimeState, "Console sessions are not supported for broken computers.");
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
  record: PersistedHostComputer,
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
  const state = mapComputerState(await getPersistedComputerRuntimeState(record, runtime));
  return {
    name: record.name,
    unitName: record.unitName,
    profile: record.profile,
    state,
    description: record.description,
    createdAt: record.createdAt,
    access: record.access,
    capabilities: createComputerCapabilities(record.profile, state, record.access),
  };
}

async function toComputerDetail(
  record: PersistedComputer,
  runtime: ComputerRuntimePort,
  browserRuntimePaths: ReturnType<typeof createBrowserRuntimePaths>,
  vmRuntimePaths: ReturnType<typeof createVmRuntimePaths>,
  environment: NodeJS.ProcessEnv,
): Promise<ComputerDetail> {
  const runtimeState = await getPersistedComputerRuntimeState(record, runtime);
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

  if (record.profile === "host") {
    return {
      ...common,
      profile: "host",
      runtime: {
        command: runtimeState?.execStart ?? record.runtime.command,
        workingDirectory: runtimeState?.workingDirectory ?? record.runtime.workingDirectory,
        environment: runtimeState?.environment ?? record.runtime.environment,
      },
    };
  }

  if (record.profile === "container") {
    return {
      ...common,
      profile: "container",
      runtime: {
        ...record.runtime,
        command: runtimeState?.execStart ?? record.runtime.command,
        workingDirectory: runtimeState?.workingDirectory ?? record.runtime.workingDirectory,
        environment: runtimeState?.environment ?? record.runtime.environment,
      },
    };
  }

  if (record.profile === "vm") {
    return {
      ...common,
      profile: "vm",
      runtime: toVmRuntimeDetail(record, {
        runtimeRootDirectory: vmRuntimePaths.runtimeRootDirectory,
        stateRootDirectory: vmRuntimePaths.stateRootDirectory,
        bridge: resolveVmBridgeName(record.network.mode, environment),
      }),
    };
  }

  return {
    ...common,
    profile: "browser",
    runtime: toBrowserRuntimeDetail(record, {
      runtimeRootDirectory: browserRuntimePaths.runtimeRootDirectory,
      stateRootDirectory: browserRuntimePaths.stateRootDirectory,
    }),
  };
}

function mapComputerState(runtimeState: UnitRuntimeState | null) {
  if (runtimeState === null) {
    return "broken" as const;
  }

  return runtimeState.activeState === "active" ? ("running" as const) : ("stopped" as const);
}

function resolveVmBridgeName(networkMode: "host" | "isolated", environment: NodeJS.ProcessEnv) {
  if (networkMode === "host") {
    return environment.COMPUTERD_VM_BRIDGE ?? "br0";
  }

  return environment.COMPUTERD_VM_ISOLATED_BRIDGE ?? "__computerd_missing_isolated_bridge__";
}

function assertSupportedCreateInput(
  input: CreateComputerInput,
  environment: NodeJS.ProcessEnv,
): asserts input is
  | CreateHostComputerInput
  | CreateBrowserComputerInput
  | CreateContainerComputerInput
  | CreateVmComputerInput {
  if (input.storage?.rootMode === "ephemeral") {
    throw new UnsupportedComputerFeatureError(
      '`storage.rootMode="ephemeral"` is not supported yet.',
    );
  }

  if (input.profile !== "vm" && input.network?.mode === "isolated") {
    throw new UnsupportedComputerFeatureError('`network.mode="isolated"` is not supported yet.');
  }

  if (input.resources?.tasksMax !== undefined) {
    throw new UnsupportedComputerFeatureError(
      "`resources.tasksMax` is not wired to the DBus runtime yet.",
    );
  }

  if (
    (input.profile === "host" || input.profile === "container") &&
    input.access?.console?.mode !== "pty" &&
    !input.runtime.command
  ) {
    throw new UnsupportedComputerFeatureError(
      `Computer "${input.name}" must define runtime.command when console access is disabled.`,
    );
  }

  if (input.profile === "vm") {
    if (input.runtime.nics.length !== 1) {
      throw new UnsupportedComputerFeatureError(
        `Computer "${input.name}" currently supports exactly one VM NIC.`,
      );
    }

    if (
      input.network?.mode === "isolated" &&
      (environment.COMPUTERD_VM_ISOLATED_BRIDGE ?? "").length === 0
    ) {
      throw new UnsupportedComputerFeatureError(
        `Computer "${input.name}" cannot use network.mode="isolated" until COMPUTERD_VM_ISOLATED_BRIDGE is configured.`,
      );
    }
  }
}

function requireBrowserRecord(record: PersistedComputer): PersistedBrowserComputer {
  if (record.profile !== "browser" || record.access.display?.mode !== "virtual-display") {
    throw new UnsupportedComputerFeatureError(
      `Computer "${record.name}" does not support browser sessions.`,
    );
  }

  return record;
}

function requireMonitorCapableRecord(
  record: PersistedComputer,
): PersistedBrowserComputer | PersistedVmComputer {
  if (record.profile === "browser" || record.profile === "vm") {
    return record;
  }

  throw new UnsupportedComputerFeatureError(
    `Computer "${record.name}" does not support monitor sessions.`,
  );
}

async function requireBrowserRunning(
  record: PersistedBrowserComputer,
  runtime: ComputerRuntimePort,
  capability: string,
) {
  const runtimeState = await runtime.getRuntimeState(record.unitName);
  throwIfBroken(
    record,
    runtimeState,
    `Opening ${capability} is not supported for broken computers.`,
  );
  if (mapComputerState(runtimeState) !== "running") {
    throw new UnsupportedComputerFeatureError(
      `Computer "${record.name}" must be running before opening ${capability}.`,
    );
  }
}

async function requireMonitorRunning(
  record: PersistedBrowserComputer | PersistedVmComputer,
  runtime: ComputerRuntimePort,
  capability: string,
) {
  const runtimeState = await runtime.getRuntimeState(record.unitName);
  throwIfBroken(
    record,
    runtimeState,
    `Opening ${capability} is not supported for broken computers.`,
  );
  if (mapComputerState(runtimeState) !== "running") {
    throw new UnsupportedComputerFeatureError(
      `Computer "${record.name}" must be running before opening ${capability}.`,
    );
  }
}

function requireContainerRecord(record: PersistedComputer): PersistedContainerComputer {
  if (record.profile !== "container") {
    throw new UnsupportedComputerFeatureError(
      `Computer "${record.name}" does not support container sessions.`,
    );
  }

  return record;
}

function requireConsoleCapableRecord(
  record: PersistedComputer,
): PersistedHostComputer | PersistedContainerComputer | PersistedVmComputer {
  if (record.profile === "browser") {
    throw new UnsupportedComputerFeatureError(
      `Computer "${record.name}" does not support console sessions.`,
    );
  }

  return record;
}

async function requireContainerRunning(
  record: PersistedContainerComputer,
  runtime: ComputerRuntimePort,
  capability: string,
) {
  const runtimeState = await runtime.getContainerRuntimeState(record);
  throwIfBroken(
    record,
    runtimeState,
    `Opening ${capability} is not supported for broken computers.`,
  );
  if (mapComputerState(runtimeState) !== "running") {
    throw new UnsupportedComputerFeatureError(
      `Computer "${record.name}" must be running before opening ${capability}.`,
    );
  }
}

function supportsConsoleSessions(record: PersistedComputer) {
  return (
    (record.profile === "host" || record.profile === "container" || record.profile === "vm") &&
    record.access.console?.mode === "pty"
  );
}

async function getPersistedComputerRuntimeState(
  record: PersistedComputer,
  runtime: ComputerRuntimePort,
) {
  if (record.profile === "container") {
    return await runtime.getContainerRuntimeState(record);
  }

  return await runtime.getRuntimeState(record.unitName);
}

function throwIfBroken(
  record: PersistedComputer,
  runtimeState: UnitRuntimeState | null,
  action: string,
) {
  if (mapComputerState(runtimeState) === "broken") {
    throw new BrokenComputerError(record.name, action);
  }
}

function toUnitName(name: string) {
  return `computerd-${slugify(name)}.service`;
}

function toContainerUnitName(name: string) {
  return `docker:${slugify(name)}`;
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

function createExecSession(name: string): ComputerExecSession {
  return {
    computerName: name,
    protocol: "ttyd",
    connect: {
      mode: "relative-websocket-path",
      url: `/api/computers/${encodeURIComponent(name)}/exec/ws`,
    },
    authorization: {
      mode: "none",
    },
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
}

function createConsoleAttachLease(
  record: PersistedHostComputer | PersistedContainerComputer | PersistedVmComputer,
  consoleRuntimePaths: ReturnType<typeof createConsoleRuntimePaths>,
  environment: NodeJS.ProcessEnv,
  activeConsoleAttaches: Set<string>,
): ConsoleAttachLease {
  if (record.profile === "container") {
    return {
      command: environment.COMPUTERD_DOCKER_CLI ?? "docker",
      args: ["attach", record.runtime.containerId],
      computerName: record.name,
      release() {
        activeConsoleAttaches.delete(record.name);
      },
    };
  }

  if (record.profile === "vm") {
    const spec = createVmRuntimePaths({
      runtimeRootDirectory: environment.COMPUTERD_VM_RUNTIME_DIR ?? "/run/computerd/computers",
      stateRootDirectory: environment.COMPUTERD_VM_STATE_DIR ?? "/var/lib/computerd/computers",
    }).specForComputer(record);
    return {
      command: environment.COMPUTERD_NODE ?? process.execPath ?? "node",
      args: [
        "-e",
        [
          "const net=require('node:net')",
          `const socket=net.createConnection(${JSON.stringify(spec.serialSocketPath)})`,
          "process.stdin.resume()",
          "process.stdin.on('data',(chunk)=>{ try { socket.write(chunk) } catch {} })",
          "process.stdin.on('end',()=>{ try { socket.end() } catch {} })",
          "socket.on('data',(chunk)=>{ try { process.stdout.write(chunk) } catch {} })",
          "socket.on('end',()=>process.exit(0))",
          "socket.on('close',()=>process.exit(0))",
          "socket.on('error',(error)=>{ try { console.error(error?.message ?? String(error)) } catch {}; process.exit(1) })",
        ].join(";"),
      ],
      computerName: record.name,
      release() {
        activeConsoleAttaches.delete(record.name);
      },
    };
  }

  const spec = consoleRuntimePaths.specForComputer(record);
  return {
    command: "tmux",
    args: ["-S", spec.socketPath, "attach-session", "-t", spec.sessionName],
    computerName: record.name,
    release() {
      activeConsoleAttaches.delete(record.name);
    },
  };
}

function createContainerExecLease(
  record: PersistedContainerComputer,
  environment: NodeJS.ProcessEnv,
): ConsoleAttachLease {
  return {
    command: environment.COMPUTERD_DOCKER_CLI ?? "docker",
    args: ["exec", "-it", record.runtime.containerId, "/bin/sh"],
    computerName: record.name,
    release() {},
  };
}

async function ensureDirectories(environment: NodeJS.ProcessEnv) {
  const paths = [
    environment.COMPUTERD_METADATA_DIR ?? "/var/lib/computerd/computers",
    environment.COMPUTERD_BROWSER_STATE_DIR ?? "/var/lib/computerd/computers",
    environment.COMPUTERD_BROWSER_RUNTIME_DIR ?? "/run/computerd/computers",
    environment.COMPUTERD_VM_STATE_DIR ?? "/var/lib/computerd/computers",
    environment.COMPUTERD_VM_RUNTIME_DIR ?? "/run/computerd/computers",
    environment.COMPUTERD_UNIT_DIR ?? "/etc/systemd/system",
    environment.COMPUTERD_TERMINAL_RUNTIME_DIR ?? "/run/computerd/terminals",
  ];

  await Promise.all(paths.map((path) => mkdir(path, { recursive: true })));
}

function createRuntimePort({
  dockerSocketPath,
  systemdRuntime,
}: {
  dockerSocketPath: string;
  systemdRuntime: ReturnType<typeof createSystemdRuntime>;
}): ComputerRuntimePort {
  const dockerRuntime = createDockerRuntime({
    socketPath: dockerSocketPath,
  });

  return {
    ...systemdRuntime,
    ...dockerRuntime,
  };
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
  const seeded: PersistedHostComputer = {
    name: "starter-host",
    unitName: "computerd-starter-host.service",
    profile: "host",
    description: "Development host computer for local coding and smoke tests.",
    createdAt: new Date().toISOString(),
    lastActionAt: new Date().toISOString(),
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
      command: "/bin/sh -i",
    },
  };
  records.set(seeded.name, seeded);
  const browserSeed: PersistedBrowserComputer = {
    name: "research-browser",
    unitName: "computerd-research-browser.service",
    profile: "browser",
    description: "Development browser computer for noVNC and CDP smoke tests.",
    createdAt: new Date().toISOString(),
    lastActionAt: new Date().toISOString(),
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
      runtimeUser: createBrowserRuntimeUser("research-browser"),
    },
  };
  records.set(browserSeed.name, browserSeed);
  const vmSeed: PersistedVmComputer = {
    name: "linux-vm",
    unitName: "computerd-linux-vm.service",
    profile: "vm",
    description: "Development VM computer for QEMU monitor and serial console smoke tests.",
    createdAt: new Date().toISOString(),
    lastActionAt: new Date().toISOString(),
    access: {
      console: {
        mode: "pty",
        writable: true,
      },
      display: {
        mode: "vnc",
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
      hypervisor: "qemu",
      nics: [
        {
          name: "primary",
          ipv4: {
            type: "dhcp",
          },
          ipv6: {
            type: "disabled",
          },
        },
      ],
      accelerator: "kvm",
      architecture: "x86_64",
      machine: "q35",
      source: {
        kind: "qcow2",
        baseImagePath: "/images/ubuntu-cloud.qcow2",
        cloudInit: {
          user: "ubuntu",
        },
      },
    },
  };
  records.set(vmSeed.name, vmSeed);
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
        execStart: seeded.runtime.command,
      },
    ],
    [
      browserSeed.unitName,
      {
        unitName: browserSeed.unitName,
        description: browserSeed.description,
        unitType: "service",
        loadState: "loaded",
        activeState: "inactive",
        subState: "dead",
        execStart: "/usr/bin/bash -lc",
      },
    ],
    [
      vmSeed.unitName,
      {
        unitName: vmSeed.unitName,
        description: vmSeed.description,
        unitType: "service",
        loadState: "loaded",
        activeState: "inactive",
        subState: "dead",
        execStart: "/usr/bin/qemu-system-x86_64",
      },
    ],
  ]);
  const consoleRuntimePaths = createConsoleRuntimePaths({
    runtimeDirectory: "/tmp/computerd-development-terminals",
  });
  const browserRuntimePaths = createBrowserRuntimePaths({
    runtimeRootDirectory: "/tmp/computerd-development-browsers",
    stateRootDirectory: "/tmp/computerd-development-browser-state",
  });
  const vmRuntimePaths = createVmRuntimePaths({
    runtimeRootDirectory: "/tmp/computerd-development-vms",
    stateRootDirectory: "/tmp/computerd-development-vm-state",
  });
  const activeConsoleAttaches = new Set<string>();
  const containerStates = new Map<string, UnitRuntimeState>();

  const runtime: ComputerRuntimePort = {
    async createContainerComputer(input, unitName) {
      const containerName = unitName.replace(/\.service$/, "");
      const containerId = `development-${slugify(input.name)}`;
      containerStates.set(containerId, {
        unitName: toContainerUnitName(input.name),
        description: input.description,
        unitType: "container",
        loadState: "loaded",
        activeState: "inactive",
        subState: "created",
        execStart:
          input.runtime.command ??
          (input.access?.console?.mode === "pty" ? "/bin/sh -i" : undefined),
        workingDirectory: input.runtime.workingDirectory,
        environment: input.runtime.environment,
      });
      return {
        ...input.runtime,
        command:
          input.runtime.command ??
          (input.access?.console?.mode === "pty" ? "/bin/sh -i" : undefined),
        containerId,
        containerName,
      };
    },
    async createVmComputer(input) {
      return withPersistedVmRuntime(input.runtime);
    },
    async deleteBrowserRuntimeIdentity() {},
    async deleteContainerComputer(computer) {
      containerStates.delete(computer.runtime.containerId);
    },
    async deleteVmComputer() {},
    async ensureBrowserRuntimeIdentity() {},
    async prepareBrowserRuntime() {},
    async createMonitorSession(computer) {
      const spec =
        computer.profile === "browser"
          ? browserRuntimePaths.specForComputer(computer)
          : vmRuntimePaths.specForComputer(computer);
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
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      };
    },
    async openMonitorAttach(computer) {
      const spec =
        computer.profile === "browser"
          ? browserRuntimePaths.specForComputer(computer)
          : vmRuntimePaths.specForComputer(computer);
      return {
        computerName: computer.name,
        host: "127.0.0.1",
        port: spec.vncPort,
        release() {},
      };
    },
    async openAudioStream(computer) {
      return {
        computerName: computer.name,
        command: "ffmpeg",
        args: [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "anullsrc=channel_layout=stereo:sample_rate=48000",
          "-c:a",
          "libopus",
          "-b:a",
          "128k",
          "-f",
          "ogg",
          "pipe:1",
        ],
        env: {
          PIPEWIRE_PROPS: JSON.stringify({
            "application.name": "computerd-audio-capture",
            "computerd.computer.name": computer.name,
          }),
        },
        targetSelector: `computerd.computer.name=${computer.name}`,
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
      return {
        computerName: computer.name,
        url: `ws://127.0.0.1:${browserRuntimePaths.specForComputer(computer).devtoolsPort}/devtools/browser/development`,
        release() {},
      };
    },
    async createScreenshot(computer) {
      const spec = browserRuntimePaths.specForComputer(computer);
      return {
        computerName: computer.name,
        format: "png",
        mimeType: "image/png",
        capturedAt: new Date().toISOString(),
        width: spec.viewport.width,
        height: spec.viewport.height,
        dataBase64: Buffer.from(`development-screenshot:${computer.name}`).toString("base64"),
      };
    },
    async createPersistentUnit(computer) {
      if (computer.profile === "host" && computer.access.console?.mode === "pty") {
        await ensureDevelopmentConsoleSocket(consoleRuntimePaths, computer);
      } else if (computer.profile === "browser") {
        const spec = browserRuntimePaths.specForComputer(computer);
        await mkdir(spec.profileDirectory, { recursive: true });
        await mkdir(spec.runtimeDirectory, { recursive: true });
      } else if (computer.profile === "vm") {
        const spec = vmRuntimePaths.specForComputer(computer);
        await mkdir(spec.stateDirectory, { recursive: true });
        await mkdir(spec.runtimeDirectory, { recursive: true });
        await writeFile(spec.serialSocketPath, "");
      }
      runtimeStates.set(computer.unitName, {
        unitName: computer.unitName,
        description: computer.description,
        unitType: "service",
        loadState: "loaded",
        activeState: "inactive",
        subState: "dead",
        execStart:
          computer.profile === "host"
            ? computer.runtime.command
            : computer.profile === "vm"
              ? "/usr/bin/qemu-system-x86_64"
              : "/usr/bin/bash -lc",
        workingDirectory:
          computer.profile === "host"
            ? computer.runtime.workingDirectory
            : computer.profile === "browser"
              ? browserRuntimePaths.specForComputer(computer).stateDirectory
              : computer.profile === "vm"
                ? vmRuntimePaths.specForComputer(computer).stateDirectory
                : undefined,
        environment: computer.profile === "host" ? computer.runtime.environment : undefined,
        cpuWeight: computer.resources.cpuWeight,
        memoryMaxMiB: computer.resources.memoryMaxMiB,
      });
      return runtimeStates.get(computer.unitName)!;
    },
    async deletePersistentUnit(unitName) {
      const record = [...records.values()].find((entry) => entry.unitName === unitName);
      if (record?.profile === "host") {
        await cleanupDevelopmentConsoleRuntime(consoleRuntimePaths, record);
      } else if (record?.profile === "browser") {
        const spec = browserRuntimePaths.specForComputer(record);
        await writeFile(`${spec.runtimeDirectory}/stopped`, "");
      } else if (record?.profile === "vm") {
        const spec = vmRuntimePaths.specForComputer(record);
        await writeFile(`${spec.runtimeDirectory}/stopped`, "");
      }
      runtimeStates.delete(unitName);
    },
    async getContainerRuntimeState(computer) {
      return containerStates.get(computer.runtime.containerId) ?? null;
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
      if (record?.profile === "host") {
        await ensureDevelopmentConsoleSocket(consoleRuntimePaths, record);
      } else if (record?.profile === "browser") {
        const spec = browserRuntimePaths.specForComputer(record);
        await mkdir(spec.runtimeDirectory, { recursive: true });
      } else if (record?.profile === "vm") {
        const spec = vmRuntimePaths.specForComputer(record);
        await mkdir(spec.runtimeDirectory, { recursive: true });
        await writeFile(spec.serialSocketPath, "");
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
      if (record?.profile === "host") {
        await ensureDevelopmentConsoleSocket(consoleRuntimePaths, record);
      } else if (record?.profile === "browser") {
        const spec = browserRuntimePaths.specForComputer(record);
        await mkdir(spec.runtimeDirectory, { recursive: true });
      } else if (record?.profile === "vm") {
        const spec = vmRuntimePaths.specForComputer(record);
        await mkdir(spec.runtimeDirectory, { recursive: true });
        await writeFile(spec.serialSocketPath, "");
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
      if (record?.profile === "host") {
        await cleanupDevelopmentConsoleRuntime(consoleRuntimePaths, record);
      } else if (record?.profile === "browser") {
        const spec = browserRuntimePaths.specForComputer(record);
        await writeFile(`${spec.runtimeDirectory}/stopped`, "");
      } else if (record?.profile === "vm") {
        const spec = vmRuntimePaths.specForComputer(record);
        await writeFile(`${spec.runtimeDirectory}/stopped`, "");
      }
      return state;
    },
    async restartContainerComputer(computer) {
      const state = containerStates.get(computer.runtime.containerId);
      if (!state) {
        throw new ComputerNotFoundError(computer.name);
      }

      state.activeState = "active";
      state.subState = "running";
      return state;
    },
    async startContainerComputer(computer) {
      const state = containerStates.get(computer.runtime.containerId);
      if (!state) {
        throw new ComputerNotFoundError(computer.name);
      }

      state.activeState = "active";
      state.subState = "running";
      return state;
    },
    async stopContainerComputer(computer) {
      const state = containerStates.get(computer.runtime.containerId);
      if (!state) {
        throw new ComputerNotFoundError(computer.name);
      }

      state.activeState = "inactive";
      state.subState = "exited";
      return state;
    },
    async updateBrowserViewport(computer, viewport) {
      const state = runtimeStates.get(computer.unitName);
      if (state?.activeState !== "active") {
        return;
      }

      const spec = browserRuntimePaths.specForComputer(withBrowserViewport(computer, viewport));
      await mkdir(spec.runtimeDirectory, { recursive: true });
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
      COMPUTERD_BROWSER_RUNTIME_DIR: browserRuntimePaths.runtimeRootDirectory,
      COMPUTERD_BROWSER_STATE_DIR: browserRuntimePaths.stateRootDirectory,
      COMPUTERD_VM_RUNTIME_DIR: vmRuntimePaths.runtimeRootDirectory,
      COMPUTERD_VM_STATE_DIR: vmRuntimePaths.stateRootDirectory,
      COMPUTERD_VM_BRIDGE: "br0",
      COMPUTERD_VM_ISOLATED_BRIDGE: "br1",
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
      const persistedRecord = records.get(name);
      if (persistedRecord === undefined) {
        throw new ComputerNotFoundError(name);
      }
      const record = requireConsoleCapableRecord(persistedRecord);
      if (!supportsConsoleSessions(record)) {
        throw new UnsupportedComputerFeatureError(
          `Computer "${name}" does not support console sessions.`,
        );
      }

      if (record.profile === "host") {
        await ensureDevelopmentConsoleSocket(consoleRuntimePaths, record);
      } else if (record.profile === "container") {
        await requireContainerRunning(record, runtime, "console sessions");
      }
      return createConsoleSession(record.name);
    },
    async createExecSession(name) {
      const record = records.get(name);
      if (record === undefined) {
        throw new ComputerNotFoundError(name);
      }
      const containerRecord = requireContainerRecord(record);
      await requireContainerRunning(containerRecord, runtime, "exec sessions");
      return createExecSession(record.name);
    },
    async openConsoleAttach(name) {
      const persistedRecord = records.get(name);
      if (persistedRecord === undefined) {
        throw new ComputerNotFoundError(name);
      }
      const record = requireConsoleCapableRecord(persistedRecord);
      if (!supportsConsoleSessions(record)) {
        throw new UnsupportedComputerFeatureError(
          `Computer "${name}" does not support console sessions.`,
        );
      }

      if (record.profile === "container") {
        await requireContainerRunning(record, runtime, "console sessions");
      }
      if (activeConsoleAttaches.has(name)) {
        throw new ComputerConsoleUnavailableError(
          `Computer "${name}" already has an active console connection.`,
        );
      }

      activeConsoleAttaches.add(name);
      if (record.profile === "container") {
        return createConsoleAttachLease(
          record,
          consoleRuntimePaths,
          process.env,
          activeConsoleAttaches,
        );
      }
      if (record.profile === "vm") {
        return createConsoleAttachLease(
          record,
          consoleRuntimePaths,
          process.env,
          activeConsoleAttaches,
        );
      }
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
    async openExecAttach(name) {
      const record = records.get(name);
      if (record === undefined) {
        throw new ComputerNotFoundError(name);
      }
      const containerRecord = requireContainerRecord(record);
      await requireContainerRunning(containerRecord, runtime, "exec sessions");
      return createContainerExecLease(containerRecord, process.env);
    },
  };
}

async function ensureDevelopmentConsoleSocket(
  consoleRuntimePaths: ReturnType<typeof createConsoleRuntimePaths>,
  computer: PersistedHostComputer,
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
  computer: PersistedHostComputer,
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
  computer: PersistedHostComputer,
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

function buildDevelopmentTmuxCommand(computer: PersistedHostComputer) {
  const segments = ["set -eu"];
  if (computer.runtime.workingDirectory) {
    segments.push(`cd ${escapeShellToken(computer.runtime.workingDirectory)}`);
  }

  if (computer.runtime.environment) {
    for (const [key, value] of Object.entries(computer.runtime.environment)) {
      segments.push(`export ${key}=${escapeShellToken(value)}`);
    }
  }

  segments.push(`exec ${computer.runtime.command ?? "/bin/sh -i"}`);
  return segments.join("; ");
}

function escapeShellToken(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export type {
  BrowserAutomationLease,
  BrowserAudioStreamLease,
  BrowserMonitorLease,
  ComputerAudioSession,
  ConsoleAttachLease,
  ComputerConsoleSession,
  ComputerExecSession,
  ComputerDetail,
  ComputerMonitorSession,
  ComputerSummary,
  CreateBrowserComputerInput,
  CreateComputerInput,
  CreateContainerComputerInput,
  CreateHostComputerInput,
  HostUnitDetail,
  HostUnitSummary,
  HostRuntime,
};
