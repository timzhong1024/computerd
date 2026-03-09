import type { HostUnitDetail, HostUnitSummary, PersistedTerminalComputer, UnitRuntimeState } from "./types";
import { createFileUnitStore, type FileUnitStoreOptions, type UnitFileStore } from "./unit-file-store";
import { createSystemdDbusClient, type SystemdDbusClient, type SystemdDbusClientOptions } from "./dbus-client";

export interface SystemdRuntime {
  createPersistentUnit: (computer: PersistedTerminalComputer) => Promise<UnitRuntimeState>;
  deletePersistentUnit: (unitName: string) => Promise<void>;
  getHostUnit: (unitName: string) => Promise<HostUnitDetail | null>;
  getRuntimeState: (unitName: string) => Promise<UnitRuntimeState | null>;
  listHostUnits: () => Promise<HostUnitSummary[]>;
  restartUnit: (unitName: string) => Promise<UnitRuntimeState>;
  startUnit: (unitName: string) => Promise<UnitRuntimeState>;
  stopUnit: (unitName: string) => Promise<UnitRuntimeState>;
}

export interface CreateSystemdRuntimeOptions {
  dbusClient?: SystemdDbusClient;
  dbusClientOptions?: SystemdDbusClientOptions;
  unitFileStore?: UnitFileStore;
  unitFileStoreOptions: FileUnitStoreOptions;
}

export function createSystemdRuntime({
  dbusClientOptions,
  unitFileStoreOptions,
  dbusClient,
  unitFileStore,
}: CreateSystemdRuntimeOptions): SystemdRuntime {
  const resolvedDbusClient = dbusClient ?? createSystemdDbusClient(dbusClientOptions);
  const resolvedUnitFileStore = unitFileStore ?? createFileUnitStore(unitFileStoreOptions);

  return {
    async createPersistentUnit(computer) {
      await resolvedUnitFileStore.writeTerminalUnitFile(computer);
      await resolvedDbusClient.reloadDaemon();
      await resolvedDbusClient.setUnitEnabled(computer.unitName, computer.lifecycle.autostart === true);
      return (await resolvedDbusClient.getRuntimeState(computer.unitName)) ?? {
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
      };
    },
    async deletePersistentUnit(unitName) {
      await resolvedDbusClient.deletePersistentUnit(unitName);
      await resolvedUnitFileStore.deleteUnitFile(unitName);
      await resolvedDbusClient.reloadDaemon();
    },
    getRuntimeState: resolvedDbusClient.getRuntimeState,
    startUnit: resolvedDbusClient.startUnit,
    stopUnit: resolvedDbusClient.stopUnit,
    restartUnit: resolvedDbusClient.restartUnit,
    listHostUnits: resolvedDbusClient.listHostUnits,
    getHostUnit: resolvedDbusClient.getHostUnit,
  };
}
