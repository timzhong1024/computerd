import { mkdir } from "node:fs/promises";
import {
  createComputerCapabilities,
  type ComputerAutomationSession,
  type ComputerConsoleSession,
  type ComputerDetail,
  type DisplayAction,
  type ComputerExecSession,
  type ComputerMonitorSession,
  type RunDisplayActionsObserve,
  type RunDisplayActionsResult,
  type ComputerScreenshot,
  type ComputerSnapshot,
  type ComputerSummary,
  type CreateBrowserComputerInput,
  type CreateComputerInput,
  type CreateContainerComputerInput,
  type CreateHostComputerInput,
  type CreateVmComputerInput,
  type HostUnitDetail,
  type NetworkSummary,
  type RestoreComputerInput,
  type ResizeDisplayInput,
} from "@computerd/core";
import {
  DEFAULT_HOST_NETWORK_ID,
  type NetworkProvider,
  type PersistedNetworkRecord,
} from "./networks";
import {
  createBrowserRuntimePaths,
  toBrowserRuntimeDetail,
  withBrowserViewport,
} from "./systemd/browser-runtime";
import { createConsoleRuntimePaths } from "./systemd/console-runtime";
import { createVmRuntimePaths, toVmRuntimeDetail, withVmViewport } from "./systemd/vm-runtime";
import { ImageProvider } from "./images";
import {
  ComputerRuntimePort,
  type BrowserAutomationLease,
  type BrowserAudioStreamLease,
  type BrowserMonitorLease,
  type ComputerMetadataStore,
  type ConsoleAttachLease,
  type PersistedBrowserComputer,
  type PersistedComputer,
  type PersistedContainerComputer,
  type PersistedHostComputer,
  type PersistedVmComputer,
  type UnitRuntimeState,
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

export class ComputerSnapshotConflictError extends Error {
  constructor(computerName: string, snapshotName: string) {
    super(`Snapshot "${snapshotName}" already exists for computer "${computerName}".`);
    this.name = "ComputerSnapshotConflictError";
  }
}

export class ComputerSnapshotNotFoundError extends Error {
  constructor(computerName: string, snapshotName: string) {
    super(`Snapshot "${snapshotName}" was not found for computer "${computerName}".`);
    this.name = "ComputerSnapshotNotFoundError";
  }
}

export interface BaseControlPlaneDependencies {
  environment: NodeJS.ProcessEnv;
  imageProvider: ImageProvider;
  networkProvider: NetworkProvider;
  metadataStore: ComputerMetadataStore;
  runtime: ComputerRuntimePort;
  consoleRuntimePaths: ReturnType<typeof createConsoleRuntimePaths>;
  browserRuntimePaths: ReturnType<typeof createBrowserRuntimePaths>;
  vmRuntimePaths: ReturnType<typeof createVmRuntimePaths>;
  usesDefaultPersistence: boolean;
}

export async function ensureDirectories(environment: NodeJS.ProcessEnv) {
  const paths = [
    environment.COMPUTERD_METADATA_DIR ?? "/var/lib/computerd/computers",
    environment.COMPUTERD_NETWORK_CONFIG_DIR ?? "/var/lib/computerd",
    environment.COMPUTERD_NETWORK_RUNTIME_DIR ?? "/run/computerd/networks",
    environment.COMPUTERD_BROWSER_STATE_DIR ?? "/var/lib/computerd/computers",
    environment.COMPUTERD_BROWSER_RUNTIME_DIR ?? "/run/computerd/computers",
    environment.COMPUTERD_VM_STATE_DIR ?? "/var/lib/computerd/computers",
    environment.COMPUTERD_VM_RUNTIME_DIR ?? "/run/computerd/computers",
    environment.COMPUTERD_UNIT_DIR ?? "/etc/systemd/system",
    environment.COMPUTERD_TERMINAL_RUNTIME_DIR ?? "/run/computerd/terminals",
  ];

  await Promise.all(paths.map((path) => mkdir(path, { recursive: true })));
}

export async function createPersistedComputer(
  input: CreateComputerInput,
  runtime: ComputerRuntimePort,
  resolveVmImagePath: (imageId: string, kind: "qcow2" | "iso") => Promise<string>,
  network: PersistedNetworkRecord,
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
    networkId: input.networkId ?? DEFAULT_HOST_NETWORK_ID,
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
    const containerRuntime = await runtime.createContainerComputer(input, common.unitName, network);
    return {
      ...common,
      unitName: toContainerUnitName(input.name),
      profile: "container",
      runtime: containerRuntime,
    };
  }

  if (input.profile === "vm") {
    const imagePath = await resolveVmImagePath(
      input.runtime.source.imageId,
      input.runtime.source.kind,
    );
    return {
      ...common,
      profile: "vm",
      runtime: await runtime.createVmComputer(input, imagePath, network),
    };
  }

  if (input.profile === "browser") {
    return {
      ...common,
      profile: "browser",
      runtime: await runtime.createBrowserComputer(input, common.unitName, network),
    };
  }

  throw new UnsupportedComputerFeatureError(`Unsupported computer profile: ${String(input)}`);
}

export function mapComputerState(runtimeState: UnitRuntimeState | null) {
  if (runtimeState === null) {
    return "broken" as const;
  }

  return runtimeState.activeState === "active" ? ("running" as const) : ("stopped" as const);
}

