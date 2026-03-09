import {
  createComputerCapabilities,
  type BrowserRuntime,
  type ComputerAccess,
  type ComputerDetail,
  type ComputerLifecycle,
  type ComputerNetwork,
  type ComputerProfile,
  type ComputerResources,
  type ComputerState,
  type ComputerStorage,
  type ComputerSummary,
  type CreateBrowserComputerInput,
  type CreateComputerInput,
  type CreateTerminalComputerInput,
  type HostUnitDetail,
  type HostUnitSummary,
  type TerminalRuntime,
} from "@computerd/core";

interface StoredComputerBase {
  name: string;
  unitName: string;
  description?: string;
  createdAt: string;
  lastActionAt: string;
  profile: ComputerProfile;
  state: ComputerState;
  access: ComputerAccess;
  resources: ComputerResources;
  storage: ComputerStorage;
  network: ComputerNetwork;
  lifecycle: ComputerLifecycle;
}

interface StoredTerminalComputer extends StoredComputerBase {
  profile: "terminal";
  runtime: TerminalRuntime;
}

interface StoredBrowserComputer extends StoredComputerBase {
  profile: "browser";
  runtime: BrowserRuntime;
}

type StoredComputer = StoredTerminalComputer | StoredBrowserComputer;

const defaultHostUnits: HostUnitDetail[] = [
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
    recentLogs: ["Mar 09 09:00:00 dockerd started", "Mar 09 09:02:10 bridge network ready"],
  },
  {
    unitName: "tailscaled.service",
    unitType: "service",
    state: "active",
    description: "Tailscale node agent",
    capabilities: {
      canInspect: true,
    },
    execStart: "/usr/sbin/tailscaled --state=/var/lib/tailscale/tailscaled.state",
    status: {
      activeState: "active",
      subState: "running",
      loadState: "loaded",
    },
    recentLogs: ["Mar 09 09:01:00 control connected", "Mar 09 09:03:00 health check passed"],
  },
];

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

export interface ControlPlane {
  createComputer: (input: CreateComputerInput) => Promise<ComputerDetail>;
  getComputer: (name: string) => Promise<ComputerDetail>;
  listComputers: () => Promise<ComputerSummary[]>;
  listHostUnits: () => Promise<HostUnitSummary[]>;
  getHostUnit: (unitName: string) => Promise<HostUnitDetail>;
  restartComputer: (name: string) => Promise<ComputerDetail>;
  startComputer: (name: string) => Promise<ComputerDetail>;
  stopComputer: (name: string) => Promise<ComputerDetail>;
}

export function createControlPlane(environment: NodeJS.ProcessEnv = process.env): ControlPlane {
  const hostUnits = structuredClone(defaultHostUnits);
  const computers = new Map<string, StoredComputer>();

  if (environment.COMPUTERD_USE_FIXTURE === "1") {
    const seeded = createStoredComputer({
      name: "starter-terminal",
      profile: "terminal",
      description: "Fixture terminal computer for development and smoke tests.",
      runtime: {
        execStart: "/usr/bin/bash -lc 'echo ready && sleep infinity'",
      },
      access: {
        console: {
          mode: "pty",
          writable: true,
        },
        logs: true,
      },
    });
    computers.set(seeded.name, seeded);
  }

  return {
    async listComputers() {
      return [...computers.values()].map(toComputerSummary).sort(compareByName);
    },
    async getComputer(name) {
      return toComputerDetail(getComputerRecord(computers, name));
    },
    async createComputer(input) {
      if (computers.has(input.name)) {
        throw new ComputerConflictError(input.name);
      }

      const computer = createStoredComputer(input);
      computers.set(computer.name, computer);
      return toComputerDetail(computer);
    },
    async startComputer(name) {
      const computer = getComputerRecord(computers, name);
      computer.state = "running";
      computer.lastActionAt = new Date().toISOString();
      return toComputerDetail(computer);
    },
    async stopComputer(name) {
      const computer = getComputerRecord(computers, name);
      computer.state = "stopped";
      computer.lastActionAt = new Date().toISOString();
      return toComputerDetail(computer);
    },
    async restartComputer(name) {
      const computer = getComputerRecord(computers, name);
      computer.state = "running";
      computer.lastActionAt = new Date().toISOString();
      return toComputerDetail(computer);
    },
    async listHostUnits() {
      return hostUnits.map(toHostUnitSummary).sort(compareByUnitName);
    },
    async getHostUnit(unitName) {
      const detail = hostUnits.find((unit) => unit.unitName === unitName);
      if (detail === undefined) {
        throw new HostUnitNotFoundError(unitName);
      }

      return detail;
    },
  };
}

function createStoredComputer(input: CreateComputerInput): StoredComputer {
  const timestamp = new Date().toISOString();
  const unitName = `computerd-${slugify(input.name)}.service`;
  const common = {
    name: input.name,
    unitName,
    description: input.description,
    createdAt: timestamp,
    lastActionAt: timestamp,
    profile: input.profile,
    state: "stopped" as const,
    access:
      input.access ??
      (input.profile === "terminal"
        ? {
            console: {
              mode: "pty",
              writable: true,
            },
            logs: true,
          }
        : {
            display: {
              mode: "virtual-display",
            },
            logs: true,
          }),
    resources: input.resources ?? {},
    storage: input.storage ?? {
      rootMode: "persistent",
    },
    network: input.network ?? {
      mode: "host",
    },
    lifecycle: input.lifecycle ?? {},
  };

  if (input.profile === "terminal") {
    return {
      ...common,
      profile: "terminal",
      runtime: input.runtime,
    } satisfies StoredTerminalComputer;
  }

  return {
    ...common,
    profile: "browser",
    runtime: input.runtime,
  } satisfies StoredBrowserComputer;
}

function getComputerRecord(computers: Map<string, StoredComputer>, name: string) {
  const computer = computers.get(name);
  if (computer === undefined) {
    throw new ComputerNotFoundError(name);
  }

  return computer;
}

function toComputerSummary(computer: StoredComputer): ComputerSummary {
  return {
    name: computer.name,
    unitName: computer.unitName,
    profile: computer.profile,
    state: computer.state,
    description: computer.description,
    createdAt: computer.createdAt,
    access: computer.access,
    capabilities: createComputerCapabilities(computer.profile, computer.state),
  };
}

function toComputerDetail(computer: StoredComputer): ComputerDetail {
  const common = {
    ...toComputerSummary(computer),
    resources: computer.resources,
    storage: computer.storage,
    network: computer.network,
    lifecycle: computer.lifecycle,
    status: {
      lastActionAt: computer.lastActionAt,
      primaryUnit: computer.unitName,
    },
  };

  if (computer.profile === "terminal") {
    return {
      ...common,
      profile: "terminal",
      runtime: computer.runtime,
    };
  }

  return {
    ...common,
    profile: "browser",
    runtime: computer.runtime,
  };
}

function toHostUnitSummary(detail: HostUnitDetail): HostUnitSummary {
  return {
    unitName: detail.unitName,
    unitType: detail.unitType,
    state: detail.state,
    description: detail.description,
    capabilities: detail.capabilities,
  };
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

function compareByUnitName(left: HostUnitSummary, right: HostUnitSummary) {
  return left.unitName.localeCompare(right.unitName);
}

export type {
  BrowserRuntime,
  ComputerDetail,
  ComputerSummary,
  CreateBrowserComputerInput,
  CreateComputerInput,
  CreateTerminalComputerInput,
  HostUnitDetail,
  HostUnitSummary,
  TerminalRuntime,
};
