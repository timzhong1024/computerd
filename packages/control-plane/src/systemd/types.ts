import type {
  BrowserRuntime,
  BrowserViewport,
  ComputerAccess,
  ComputerAutomationSession,
  ComputerAudioSession,
  ComputerConsoleSession,
  ComputerExecSession,
  ComputerDetail,
  ComputerLifecycle,
  ComputerMonitorSession,
  ComputerProfile,
  ComputerResources,
  ComputerScreenshot,
  ComputerSnapshot,
  ComputerStorage,
  ComputerSummary,
  CreateBrowserRuntime,
  CreateBrowserComputerInput,
  CreateComputerInput,
  CreateComputerSnapshotInput,
  CreateContainerComputerInput,
  CreateContainerRuntime,
  CreateHostComputerInput,
  CreateVmComputerInput,
  CreateVmRuntime,
  CreateVmRuntimeSource,
  HostUnitDetail,
  HostUnitSummary,
  HostRuntime,
  RestoreComputerInput,
  VmRuntime,
  UpdateBrowserViewportInput,
} from "@computerd/core";
import type { PersistedNetworkRecord } from "../networks";

export interface PersistedBrowserComputerRuntime extends CreateBrowserRuntime {
  runtimeUser: string;
}

export interface PersistedComputerBase {
  name: string;
  unitName: string;
  description?: string;
  createdAt: string;
  lastActionAt: string;
  profile: ComputerProfile;
  access: ComputerAccess;
  resources: ComputerResources;
  storage: ComputerStorage;
  networkId: string;
  lifecycle: ComputerLifecycle;
}

export interface PersistedHostComputer extends PersistedComputerBase {
  profile: "host";
  runtime: HostRuntime;
}

export interface PersistedBrowserComputer extends PersistedComputerBase {
  profile: "browser";
  runtime: PersistedBrowserComputerRuntime;
}

export interface PersistedContainerComputer extends PersistedComputerBase {
  profile: "container";
  runtime: CreateContainerRuntime & {
    containerId: string;
    containerName: string;
  };
}

export interface PersistedVmComputer extends PersistedComputerBase {
  profile: "vm";
  runtime: Omit<CreateVmRuntime, "source"> & {
    source:
      | (Extract<CreateVmRuntimeSource, { kind: "qcow2" }> & { path: string })
      | (Extract<CreateVmRuntimeSource, { kind: "iso" }> & { path: string });
    accelerator: "kvm";
    architecture: "x86_64";
    machine: "q35";
    bridgeName: string;
  };
}

export type PersistedComputer =
  | PersistedHostComputer
  | PersistedBrowserComputer
  | PersistedContainerComputer
  | PersistedVmComputer;

export interface UnitRuntimeState {
  unitName: string;
  description?: string;
  unitType: string;
  loadState: string;
  activeState: string;
  subState: string;
  fragmentPath?: string;
  unitFileState?: string;
  execStart?: string;
  workingDirectory?: string;
  environment?: Record<string, string>;
  cpuWeight?: number;
  memoryMaxMiB?: number;
  execMainPid?: number;
  execMainStatus?: number;
  result?: string;
}

export interface HostConsoleRuntimeSpec {
  directoryPath: string;
  sessionName: string;
  socketPath: string;
}

export interface VmConsoleRuntimeSpec {
  socketPath: string;
}

