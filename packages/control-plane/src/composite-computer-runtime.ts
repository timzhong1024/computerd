import type {
  DisplayAction,
  ResizeDisplayInput,
  RestoreComputerInput,
  RunDisplayActionsObserve,
} from "@computerd/core";
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

  createBrowserComputer(
    input: Parameters<DockerRuntime["createBrowserComputer"]>[0],
    unitName: string,
    network: Parameters<DockerRuntime["createBrowserComputer"]>[2],
  ) {
    return this.dockerRuntime.createBrowserComputer(input, unitName, network);
  }

  createContainerComputer(
    input: Parameters<DockerRuntime["createContainerComputer"]>[0],
    unitName: string,
    network: Parameters<DockerRuntime["createContainerComputer"]>[2],
  ) {
    return this.dockerRuntime.createContainerComputer(input, unitName, network);
  }

  createVmComputer(
    input: Parameters<SystemdRuntime["createVmComputer"]>[0],
    imagePath: string,
    network: Parameters<SystemdRuntime["createVmComputer"]>[2],
  ) {
    return this.systemdRuntime.createVmComputer(input, imagePath, network);
  }

  deleteBrowserRuntimeIdentity(computer: PersistedBrowserComputer) {
    return computer.runtime.provider === "container"
      ? Promise.resolve()
      : this.systemdRuntime.deleteBrowserRuntimeIdentity(computer);
  }

  deleteBrowserComputer(computer: PersistedBrowserComputer) {
    return this.dockerRuntime.deleteBrowserComputer(computer);
  }

  deleteContainerComputer(computer: PersistedContainerComputer) {
    return this.dockerRuntime.deleteContainerComputer(computer);
  }

  deleteVmComputer(computer: PersistedVmComputer) {
    return this.systemdRuntime.deleteVmComputer(computer);
  }

  ensureBrowserRuntimeIdentity(computer: PersistedBrowserComputer) {
    return computer.runtime.provider === "container"
      ? Promise.resolve()
      : this.systemdRuntime.ensureBrowserRuntimeIdentity(computer);
  }

  prepareBrowserRuntime(computer: PersistedBrowserComputer) {
    return computer.runtime.provider === "container"
      ? this.dockerRuntime.prepareBrowserRuntime(computer)
      : this.systemdRuntime.prepareBrowserRuntime(computer);
  }

  prepareVmRuntime(computer: PersistedVmComputer) {
    return this.systemdRuntime.prepareVmRuntime(computer);
  }

  createAutomationSession(computer: PersistedBrowserComputer) {
    return this.dockerRuntime.createAutomationSession(computer);
  }

  createAudioSession(computer: PersistedBrowserComputer) {
    return this.dockerRuntime.createAudioSession(computer);
  }

  createMonitorSession(computer: PersistedBrowserComputer | PersistedVmComputer) {
    return computer.profile === "browser"
      ? this.dockerRuntime.createMonitorSession(computer)
      : this.systemdRuntime.createMonitorSession(computer);
  }

  createPersistentUnit(computer: PersistedComputer) {
    return this.systemdRuntime.createPersistentUnit(computer);
  }

  createScreenshot(computer: PersistedBrowserComputer | PersistedVmComputer) {
    return computer.profile === "browser"
      ? this.dockerRuntime.createScreenshot(computer)
      : this.systemdRuntime.createScreenshot(computer);
  }

  runDisplayActions(
    computer: PersistedBrowserComputer | PersistedVmComputer,
    ops: DisplayAction[],
    observe: RunDisplayActionsObserve,
  ) {
    return computer.profile === "browser"
      ? this.dockerRuntime.runDisplayActions(computer, ops, observe)
      : this.systemdRuntime.runDisplayActions(computer, ops, observe);
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

  getBrowserRuntimeState(computer: PersistedBrowserComputer) {
    return this.dockerRuntime.getBrowserRuntimeState(computer);
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
    return this.dockerRuntime.openAutomationAttach(computer);
  }

  openAudioStream(computer: PersistedBrowserComputer) {
    return this.dockerRuntime.openAudioStream(computer);
  }

  openMonitorAttach(computer: PersistedBrowserComputer | PersistedVmComputer) {
    return computer.profile === "browser"
      ? this.dockerRuntime.openMonitorAttach(computer)
      : this.systemdRuntime.openMonitorAttach(computer);
  }

  restartUnit(unitName: string) {
    return this.systemdRuntime.restartUnit(unitName);
  }

  restartContainerComputer(computer: PersistedContainerComputer) {
    return this.dockerRuntime.restartContainerComputer(computer);
  }

  restartBrowserComputer(computer: PersistedBrowserComputer) {
    return this.dockerRuntime.restartBrowserComputer(computer);
  }

  startUnit(unitName: string) {
    return this.systemdRuntime.startUnit(unitName);
  }

  startBrowserComputer(computer: PersistedBrowserComputer) {
    return this.dockerRuntime.startBrowserComputer(computer);
  }

  startContainerComputer(computer: PersistedContainerComputer) {
    return this.dockerRuntime.startContainerComputer(computer);
  }

  stopUnit(unitName: string) {
    return this.systemdRuntime.stopUnit(unitName);
  }

  stopBrowserComputer(computer: PersistedBrowserComputer) {
    return this.dockerRuntime.stopBrowserComputer(computer);
  }

  stopContainerComputer(computer: PersistedContainerComputer) {
    return this.dockerRuntime.stopContainerComputer(computer);
  }

  restoreVmComputer(computer: PersistedVmComputer, input: RestoreComputerInput) {
    return this.systemdRuntime.restoreVmComputer(computer, input);
  }

  resizeDisplay(
    computer: PersistedBrowserComputer | PersistedVmComputer,
    viewport: ResizeDisplayInput,
  ) {
    return computer.profile === "browser"
      ? this.dockerRuntime.resizeDisplay(computer, viewport)
      : this.systemdRuntime.resizeDisplay(computer, viewport);
  }
}
