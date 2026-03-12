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
  ComputerNetwork,
  ComputerProfile,
  ComputerResources,
  ComputerScreenshot,
  ComputerStorage,
  ComputerSummary,
  CreateBrowserRuntime,
  CreateBrowserComputerInput,
  CreateComputerInput,
  CreateContainerComputerInput,
  CreateContainerRuntime,
  CreateHostComputerInput,
  CreateVmComputerInput,
  CreateVmRuntime,
  HostUnitDetail,
  HostUnitSummary,
  HostRuntime,
  VmRuntime,
  UpdateBrowserViewportInput,
} from "@computerd/core";

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
  network: ComputerNetwork;
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
  runtime: CreateVmRuntime & {
    accelerator: "kvm";
    architecture: "x86_64";
    machine: "q35";
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

export interface ComputerRuntimePort {
  createContainerComputer: (
    input: CreateContainerComputerInput,
    unitName: string,
  ) => Promise<PersistedContainerComputer["runtime"]>;
  createVmComputer: (input: CreateVmComputerInput) => Promise<PersistedVmComputer["runtime"]>;
  deleteBrowserRuntimeIdentity: (computer: PersistedBrowserComputer) => Promise<void>;
  deleteContainerComputer: (computer: PersistedContainerComputer) => Promise<void>;
  deleteVmComputer: (computer: PersistedVmComputer) => Promise<void>;
  ensureBrowserRuntimeIdentity: (computer: PersistedBrowserComputer) => Promise<void>;
  prepareBrowserRuntime: (computer: PersistedBrowserComputer) => Promise<void>;
  prepareVmRuntime: (computer: PersistedVmComputer) => Promise<void>;
  createAutomationSession: (
    computer: PersistedBrowserComputer,
  ) => Promise<ComputerAutomationSession>;
  createAudioSession: (computer: PersistedBrowserComputer) => Promise<ComputerAudioSession>;
  createMonitorSession: (
    computer: PersistedBrowserComputer | PersistedVmComputer,
  ) => Promise<ComputerMonitorSession>;
  createPersistentUnit: (computer: PersistedComputer) => Promise<UnitRuntimeState>;
  createScreenshot: (computer: PersistedBrowserComputer) => Promise<ComputerScreenshot>;
  deletePersistentUnit: (unitName: string) => Promise<void>;
  getContainerRuntimeState: (
    computer: PersistedContainerComputer,
  ) => Promise<UnitRuntimeState | null>;
  getRuntimeState: (unitName: string) => Promise<UnitRuntimeState | null>;
  listHostUnits: () => Promise<HostUnitSummary[]>;
  getHostUnit: (unitName: string) => Promise<HostUnitDetail | null>;
  openAutomationAttach: (computer: PersistedBrowserComputer) => Promise<BrowserAutomationLease>;
  openAudioStream: (computer: PersistedBrowserComputer) => Promise<BrowserAudioStreamLease>;
  openMonitorAttach: (
    computer: PersistedBrowserComputer | PersistedVmComputer,
  ) => Promise<BrowserMonitorLease>;
  restartUnit: (unitName: string) => Promise<UnitRuntimeState>;
  restartContainerComputer: (computer: PersistedContainerComputer) => Promise<UnitRuntimeState>;
  startUnit: (unitName: string) => Promise<UnitRuntimeState>;
  startContainerComputer: (computer: PersistedContainerComputer) => Promise<UnitRuntimeState>;
  stopUnit: (unitName: string) => Promise<UnitRuntimeState>;
  stopContainerComputer: (computer: PersistedContainerComputer) => Promise<UnitRuntimeState>;
  updateBrowserViewport: (
    computer: PersistedBrowserComputer,
    viewport: BrowserViewport,
  ) => Promise<void>;
}

export interface ConsoleAttachLease {
  command: string;
  args: string[];
  computerName: string;
  cwd?: string;
  env?: Record<string, string>;
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

export interface ComputerMetadataStore {
  deleteComputer: (name: string) => Promise<void>;
  getComputer: (name: string) => Promise<PersistedComputer | null>;
  listComputers: () => Promise<PersistedComputer[]>;
  putComputer: (computer: PersistedComputer) => Promise<void>;
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
  CreateBrowserComputerInput,
  CreateComputerInput,
  CreateContainerComputerInput,
  CreateHostComputerInput,
  CreateVmComputerInput,
  CreateVmRuntime,
  HostUnitDetail,
  HostUnitSummary,
  HostRuntime,
  VmRuntime,
  UpdateBrowserViewportInput,
};
