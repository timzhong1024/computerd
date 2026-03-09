import dbus from "dbus-next";
import type { ClientInterface, MessageBus, Variant } from "dbus-next";
import type { HostUnitDetail, HostUnitSummary, UnitRuntimeState } from "./types";

const SYSTEMD_BUS_NAME = "org.freedesktop.systemd1";
const SYSTEMD_MANAGER_PATH = "/org/freedesktop/systemd1";
const SYSTEMD_MANAGER_INTERFACE = "org.freedesktop.systemd1.Manager";
const SYSTEMD_UNIT_INTERFACE = "org.freedesktop.systemd1.Unit";
const SYSTEMD_SERVICE_INTERFACE = "org.freedesktop.systemd1.Service";
const DBUS_PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties";

// `ListUnits()` returns `(name, description, loadState, activeState, subState, followed, path, jobId, jobType, jobPath)`.
type UnitListEntry = [
  name: string,
  description: string,
  loadState: string,
  activeState: string,
  subState: string,
  followed: string,
  objectPath: string,
  jobId: number,
  jobType: string,
  jobPath: string,
];

// `EnableUnitFiles()` / `DisableUnitFiles()` returns `(type, file, destination)`.
type UnitFileChangeEntry = [changeType: string, fileName: string, destination: string];

// `Service.ExecStart` is `a(sasbttttuii)`.
// We only consume the command path at index 0 today, but name the full tuple for readability.
type ServiceExecCommandEntry = [
  path: string,
  argv: string[],
  ignoreFailure: boolean,
  startTimestampUsec: number | bigint,
  stopTimestampUsec: number | bigint,
  pid: number,
  code: number,
  status: number,
];

interface SystemdManagerInterface extends ClientInterface {
  DisableUnitFiles(files: string[], runtime: boolean): Promise<UnitFileChangeEntry[]>;
  EnableUnitFiles(
    files: string[],
    runtime: boolean,
    force: boolean,
  ): Promise<[carriesInstallInfo: boolean, changes: UnitFileChangeEntry[]]>;
  GetUnitFileState(file: string): Promise<string>;
  ListUnits(): Promise<UnitListEntry[]>;
  LoadUnit(name: string): Promise<string>;
  Reload(): Promise<void>;
  RestartUnit(name: string, mode: string): Promise<string>;
  StartUnit(name: string, mode: string): Promise<string>;
  StopUnit(name: string, mode: string): Promise<string>;
  Subscribe(): Promise<void>;
}

interface PropertiesInterface extends ClientInterface {
  Get(interfaceName: string, propertyName: string): Promise<Variant>;
  GetAll(interfaceName: string): Promise<Record<string, Variant>>;
}

interface CachedUnitProxy {
  properties: PropertiesInterface;
}

export interface SystemdDbusClient {
  deletePersistentUnit: (unitName: string) => Promise<void>;
  getRuntimeState: (unitName: string) => Promise<UnitRuntimeState | null>;
  listHostUnits: () => Promise<HostUnitSummary[]>;
  getHostUnit: (unitName: string) => Promise<HostUnitDetail | null>;
  reloadDaemon: () => Promise<void>;
  restartUnit: (unitName: string) => Promise<UnitRuntimeState>;
  setUnitEnabled: (unitName: string, enabled: boolean) => Promise<void>;
  startUnit: (unitName: string) => Promise<UnitRuntimeState>;
  stopUnit: (unitName: string) => Promise<UnitRuntimeState>;
}

export interface SystemdDbusClientOptions {
  bus?: MessageBus;
}

