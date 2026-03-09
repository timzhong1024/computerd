import type {
  BrowserRuntime,
  ComputerConsoleSession,
  ComputerAccess,
  ComputerDetail,
  ComputerLifecycle,
  ComputerNetwork,
  ComputerProfile,
  ComputerResources,
  ComputerState,
  ComputerStorage,
  ComputerSummary,
  CreateBrowserComputerInput,
  CreateComputerInput,
  CreateTerminalComputerInput,
  HostUnitDetail,
  HostUnitSummary,
  TerminalRuntime,
} from "@computerd/core";

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

export interface PersistedTerminalComputer extends PersistedComputerBase {
  profile: "terminal";
  runtime: TerminalRuntime;
}

export interface PersistedBrowserComputer extends PersistedComputerBase {
  profile: "browser";
  runtime: BrowserRuntime;
}

export type PersistedComputer = PersistedTerminalComputer | PersistedBrowserComputer;

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

export interface TerminalConsoleRuntimeSpec {
  directoryPath: string;
  sessionName: string;
  socketPath: string;
}

export interface ComputerRuntimePort {
  createPersistentUnit: (computer: PersistedTerminalComputer) => Promise<UnitRuntimeState>;
  deletePersistentUnit: (unitName: string) => Promise<void>;
  getRuntimeState: (unitName: string) => Promise<UnitRuntimeState | null>;
  listHostUnits: () => Promise<HostUnitSummary[]>;
  getHostUnit: (unitName: string) => Promise<HostUnitDetail | null>;
  restartUnit: (unitName: string) => Promise<UnitRuntimeState>;
  startUnit: (unitName: string) => Promise<UnitRuntimeState>;
  stopUnit: (unitName: string) => Promise<UnitRuntimeState>;
}

export interface ConsoleAttachLease {
  command: string;
  args: string[];
  computerName: string;
  cwd?: string;
  env?: Record<string, string>;
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
  ComputerConsoleSession,
  ComputerDetail,
  ComputerSummary,
  CreateBrowserComputerInput,
  CreateComputerInput,
  CreateTerminalComputerInput,
  HostUnitDetail,
  HostUnitSummary,
  TerminalRuntime,
};