export function assertSupportedCreateInput(
  input: CreateComputerInput,
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
  }
}

export function requireBrowserRecord(record: PersistedComputer): PersistedBrowserComputer {
  if (record.profile !== "browser" || record.access.display?.mode !== "virtual-display") {
    throw new UnsupportedComputerFeatureError(
      `Computer "${record.name}" does not support browser sessions.`,
    );
  }

  return record;
}

export function requireVmRecord(record: PersistedComputer): PersistedVmComputer {
  if (record.profile !== "vm") {
    throw new UnsupportedComputerFeatureError(
      `Computer "${record.name}" does not support VM snapshots.`,
    );
  }

  return record;
}

export function requireMonitorCapableRecord(
  record: PersistedComputer,
): PersistedBrowserComputer | PersistedVmComputer {
  if (record.profile === "browser" || record.profile === "vm") {
    return record;
  }

  throw new UnsupportedComputerFeatureError(
    `Computer "${record.name}" does not support monitor sessions.`,
  );
}

export function requireContainerRecord(record: PersistedComputer): PersistedContainerComputer {
  if (record.profile !== "container") {
    throw new UnsupportedComputerFeatureError(
      `Computer "${record.name}" does not support container sessions.`,
    );
  }

  return record;
}

export function requireConsoleCapableRecord(
  record: PersistedComputer,
): PersistedHostComputer | PersistedContainerComputer | PersistedVmComputer {
  if (record.profile === "browser") {
    throw new UnsupportedComputerFeatureError(
      `Computer "${record.name}" does not support console sessions.`,
    );
  }

  return record;
}

export function supportsConsoleSessions(record: PersistedComputer) {
  return (
    (record.profile === "host" || record.profile === "container" || record.profile === "vm") &&
    record.access.console?.mode === "pty"
  );
}

export async function getPersistedComputerRuntimeState(
  record: PersistedComputer,
  runtime: ComputerRuntimePort,
) {
  if (record.profile === "browser" && record.runtime.provider === "container") {
    return await runtime.getBrowserRuntimeState(record);
  }
  if (record.profile === "container") {
    return await runtime.getContainerRuntimeState(record);
  }

  return await runtime.getRuntimeState(record.unitName);
}

export function throwIfBroken(
  record: PersistedComputer,
  runtimeState: UnitRuntimeState | null,
  action: string,
) {
  if (mapComputerState(runtimeState) === "broken") {
    throw new BrokenComputerError(record.name, action);
  }
}

export function isSnapshotConflictError(error: unknown) {
  return error instanceof Error && /snapshot ".*" already exists/i.test(error.message);
}

export function isSnapshotNotFoundError(error: unknown) {
  return error instanceof Error && /snapshot ".*" was not found/i.test(error.message);
}

export function toUnitName(name: string) {
  return `computerd-${slugify(name)}.service`;
}

export function toContainerUnitName(name: string) {
  return `docker:${slugify(name)}`;
}

export function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function compareByName(left: ComputerSummary, right: ComputerSummary) {
  return left.name.localeCompare(right.name);
}

export function capitalize(value: string) {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

export function createConsoleSession(name: string): ComputerConsoleSession {
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

export function createExecSession(name: string): ComputerExecSession {
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

export function createConsoleAttachLease(
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
      pty: false,
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

export function createContainerExecLease(
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

export function toComputerDetail(
  record: PersistedComputer,
  runtimeState: UnitRuntimeState | null,
  summary: ComputerSummary,
  browserRuntimePaths: ReturnType<typeof createBrowserRuntimePaths>,
  vmRuntimePaths: ReturnType<typeof createVmRuntimePaths>,
): ComputerDetail {
  const common = {
    ...summary,
    resources: {
      cpuWeight: runtimeState?.cpuWeight ?? record.resources.cpuWeight,
      memoryMaxMiB: runtimeState?.memoryMaxMiB ?? record.resources.memoryMaxMiB,
    },
    storage: record.storage,
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

export function toComputerSummary(
  record: PersistedComputer,
  state: ComputerSummary["state"],
  network: NetworkSummary,
): ComputerSummary {
  const capabilities = createComputerCapabilities(record.profile, state, record.access);
  if (record.profile === "browser" && record.runtime.provider === "container") {
    capabilities.audioAvailable = false;
  }

  return {
    name: record.name,
    unitName: record.unitName,
    profile: record.profile,
    state,
    description: record.description,
    createdAt: record.createdAt,
    access: record.access,
    capabilities,
    network,
  };
}

export { withBrowserViewport };
export { withVmViewport };
export { ComputerRuntimePort } from "./systemd/types";

export type {
  BrowserAutomationLease,
  BrowserAudioStreamLease,
  BrowserMonitorLease,
  ComputerAutomationSession,
  ComputerMetadataStore,
  ComputerMonitorSession,
  DisplayAction,
  ComputerScreenshot,
  ComputerSnapshot,
  ConsoleAttachLease,
  HostUnitDetail,
  PersistedBrowserComputer,
  PersistedComputer,
  PersistedContainerComputer,
  PersistedHostComputer,
  PersistedVmComputer,
  RunDisplayActionsObserve,
  RunDisplayActionsResult,
  RestoreComputerInput,
  UnitRuntimeState,
  ResizeDisplayInput,
};
