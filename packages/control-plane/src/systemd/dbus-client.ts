import dbus from "dbus-next";
import type { ClientInterface, MessageBus, Variant } from "dbus-next";
import type { HostUnitDetail, HostUnitSummary, UnitRuntimeState } from "./types";

const SYSTEMD_BUS_NAME = "org.freedesktop.systemd1";
const SYSTEMD_MANAGER_PATH = "/org/freedesktop/systemd1";
const SYSTEMD_MANAGER_INTERFACE = "org.freedesktop.systemd1.Manager";
const SYSTEMD_UNIT_INTERFACE = "org.freedesktop.systemd1.Unit";
const SYSTEMD_SERVICE_INTERFACE = "org.freedesktop.systemd1.Service";
const DBUS_PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties";
const SYSTEMD_UNSET_UINT64 = BigInt("18446744073709551615");

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

export abstract class SystemdDbusClient {
  abstract deletePersistentUnit(unitName: string): Promise<void>;
  abstract getRuntimeState(unitName: string): Promise<UnitRuntimeState | null>;
  abstract listHostUnits(): Promise<HostUnitSummary[]>;
  abstract getHostUnit(unitName: string): Promise<HostUnitDetail | null>;
  abstract reloadDaemon(): Promise<void>;
  abstract restartUnit(unitName: string): Promise<UnitRuntimeState>;
  abstract setUnitEnabled(unitName: string, enabled: boolean): Promise<void>;
  abstract startUnit(unitName: string): Promise<UnitRuntimeState>;
  abstract stopUnit(unitName: string): Promise<UnitRuntimeState>;
}

export interface SystemdDbusClientOptions {
  bus?: MessageBus;
}

export class DefaultSystemdDbusClient extends SystemdDbusClient {
  private readonly managerPromise: Promise<SystemdManagerInterface>;
  private readonly unitProxyCache = new Map<string, Promise<CachedUnitProxy>>();
  private readonly runtimeCache = new Map<string, UnitRuntimeState>();
  private subscribed = false;

  constructor(private readonly bus: MessageBus = dbus.systemBus()) {
    super();
    this.managerPromise = getManager(bus);
  }

  async reloadDaemon() {
    const manager = await this.managerPromise;
    await manager.Reload();
  }

  async setUnitEnabled(unitName: string, enabled: boolean) {
    const manager = await this.managerPromise;
    if (enabled) {
      await manager.EnableUnitFiles([unitName], false, true);
      return;
    }

    await manager.DisableUnitFiles([unitName], false);
  }

  async startUnit(unitName: string) {
    const manager = await this.managerPromise;
    await this.ensureSubscribed();
    await manager.StartUnit(unitName, "replace");
    return await this.waitForRuntimeState(
      unitName,
      (state) => state.activeState !== "activating",
    );
  }

  async stopUnit(unitName: string) {
    const manager = await this.managerPromise;
    await this.ensureSubscribed();
    await manager.StopUnit(unitName, "replace");
    return await this.waitForRuntimeState(
      unitName,
      (state) => state.activeState !== "deactivating",
    );
  }

  async restartUnit(unitName: string) {
    const manager = await this.managerPromise;
    await this.ensureSubscribed();
    await manager.RestartUnit(unitName, "replace");
    return await this.waitForRuntimeState(
      unitName,
      (state) => state.activeState !== "activating",
    );
  }

  async deletePersistentUnit(unitName: string) {
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
  }

  async getRuntimeState(unitName: string) {
    try {
      const proxy = await this.getUnitProxy(unitName);
      const state = await readRuntimeState(unitName, proxy.properties);
      if (state === null) {
        this.runtimeCache.delete(unitName);
        return null;
      }
      this.runtimeCache.set(unitName, state);
      return state;
    } catch (error: unknown) {
      if (isUnknownUnitError(error)) {
        this.runtimeCache.delete(unitName);
        return null;
      }

      throw error;
    }
  }

  async listHostUnits() {
    const manager = await this.managerPromise;
    const units = await manager.ListUnits();
    return units
      .filter(([name]) => name.endsWith(".service"))
      .map(([name, description, loadState, activeState]) => ({
        unitName: name,
        unitType: "service",
        state: activeState,
        description: description || undefined,
        capabilities: {
          canInspect: loadState !== "not-found",
        },
      }))
      .sort((left, right) => left.unitName.localeCompare(right.unitName));
  }