export function createSystemdDbusClient({
  bus = dbus.systemBus(),
}: SystemdDbusClientOptions = {}): SystemdDbusClient {
  const managerPromise = getManager(bus);
  const unitProxyCache = new Map<string, Promise<CachedUnitProxy>>();
  const runtimeCache = new Map<string, UnitRuntimeState>();
  let subscribed = false;

  return {
    async reloadDaemon() {
      const manager = await managerPromise;
      await manager.Reload();
    },
    async setUnitEnabled(unitName, enabled) {
      const manager = await managerPromise;
      if (enabled) {
        await manager.EnableUnitFiles([unitName], false, true);
        return;
      }

      await manager.DisableUnitFiles([unitName], false);
    },
    async startUnit(unitName) {
      const manager = await managerPromise;
      await ensureSubscribed();
      await manager.StartUnit(unitName, "replace");
      return await requireRuntimeState(unitName);
    },
    async stopUnit(unitName) {
      const manager = await managerPromise;
      await ensureSubscribed();
      await manager.StopUnit(unitName, "replace");
      return await requireRuntimeState(unitName);
    },
    async restartUnit(unitName) {
      const manager = await managerPromise;
      await ensureSubscribed();
      await manager.RestartUnit(unitName, "replace");
      return await requireRuntimeState(unitName);
    },
    async deletePersistentUnit(unitName) {
      const state = await this.getRuntimeState(unitName);
      if (state?.activeState === "active") {
        await this.stopUnit(unitName);
      }

      try {
        await this.setUnitEnabled(unitName, false);
      } catch (error: unknown) {
        if (!isUnknownUnitError(error)) {
          throw error;
        }
      }
    },
    async getRuntimeState(unitName) {
      try {
        const proxy = await getUnitProxy(unitName);
        const state = await readRuntimeState(unitName, proxy.properties);
        runtimeCache.set(unitName, state);
        return state;
      } catch (error: unknown) {
        if (isUnknownUnitError(error)) {
          runtimeCache.delete(unitName);
          return null;
        }

        throw error;
      }
    },
    async listHostUnits() {
      const manager = await managerPromise;
      const units = await manager.ListUnits();
      return units
        .filter(([name]) => name.endsWith(".service"))
        .map(([name, description, loadState, activeState, subState]) => ({
          unitName: name,
          unitType: "service",
          state: activeState,
          description: description || undefined,
          capabilities: {
            canInspect: loadState !== "not-found",
          },
        }))
        .sort((left, right) => left.unitName.localeCompare(right.unitName));
    },
    async getHostUnit(unitName) {
      const state = await this.getRuntimeState(unitName);
      if (state === null) {
        return null;
      }

      return {
        unitName: state.unitName,
        unitType: state.unitType,
        state: state.activeState,
        description: state.description,
        capabilities: {
          canInspect: true,
        },
        execStart: state.execStart ?? "[not configured]",
        status: {
          activeState: state.activeState,
          subState: state.subState,
          loadState: state.loadState,
        },
        recentLogs: [],
      };
    },
  };

  async function getUnitProxy(unitName: string) {
    const cached = unitProxyCache.get(unitName);
    if (cached) {
      return await cached;
    }

    const proxyPromise = createUnitProxy(bus, managerPromise, unitName, runtimeCache);
    unitProxyCache.set(unitName, proxyPromise);
    return await proxyPromise;
  }

  async function ensureSubscribed() {
    if (subscribed) {
      return;
    }

    const manager = await managerPromise;
    await manager.Subscribe();
    subscribed = true;
  }

  async function requireRuntimeState(unitName: string) {
    return await getRuntimeStateOrThrow(unitName, getUnitProxy, runtimeCache);
  }
}

async function getManager(bus: MessageBus) {
  const proxy = await bus.getProxyObject(SYSTEMD_BUS_NAME, SYSTEMD_MANAGER_PATH);
  return proxy.getInterface<SystemdManagerInterface>(SYSTEMD_MANAGER_INTERFACE);
}

async function createUnitProxy(
  bus: MessageBus,
  managerPromise: Promise<SystemdManagerInterface>,
  unitName: string,
  runtimeCache: Map<string, UnitRuntimeState>,
): Promise<CachedUnitProxy> {
  const manager = await managerPromise;
  const objectPath = await manager.LoadUnit(unitName);
  const proxy = await bus.getProxyObject(SYSTEMD_BUS_NAME, objectPath);
  const properties = proxy.getInterface<PropertiesInterface>(DBUS_PROPERTIES_INTERFACE);
  properties.on("PropertiesChanged", (interfaceName: string) => {
    if (interfaceName !== SYSTEMD_UNIT_INTERFACE && interfaceName !== SYSTEMD_SERVICE_INTERFACE) {
      return;
    }

    void readRuntimeState(unitName, properties)
      .then((state) => {
        runtimeCache.set(unitName, state);
      })
      .catch(() => {
        runtimeCache.delete(unitName);
      });
  });

  return { properties };
}

