import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  createComputerCapabilities,
  type ComputerAutomationSession,
  type ComputerAudioSession,
  type ComputerConsoleSession,
  type ComputerDetail,
  type ComputerMonitorSession,
  type ComputerScreenshot,
  type ComputerSummary,
  type CreateBrowserComputerInput,
  type CreateComputerInput,
  type CreateTerminalComputerInput,
  type HostUnitDetail,
  type HostUnitSummary,
  type TerminalRuntime,
  type UpdateBrowserViewportInput,
} from "@computerd/core";
import {
  createBrowserRuntimeUser,
  createBrowserRuntimePaths,
  toBrowserRuntimeDetail,
  withBrowserViewport,
} from "./systemd/browser-runtime";
import { createConsoleRuntimePaths } from "./systemd/console-runtime";
import { createFileComputerMetadataStore } from "./systemd/metadata-store";
import { createSystemdRuntime } from "./systemd/runtime";
import type {
  BrowserAutomationLease,
  BrowserAudioStreamLease,
  BrowserMonitorLease,
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
  createAutomationSession: (name: string) => Promise<ComputerAutomationSession>;
  createAudioSession: (name: string) => Promise<ComputerAudioSession>;
  createConsoleSession: (name: string) => Promise<ComputerConsoleSession>;
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
  const runtime =
    options.runtime ??
    createSystemdRuntime({
      unitFileStoreOptions: {
        directory: environment.COMPUTERD_UNIT_DIR ?? "/etc/systemd/system",
        browserRuntimeDirectory:
          environment.COMPUTERD_BROWSER_RUNTIME_DIR ?? "/run/computerd/computers",
        browserStateDirectory:
          environment.COMPUTERD_BROWSER_STATE_DIR ?? "/var/lib/computerd/computers",
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
      return await toComputerDetail(record, runtime, browserRuntimePaths);
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
      if (record.profile === "browser") {
        await runtime.ensureBrowserRuntimeIdentity(record);
      }
      await runtime.createPersistentUnit(record);
      await metadataStore.putComputer(record);
      return await toComputerDetail(record, runtime, browserRuntimePaths);
    },
    async createMonitorSession(name) {
      const record = await requireComputer(metadataStore, name);
      const browserRecord = requireBrowserRecord(record);
      await requireBrowserRunning(browserRecord, runtime, "monitor sessions");
      return await runtime.createMonitorSession(browserRecord);
    },
    async createAudioSession(name) {
      const record = await requireComputer(metadataStore, name);
      const browserRecord = requireBrowserRecord(record);
      await requireBrowserRunning(browserRecord, runtime, "audio sessions");
      return await runtime.createAudioSession(browserRecord);
    },
    async openMonitorAttach(name) {
      const record = await requireComputer(metadataStore, name);
      const browserRecord = requireBrowserRecord(record);
      await requireBrowserRunning(browserRecord, runtime, "monitor sessions");
      return await runtime.openMonitorAttach(browserRecord);
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
      } else {
        await runtime.deleteBrowserRuntimeIdentity(record);
      }
      await metadataStore.deleteComputer(name);
    },
    async startComputer(name) {
      const record = await requireComputer(metadataStore, name);
      if (record.profile === "browser") {
        await runtime.prepareBrowserRuntime(record);
        await runtime.createPersistentUnit(record);
      }
      await runtime.startUnit(record.unitName);
      if (record.profile === "terminal") {
        await waitForConsoleRuntimeReady(record, runtime, consoleRuntimePaths);
      }
      const updated = {
        ...record,
        lastActionAt: new Date().toISOString(),
      } satisfies PersistedComputer;
      await metadataStore.putComputer(updated);
      return await toComputerDetail(updated, runtime, browserRuntimePaths);
    },
    async stopComputer(name) {
      const record = await requireComputer(metadataStore, name);
      await runtime.stopUnit(record.unitName);
      const updated = {
        ...record,
        lastActionAt: new Date().toISOString(),
      } satisfies PersistedComputer;
      await metadataStore.putComputer(updated);
      return await toComputerDetail(updated, runtime, browserRuntimePaths);
    },
    async restartComputer(name) {
      const record = await requireComputer(metadataStore, name);
      if (record.profile === "browser") {
        await runtime.prepareBrowserRuntime(record);
        await runtime.createPersistentUnit(record);
      }
      await runtime.restartUnit(record.unitName);
      if (record.profile === "terminal") {
        await waitForConsoleRuntimeReady(record, runtime, consoleRuntimePaths);
      }
      const updated = {
        ...record,
        lastActionAt: new Date().toISOString(),
      } satisfies PersistedComputer;
      await metadataStore.putComputer(updated);
      return await toComputerDetail(updated, runtime, browserRuntimePaths);
    },
    async updateBrowserViewport(name, input) {
      const record = await requireComputer(metadataStore, name);
      const browserRecord = requireBrowserRecord(record);
      const updated = withBrowserViewport(browserRecord, input);
      await metadataStore.putComputer(updated);
      await runtime.updateBrowserViewport(updated, input);
      return await toComputerDetail(updated, runtime, browserRuntimePaths);
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
  browserRuntimePaths: ReturnType<typeof createBrowserRuntimePaths>,
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
    runtime: toBrowserRuntimeDetail(record, {
      runtimeRootDirectory: browserRuntimePaths.runtimeRootDirectory,
      stateRootDirectory: browserRuntimePaths.stateRootDirectory,
    }),
  };
}

function mapComputerState(runtimeState: UnitRuntimeState | null) {
  return runtimeState?.activeState === "active" ? ("running" as const) : ("stopped" as const);
}

function assertSupportedCreateInput(
  input: CreateComputerInput,
): asserts input is CreateTerminalComputerInput | CreateBrowserComputerInput {
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

function requireBrowserRecord(record: PersistedComputer): PersistedBrowserComputer {
  if (record.profile !== "browser" || record.access.display?.mode !== "virtual-display") {
    throw new UnsupportedComputerFeatureError(
      `Computer "${record.name}" does not support browser sessions.`,
    );
  }

  return record;
}

async function requireBrowserRunning(
  record: PersistedBrowserComputer,
  runtime: ComputerRuntimePort,
  capability: string,
) {
  const runtimeState = await runtime.getRuntimeState(record.unitName);
  if (mapComputerState(runtimeState) !== "running") {
    throw new UnsupportedComputerFeatureError(
      `Computer "${record.name}" must be running before opening ${capability}.`,
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
    environment.COMPUTERD_BROWSER_STATE_DIR ?? "/var/lib/computerd/computers",
    environment.COMPUTERD_BROWSER_RUNTIME_DIR ?? "/run/computerd/computers",
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
  const browserSeed = createPersistedComputer({
    name: "research-browser",
    profile: "browser",
    description: "Development browser computer for noVNC and CDP smoke tests.",
    runtime: {
      browser: "chromium",
      persistentProfile: true,
    },
  });
  if (browserSeed.profile !== "browser") {
    throw new TypeError("Expected development seed to be browser.");
  }
  records.set(browserSeed.name, browserSeed);
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
  ]);
  const consoleRuntimePaths = createConsoleRuntimePaths({
    runtimeDirectory: "/tmp/computerd-development-terminals",
  });
  const browserRuntimePaths = createBrowserRuntimePaths({
    runtimeRootDirectory: "/tmp/computerd-development-browsers",
    stateRootDirectory: "/tmp/computerd-development-browser-state",
  });
  const activeConsoleAttaches = new Set<string>();

  const runtime: ComputerRuntimePort = {
    async deleteBrowserRuntimeIdentity() {},
    async ensureBrowserRuntimeIdentity() {},
    async prepareBrowserRuntime() {},
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
      const spec = browserRuntimePaths.specForComputer(computer);
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
      if (computer.profile === "terminal") {
        await ensureDevelopmentConsoleSocket(consoleRuntimePaths, computer);
      } else {
        const spec = browserRuntimePaths.specForComputer(computer);
        await mkdir(spec.profileDirectory, { recursive: true });
        await mkdir(spec.runtimeDirectory, { recursive: true });
      }
      runtimeStates.set(computer.unitName, {
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
        environment: computer.profile === "terminal" ? computer.runtime.environment : undefined,
        cpuWeight: computer.resources.cpuWeight,
        memoryMaxMiB: computer.resources.memoryMaxMiB,
      });
      return runtimeStates.get(computer.unitName)!;
    },
    async deletePersistentUnit(unitName) {
      const record = [...records.values()].find((entry) => entry.unitName === unitName);
      if (record?.profile === "terminal") {
        await cleanupDevelopmentConsoleRuntime(consoleRuntimePaths, record);
      } else if (record?.profile === "browser") {
        const spec = browserRuntimePaths.specForComputer(record);
        await writeFile(`${spec.runtimeDirectory}/stopped`, "");
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
      } else if (record?.profile === "browser") {
        const spec = browserRuntimePaths.specForComputer(record);
        await mkdir(spec.runtimeDirectory, { recursive: true });
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
      } else if (record?.profile === "browser") {
        const spec = browserRuntimePaths.specForComputer(record);
        await mkdir(spec.runtimeDirectory, { recursive: true });
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
      } else if (record?.profile === "browser") {
        const spec = browserRuntimePaths.specForComputer(record);
        await writeFile(`${spec.runtimeDirectory}/stopped`, "");
      }
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
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export type {
  BrowserAutomationLease,
  BrowserAudioStreamLease,
  BrowserMonitorLease,
  ComputerAudioSession,
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