  async getHostUnit(unitName: string) {
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
  }

  private async getUnitProxy(unitName: string) {
    const cached = this.unitProxyCache.get(unitName);
    if (cached) {
      return await cached;
    }

    const proxyPromise = createUnitProxy(this.bus, this.managerPromise, unitName, this.runtimeCache);
    this.unitProxyCache.set(unitName, proxyPromise);
    return await proxyPromise;
  }

  private async ensureSubscribed() {
    if (this.subscribed) {
      return;
    }

    const manager = await this.managerPromise;
    await manager.Subscribe();
    this.subscribed = true;
  }

  private async waitForRuntimeState(
    unitName: string,
    predicate: (state: UnitRuntimeState) => boolean,
  ) {
    const startedAt = Date.now();
    while (true) {
      const proxy = await this.getUnitProxy(unitName);
      const state = await readRuntimeState(unitName, proxy.properties);
      if (state === null) {
        throw createNoSuchUnitError(unitName);
      }
      this.runtimeCache.set(unitName, state);
      if (predicate(state)) {
        return state;
      }

      if (Date.now() - startedAt > 5_000) {
        throw new Error(`Timed out waiting for unit ${unitName} to reach a stable state.`);
      }

      await delay(100);
    }
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
        if (state === null) {
          runtimeCache.delete(unitName);
          return;
        }

        runtimeCache.set(unitName, state);
      })
      .catch(() => {
        runtimeCache.delete(unitName);
      });
  });

  return { properties };
}

async function readRuntimeState(
  unitName: string,
  properties: PropertiesInterface,
): Promise<UnitRuntimeState | null> {
  const unitProps = await properties.GetAll(SYSTEMD_UNIT_INTERFACE);
  const loadState = getString(unitProps, "LoadState") ?? "unknown";
  if (loadState === "not-found") {
    return null;
  }
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
    loadState,
    activeState: getString(unitProps, "ActiveState") ?? "inactive",
    subState: getString(unitProps, "SubState") ?? "dead",
    fragmentPath: getString(unitProps, "FragmentPath"),
    unitFileState: getString(unitProps, "UnitFileState"),
    execStart: getExecStart(serviceProps),
    workingDirectory: getString(serviceProps, "WorkingDirectory"),
    environment: getEnvironment(serviceProps),
    cpuWeight: getCpuWeight(unitName, serviceProps),
    memoryMaxMiB: getMemoryMaxMiB(serviceProps),
    execMainPid: getNumber(serviceProps, "ExecMainPID"),
    execMainStatus: getNumber(serviceProps, "ExecMainStatus"),
    result: getString(serviceProps, "Result"),
  };
}

function createNoSuchUnitError(unitName: string) {
  const error = new Error(`Unit ${unitName} was not found.`);
  error.name = "org.freedesktop.systemd1.NoSuchUnit";
  return error;
}

function createUnitPropertyRangeError(
  unitName: string,
  propertyName: string,
  value: number | string,
  expected: string,
) {
  const error = new Error(
    `Unit ${unitName} returned unsupported ${propertyName}=${value}. Expected ${expected}.`,
  );
  error.name = "SystemdUnitPropertyRangeError";
  return error;
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

function getCpuWeight(unitName: string, props: Record<string, Variant>) {
  const rawValue = props.CPUWeight?.value;
  if (rawValue === undefined) {
    return undefined;
  }

  if (typeof rawValue === "bigint") {
    if (rawValue === SYSTEMD_UNSET_UINT64) {
      return undefined;
    }

    if (rawValue > BigInt(Number.MAX_SAFE_INTEGER) || rawValue < 1n) {
      throw createUnitPropertyRangeError(
        unitName,
        "CPUWeight",
        rawValue.toString(),
        "1..10000 or uint64 max sentinel",
      );
    }

    const value = Number(rawValue);
    if (value > 10_000) {
      throw createUnitPropertyRangeError(unitName, "CPUWeight", value, "1..10000 safe integer");
    }

    return value;
  }

  if (typeof rawValue !== "number") {
    return undefined;
  }

  if (!Number.isSafeInteger(rawValue) || rawValue < 1 || rawValue > 10_000) {
    throw createUnitPropertyRangeError(unitName, "CPUWeight", rawValue, "1..10000 safe integer");
  }

  return rawValue;
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

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