async function getRuntimeStateOrThrow(
  unitName: string,
  getUnitProxy: (unitName: string) => Promise<CachedUnitProxy>,
  runtimeCache: Map<string, UnitRuntimeState>,
) {
  const cached = runtimeCache.get(unitName);
  if (cached) {
    return cached;
  }

  const proxy = await getUnitProxy(unitName);
  const state = await readRuntimeState(unitName, proxy.properties);
  runtimeCache.set(unitName, state);
  return state;
}

async function readRuntimeState(
  unitName: string,
  properties: PropertiesInterface,
): Promise<UnitRuntimeState> {
  const unitProps = await properties.GetAll(SYSTEMD_UNIT_INTERFACE);
  const serviceProps = await properties
    .GetAll(SYSTEMD_SERVICE_INTERFACE)
    .catch((error: unknown) => {
      if (isUnknownInterfaceError(error)) {
        return {};
      }

      throw error;
    });

  return {
    unitName,
    description: getString(unitProps, "Description"),
    unitType: inferUnitType(unitName),
    loadState: getString(unitProps, "LoadState") ?? "unknown",
    activeState: getString(unitProps, "ActiveState") ?? "inactive",
    subState: getString(unitProps, "SubState") ?? "dead",
    fragmentPath: getString(unitProps, "FragmentPath"),
    unitFileState: getString(unitProps, "UnitFileState"),
    execStart: getExecStart(serviceProps),
    workingDirectory: getString(serviceProps, "WorkingDirectory"),
    environment: getEnvironment(serviceProps),
    cpuWeight: getNumber(serviceProps, "CPUWeight"),
    memoryMaxMiB: getMemoryMaxMiB(serviceProps),
    execMainPid: getNumber(serviceProps, "ExecMainPID"),
    execMainStatus: getNumber(serviceProps, "ExecMainStatus"),
    result: getString(serviceProps, "Result"),
  };
}

function getExecStart(props: Record<string, Variant>) {
  const value = props.ExecStart?.value as ServiceExecCommandEntry[] | undefined;
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const first = value[0];
  if (!Array.isArray(first) || typeof first[0] !== "string") {
    return undefined;
  }

  return first[0];
}

function getEnvironment(props: Record<string, Variant>) {
  const value = props.Environment?.value;
  if (!Array.isArray(value)) {
    return undefined;
  }

  const environment = Object.fromEntries(
    value
      .filter((entry): entry is string => typeof entry === "string" && entry.includes("="))
      .map((entry) => {
        const index = entry.indexOf("=");
        return [entry.slice(0, index), entry.slice(index + 1)];
      }),
  );

  return Object.keys(environment).length > 0 ? environment : undefined;
}

function getMemoryMaxMiB(props: Record<string, Variant>) {
  const value = getBigIntLike(props, "MemoryMax");
  if (value === undefined || value <= 0 || value >= Number.MAX_SAFE_INTEGER) {
    return undefined;
  }

  return Math.floor(value / (1024 * 1024));
}

function getString(props: Record<string, Variant>, key: string) {
  const value = props[key]?.value;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getNumber(props: Record<string, Variant>, key: string) {
  const value = getBigIntLike(props, key);
  return value !== undefined ? Number(value) : undefined;
}

function getBigIntLike(props: Record<string, Variant>, key: string) {
  const value = props[key]?.value;
  if (typeof value === "bigint") {
    return Number(value);
  }

  return typeof value === "number" ? value : undefined;
}

function inferUnitType(unitName: string) {
  const lastDot = unitName.lastIndexOf(".");
  return lastDot === -1 ? "unit" : unitName.slice(lastDot + 1);
}

function isUnknownUnitError(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.includes("NoSuchUnit") ||
      error.message.includes("Load failed") ||
      error.message.includes("not loaded"))
  );
}

function isUnknownInterfaceError(error: unknown) {
  return error instanceof Error && error.message.includes("UnknownInterface");
}
