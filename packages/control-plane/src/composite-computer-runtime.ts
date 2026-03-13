import type { BrowserViewport, RestoreComputerInput } from "@computerd/core";
import type { DockerRuntime } from "./docker/runtime";
import type { SystemdRuntime } from "./systemd/runtime";
import {
  ComputerRuntimePort,
  type PersistedBrowserComputer,
  type PersistedComputer,
  type PersistedContainerComputer,
  type PersistedVmComputer,
} from "./shared";

export class CompositeComputerRuntime extends ComputerRuntimePort {
  constructor(
    private readonly systemdRuntime: SystemdRuntime,
    private readonly dockerRuntime: DockerRuntime,
  ) {
    super();
  }

  createContainerComputer(input: Parameters<DockerRuntime["createContainerComputer"]>[0], unitName: string) {
    return this.dockerRuntime.createContainerComputer(input, unitName);
  }

  createVmComputer(input: Parameters<SystemdRuntime["createVmComputer"]>[0], imagePath: string) {
    return this.systemdRuntime.createVmComputer(input, imagePath);
  }

  deleteBrowserRuntimeIdentity(computer: PersistedBrowserComputer) {
    return this.systemdRuntime.deleteBrowserRuntimeIdentity(computer);
  }

  deleteContainerComputer(computer: PersistedContainerComputer) {
    return this.dockerRuntime.deleteContainerComputer(computer);
  }

  deleteVmComputer(computer: PersistedVmComputer) {
    return this.systemdRuntime.deleteVmComputer(computer);
  }

  ensureBrowserRuntimeIdentity(computer: PersistedBrowserComputer) {
    return this.systemdRuntime.ensureBrowserRuntimeIdentity(computer);
  }

  prepareBrowserRuntime(computer: PersistedBrowserComputer) {
    return this.systemdRuntime.prepareBrowserRuntime(computer);
  }

  prepareVmRuntime(computer: PersistedVmComputer) {
    return this.systemdRuntime.prepareVmRuntime(computer);
  }

  createAutomationSession(computer: PersistedBrowserComputer) {
    return this.systemdRuntime.createAutomationSession(computer);
  }

  createAudioSession(computer: PersistedBrowserComputer) {
    return this.systemdRuntime.createAudioSession(computer);
  }

  createMonitorSession(computer: PersistedBrowserComputer | PersistedVmComputer) {
    return this.systemdRuntime.createMonitorSession(computer);
  }

  createPersistentUnit(computer: PersistedComputer) {
    return this.systemdRuntime.createPersistentUnit(computer);
  }

  createScreenshot(computer: PersistedBrowserComputer) {
    return this.systemdRuntime.createScreenshot(computer);
  }

  createVmSnapshot(
    computer: PersistedVmComputer,
    input: Parameters<SystemdRuntime["createVmSnapshot"]>[1],
  ) {
    return this.systemdRuntime.createVmSnapshot(computer, input);
  }

  deletePersistentUnit(unitName: string) {
    return this.systemdRuntime.deletePersistentUnit(unitName);
  }

  deleteVmSnapshot(computer: PersistedVmComputer, snapshotName: string) {
    return this.systemdRuntime.deleteVmSnapshot(computer, snapshotName);
  }

  getContainerRuntimeState(computer: PersistedContainerComputer) {
    return this.dockerRuntime.getContainerRuntimeState(computer);
  }

  getRuntimeState(unitName: string) {
    return this.systemdRuntime.getRuntimeState(unitName);
  }

  listHostUnits() {
    return this.systemdRuntime.listHostUnits();
  }

  listVmSnapshots(computer: PersistedVmComputer) {
    return this.systemdRuntime.listVmSnapshots(computer);
  }

  getHostUnit(unitName: string) {
    return this.systemdRuntime.getHostUnit(unitName);
  }

  openAutomationAttach(computer: PersistedBrowserComputer) {
    return this.systemdRuntime.openAutomationAttach(computer);
  }

  openAudioStream(computer: PersistedBrowserComputer) {
    return this.systemdRuntime.openAudioStream(computer);
  }

  openMonitorAttach(computer: PersistedBrowserComputer | PersistedVmComputer) {
    return this.systemdRuntime.openMonitorAttach(computer);
  }

  restartUnit(unitName: string) {
    return this.systemdRuntime.restartUnit(unitName);
  }

  restartContainerComputer(computer: PersistedContainerComputer) {
    return this.dockerRuntime.restartContainerComputer(computer);
  }

  startUnit(unitName: string) {
    return this.systemdRuntime.startUnit(unitName);
  }

  startContainerComputer(computer: PersistedContainerComputer) {
    return this.dockerRuntime.startContainerComputer(computer);
  }

  stopUnit(unitName: string) {
    return this.systemdRuntime.stopUnit(unitName);
  }

  stopContainerComputer(computer: PersistedContainerComputer) {
    return this.dockerRuntime.stopContainerComputer(computer);
  }

  restoreVmComputer(computer: PersistedVmComputer, input: RestoreComputerInput) {
    return this.systemdRuntime.restoreVmComputer(computer, input);
  }

  updateBrowserViewport(computer: PersistedBrowserComputer, viewport: BrowserViewport) {
    return this.systemdRuntime.updateBrowserViewport(computer, viewport);
  }
}