export abstract class ComputerRuntimePort {
  abstract createContainerComputer(
    input: CreateContainerComputerInput,
    unitName: string,
    network: PersistedNetworkRecord,
  ): Promise<PersistedContainerComputer["runtime"]>;
  abstract createVmComputer(
    input: CreateVmComputerInput,
    imagePath: string,
    network: PersistedNetworkRecord,
  ): Promise<PersistedVmComputer["runtime"]>;
  abstract deleteBrowserRuntimeIdentity(computer: PersistedBrowserComputer): Promise<void>;
  abstract deleteContainerComputer(computer: PersistedContainerComputer): Promise<void>;
  abstract deleteVmComputer(computer: PersistedVmComputer): Promise<void>;
  abstract ensureBrowserRuntimeIdentity(computer: PersistedBrowserComputer): Promise<void>;
  abstract prepareBrowserRuntime(computer: PersistedBrowserComputer): Promise<void>;
  abstract prepareVmRuntime(computer: PersistedVmComputer): Promise<void>;
  abstract createAutomationSession(
    computer: PersistedBrowserComputer,
  ): Promise<ComputerAutomationSession>;
  abstract createAudioSession(computer: PersistedBrowserComputer): Promise<ComputerAudioSession>;
  abstract createMonitorSession(
    computer: PersistedBrowserComputer | PersistedVmComputer,
  ): Promise<ComputerMonitorSession>;
  abstract createPersistentUnit(computer: PersistedComputer): Promise<UnitRuntimeState>;
  abstract createScreenshot(computer: PersistedBrowserComputer): Promise<ComputerScreenshot>;
  abstract createVmSnapshot(
    computer: PersistedVmComputer,
    input: CreateComputerSnapshotInput,
  ): Promise<ComputerSnapshot>;
  abstract deletePersistentUnit(unitName: string): Promise<void>;
  abstract deleteVmSnapshot(computer: PersistedVmComputer, snapshotName: string): Promise<void>;
  abstract getContainerRuntimeState(
    computer: PersistedContainerComputer,
  ): Promise<UnitRuntimeState | null>;
  abstract getRuntimeState(unitName: string): Promise<UnitRuntimeState | null>;
  abstract listHostUnits(): Promise<HostUnitSummary[]>;
  abstract listVmSnapshots(computer: PersistedVmComputer): Promise<ComputerSnapshot[]>;
  abstract getHostUnit(unitName: string): Promise<HostUnitDetail | null>;
  abstract openAutomationAttach(
    computer: PersistedBrowserComputer,
  ): Promise<BrowserAutomationLease>;
  abstract openAudioStream(computer: PersistedBrowserComputer): Promise<BrowserAudioStreamLease>;
  abstract openMonitorAttach(
    computer: PersistedBrowserComputer | PersistedVmComputer,
  ): Promise<BrowserMonitorLease>;
  abstract restartUnit(unitName: string): Promise<UnitRuntimeState>;
  abstract restartContainerComputer(
    computer: PersistedContainerComputer,
  ): Promise<UnitRuntimeState>;
  abstract startUnit(unitName: string): Promise<UnitRuntimeState>;
  abstract startContainerComputer(computer: PersistedContainerComputer): Promise<UnitRuntimeState>;
  abstract stopUnit(unitName: string): Promise<UnitRuntimeState>;
  abstract stopContainerComputer(computer: PersistedContainerComputer): Promise<UnitRuntimeState>;
  abstract restoreVmComputer(
    computer: PersistedVmComputer,
    input: RestoreComputerInput,
  ): Promise<void>;
  abstract updateBrowserViewport(
    computer: PersistedBrowserComputer,
    viewport: BrowserViewport,
  ): Promise<void>;
}

export interface ConsoleAttachLease {
  command: string;
  args: string[];
  computerName: string;
  cwd?: string;
  env?: Record<string, string>;
  pty?: boolean;
  release: () => void;
}

export interface BrowserMonitorLease {
  computerName: string;
  host: string;
  port: number;
  release: () => void;
}

export interface BrowserAutomationLease {
  computerName: string;
  url: string;
  release: () => void;
}

export interface BrowserAudioStreamLease {
  computerName: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  targetNodeId?: number;
  targetSelector: string;
  release: () => void;
}

export abstract class ComputerMetadataStore {
  abstract deleteComputer(name: string): Promise<void>;
  abstract getComputer(name: string): Promise<PersistedComputer | null>;
  abstract listComputers(): Promise<PersistedComputer[]>;
  abstract putComputer(computer: PersistedComputer): Promise<void>;
}

export type {
  BrowserRuntime,
  BrowserViewport,
  ComputerAutomationSession,
  ComputerAudioSession,
  ComputerConsoleSession,
  ComputerExecSession,
  ComputerDetail,
  ComputerMonitorSession,
  ComputerSummary,
  ComputerScreenshot,
  ComputerSnapshot,
  CreateBrowserComputerInput,
  CreateComputerInput,
  CreateComputerSnapshotInput,
  CreateContainerComputerInput,
  CreateHostComputerInput,
  RestoreComputerInput,
  CreateVmComputerInput,
  CreateVmRuntime,
  HostUnitDetail,
  HostUnitSummary,
  HostRuntime,
  VmRuntime,
  UpdateBrowserViewportInput,
};
