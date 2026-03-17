import { setTimeout as delay } from "node:timers/promises";
import type {
  ComputerAudioSession,
  ComputerDetail,
  DisplayAction,
  CreateNetworkInput,
  ComputerSummary,
  CreateComputerInput,
  CreateComputerSnapshotInput,
  HostUnitDetail,
  HostUnitSummary,
  ManagedComputer,
  NetworkDetail,
  NetworkSummary,
  ResizeDisplayInput,
  RunDisplayActionsObserve,
  RunDisplayActionsResult,
  VmGuestCommandInput,
  VmGuestCommandResult,
  VmGuestFileReadInput,
  VmGuestFileReadResult,
  VmGuestFileWriteInput,
  VmGuestFileWriteResult,
} from "@computerd/core";
import {
  ComputerConflictError,
  ComputerConsoleUnavailableError,
  ComputerNotFoundError,
  ComputerSnapshotConflictError,
  ComputerSnapshotNotFoundError,
  HostUnitNotFoundError,
  UnsupportedComputerFeatureError,
  assertSupportedCreateInput,
  capitalize,
  compareByName,
  createGatewayManagedComputerRecord,
  createConsoleAttachLease,
  createConsoleSession,
  createContainerExecLease,
  createExecSession,
  createPersistedComputer,
  ensureDirectories,
  getPersistedComputerRuntimeState,
  isSnapshotConflictError,
  isSnapshotNotFoundError,
  mapComputerState,
  requireBrowserRecord,
  requireConsoleCapableRecord,
  requireContainerRecord,
  requireMonitorCapableRecord,
  requireVmRecord,
  supportsConsoleSessions,
  toUnitName,
  throwIfBroken,
  toComputerDetail,
  toComputerSummary,
  type BrowserAutomationLease,
  type BrowserAudioStreamLease,
  type BrowserMonitorLease,
  type BaseControlPlaneDependencies,
  type ComputerAutomationSession,
  type ComputerMetadataStore,
  type ComputerMonitorSession,
  type ComputerRuntimePort,
  type ComputerScreenshot,
  type ComputerSnapshot,
  type ConsoleAttachLease,
  type PersistedBrowserComputer,
  type PersistedComputer,
  type PersistedContainerComputer,
  type PersistedHostComputer,
  type PersistedVmComputer,
  type RestoreComputerInput,
  withBrowserViewport,
  withVmViewport,
} from "./shared";
import {
  AttachedNetworkDeleteError,
  DEFAULT_HOST_NETWORK_ID,
  type NetworkProvider,
  type PersistedNetworkRecord,
} from "./networks";

type ManagedGatewayComputerRecord = PersistedContainerComputer & {
  managed: Extract<ManagedComputer, { kind: "gateway" }>;
};

export abstract class BaseControlPlane {
  protected readonly environment: NodeJS.ProcessEnv;
  readonly imageProvider: BaseControlPlaneDependencies["imageProvider"];
  readonly networkProvider: NetworkProvider;
  protected readonly metadataStore: ComputerMetadataStore;
  protected readonly runtime: ComputerRuntimePort;
  protected readonly consoleRuntimePaths: BaseControlPlaneDependencies["consoleRuntimePaths"];
  protected readonly browserRuntimePaths: BaseControlPlaneDependencies["browserRuntimePaths"];
  protected readonly vmRuntimePaths: BaseControlPlaneDependencies["vmRuntimePaths"];
  protected readonly usesDefaultPersistence: boolean;
  protected readonly activeConsoleAttaches = new Set<string>();

  protected constructor(dependencies: BaseControlPlaneDependencies) {
    this.environment = dependencies.environment;
    this.imageProvider = dependencies.imageProvider;
    this.networkProvider = dependencies.networkProvider;
    this.metadataStore = dependencies.metadataStore;
    this.runtime = dependencies.runtime;
    this.consoleRuntimePaths = dependencies.consoleRuntimePaths;
    this.browserRuntimePaths = dependencies.browserRuntimePaths;
    this.vmRuntimePaths = dependencies.vmRuntimePaths;
    this.usesDefaultPersistence = dependencies.usesDefaultPersistence;
  }

  async listComputers(): Promise<ComputerSummary[]> {
    const [records, managedGatewayRecords] = await Promise.all([
      this.metadataStore.listComputers(),
      this.listManagedGatewayRecords(),
    ]);
    const summaries = await Promise.all(
      [...records, ...managedGatewayRecords].map((record) => this.toComputerSummary(record)),
    );
    return summaries.sort((left, right) => {
      const leftManaged = left.managed?.kind === "gateway";
      const rightManaged = right.managed?.kind === "gateway";
      if (leftManaged !== rightManaged) {
        return leftManaged ? 1 : -1;
      }
      return compareByName(left, right);
    });
  }

  async listNetworks(): Promise<NetworkSummary[]> {
    const [networks, computers] = await Promise.all([
      this.networkProvider.listNetworkRecords(),
      this.metadataStore.listComputers(),
    ]);
    return await Promise.all(
      networks.map((network) =>
        this.networkProvider.toNetworkSummary(
          network,
          computers.filter((computer) => computer.networkId === network.id).length,
        ),
      ),
    );
  }

  async getNetwork(id: string): Promise<NetworkDetail> {
    const [network, computers] = await Promise.all([
      this.networkProvider.getNetworkRecord(id),
      this.metadataStore.listComputers(),
    ]);
    return await this.networkProvider.toNetworkDetail(
      network,
      computers.filter((computer) => computer.networkId === network.id).length,
    );
  }

  async createNetwork(input: CreateNetworkInput): Promise<NetworkDetail> {
    const network = await this.networkProvider.createIsolatedNetwork(input);
    return await this.networkProvider.toNetworkDetail(network, 0);
  }

  async deleteNetwork(id: string) {
    if (id === DEFAULT_HOST_NETWORK_ID) {
      throw new AttachedNetworkDeleteError(id);
    }
    const computers = await this.metadataStore.listComputers();
    if (computers.some((computer) => computer.networkId === id)) {
      throw new AttachedNetworkDeleteError(id);
    }
    await this.networkProvider.deleteIsolatedNetwork(id);
  }

  async getComputer(name: string): Promise<ComputerDetail> {
    const record = (await this.getManagedGatewayRecord(name)) ?? (await this.requireComputer(name));
    return await this.toComputerDetail(record);
  }

  async createComputer(input: CreateComputerInput): Promise<ComputerDetail> {
    assertSupportedCreateInput(input);
    if (this.usesDefaultPersistence) {
      await ensureDirectories(this.environment);
    }

    const [records, managedGatewayRecords] = await Promise.all([
      this.metadataStore.listComputers(),
      this.listManagedGatewayRecords(),
    ]);
    const unitName = toUnitName(input.name);
    if (
      [...records, ...managedGatewayRecords].some(
        (record) => record.name === input.name || record.unitName === unitName,
      )
    ) {
      throw new ComputerConflictError(input.name);
    }
    if ((await this.runtime.getRuntimeState(unitName)) !== null) {
      throw new ComputerConflictError(input.name);
    }

    const network = await this.resolveComputerNetwork(input.networkId);
    this.assertSupportedNetworkAttachment(input, network);
    if (input.profile === "browser" || input.profile === "container" || input.profile === "vm") {
      await this.networkProvider.ensureNetworkRuntime(network);
    }

    const record = await createPersistedComputer(
      input,
      this.runtime,
      async (imageId, kind) => {
        const image = await this.imageProvider.requireVmImage(imageId, kind);
        return image.path;
      },
      network,
    );
    if (record.profile === "browser") {
      await this.runtime.ensureBrowserRuntimeIdentity(record);
    }
    if (
      record.profile !== "container" &&
      !(record.profile === "browser" && record.runtime.provider === "container")
    ) {
      await this.runtime.createPersistentUnit(record);
    }
    await this.metadataStore.putComputer(record);
    return await this.toComputerDetail(record);
  }

  async listComputerSnapshots(name: string): Promise<ComputerSnapshot[]> {
    const record = await this.requireComputer(name);
    const vmRecord = requireVmRecord(record);
    this.throwIfBroken(
      vmRecord,
      await this.runtime.getRuntimeState(vmRecord.unitName),
      "Snapshot listing is not supported for broken computers.",
    );
    return await this.runtime.listVmSnapshots(vmRecord);
  }

  async createComputerSnapshot(
    name: string,
    input: CreateComputerSnapshotInput,
  ): Promise<ComputerSnapshot> {
    const record = await this.requireComputer(name);
    const vmRecord = requireVmRecord(record);
    await this.requireVmStopped(vmRecord, "create snapshots");
    try {
      return await this.runtime.createVmSnapshot(vmRecord, input);
    } catch (error) {
      if (isSnapshotConflictError(error)) {
        throw new ComputerSnapshotConflictError(vmRecord.name, input.name);
      }

      throw error;
    }
  }

  async createMonitorSession(name: string): Promise<ComputerMonitorSession> {
    const record = await this.requireComputer(name);
    const monitorRecord = requireMonitorCapableRecord(record);
    await this.requireMonitorRunning(monitorRecord, "monitor sessions");
    return await this.runtime.createMonitorSession(monitorRecord);
  }

  async createAudioSession(name: string): Promise<ComputerAudioSession> {
    const record = await this.requireComputer(name);
    const browserRecord = requireBrowserRecord(record);
    await this.requireBrowserRunning(browserRecord, "audio sessions");
    return await this.runtime.createAudioSession(browserRecord);
  }

  async openMonitorAttach(name: string): Promise<BrowserMonitorLease> {
    const record = await this.requireComputer(name);
    const monitorRecord = requireMonitorCapableRecord(record);
    await this.requireMonitorRunning(monitorRecord, "monitor sessions");
    return await this.runtime.openMonitorAttach(monitorRecord);
  }

  async openAudioStream(name: string): Promise<BrowserAudioStreamLease> {
    const record = await this.requireComputer(name);
    const browserRecord = requireBrowserRecord(record);
    await this.requireBrowserRunning(browserRecord, "audio streams");
    return await this.runtime.openAudioStream(browserRecord);
  }

  async createAutomationSession(name: string): Promise<ComputerAutomationSession> {
    const record = await this.requireComputer(name);
    const browserRecord = requireBrowserRecord(record);
    await this.requireBrowserRunning(browserRecord, "automation sessions");
    return await this.runtime.createAutomationSession(browserRecord);
  }

  async openAutomationAttach(name: string): Promise<BrowserAutomationLease> {
    const record = await this.requireComputer(name);
    const browserRecord = requireBrowserRecord(record);
    await this.requireBrowserRunning(browserRecord, "automation sessions");
    return await this.runtime.openAutomationAttach(browserRecord);
  }

  async createScreenshot(name: string): Promise<ComputerScreenshot> {
    const record = await this.requireComputer(name);
    const screenshotRecord = requireMonitorCapableRecord(record);
    await this.requireMonitorRunning(screenshotRecord, "screenshots");
    return await this.runtime.createScreenshot(screenshotRecord);
  }

  async runDisplayActions(
    name: string,
    input: {
      ops: DisplayAction[];
      observe: RunDisplayActionsObserve;
    },
  ): Promise<RunDisplayActionsResult> {
    const record = await this.requireComputer(name);
    const displayRecord = requireMonitorCapableRecord(record);
    await this.requireMonitorRunning(displayRecord, "display actions");
    return await this.runtime.runDisplayActions(displayRecord, input.ops, input.observe);
  }

  async createConsoleSession(name: string) {
    const record = requireConsoleCapableRecord(await this.requireComputer(name));
    if (!supportsConsoleSessions(record)) {
      throw new UnsupportedComputerFeatureError(
        `Computer "${name}" does not support console sessions.`,
      );
    }

    await this.beforeCreateConsoleSession(record);
    return createConsoleSession(record.name);
  }

  async createExecSession(name: string) {
    const record = (await this.getManagedGatewayRecord(name)) ?? (await this.requireComputer(name));
    const containerRecord = requireContainerRecord(record);
    if (this.isManagedGatewayRecord(containerRecord)) {
      await this.requireManagedGatewayRunning(containerRecord, "exec sessions");
    } else {
      await this.requireContainerRunning(containerRecord, "exec sessions");
    }
    return createExecSession(record.name);
  }

  async openConsoleAttach(name: string): Promise<ConsoleAttachLease> {
    const record = requireConsoleCapableRecord(await this.requireComputer(name));
    if (!supportsConsoleSessions(record)) {
      throw new UnsupportedComputerFeatureError(
        `Computer "${name}" does not support console sessions.`,
      );
    }

    await this.beforeOpenConsoleAttach(record);
    if (this.activeConsoleAttaches.has(name)) {
      throw new ComputerConsoleUnavailableError(
        `Computer "${name}" already has an active console connection.`,
      );
    }

    this.activeConsoleAttaches.add(name);
    try {
      return await this.buildConsoleAttachLease(record);
    } catch (error) {
      this.activeConsoleAttaches.delete(name);
      throw error;
    }
  }

  async openExecAttach(name: string): Promise<ConsoleAttachLease> {
    const record = (await this.getManagedGatewayRecord(name)) ?? (await this.requireComputer(name));
    const containerRecord = requireContainerRecord(record);
    if (this.isManagedGatewayRecord(containerRecord)) {
      await this.requireManagedGatewayRunning(containerRecord, "exec sessions");
    } else {
      await this.requireContainerRunning(containerRecord, "exec sessions");
    }
    return this.buildExecAttachLease(containerRecord);
  }

  async deleteComputer(name: string) {
    await this.throwIfManagedGatewayMutation(name, "delete");
    const record = await this.requireComputer(name);
    this.throwIfBroken(
      record,
      await this.getPersistedComputerRuntimeState(record),
      "Delete is not supported for broken computers.",
    );
    if (record.profile === "browser") {
      await this.runtime.deleteBrowserComputer(record);
    } else if (record.profile === "container") {
      await this.runtime.deleteContainerComputer(record);
    } else if (record.profile === "vm") {
      await this.runtime.deletePersistentUnit(record.unitName);
      await this.runtime.deleteVmComputer(record);
    } else {
      await this.runtime.deletePersistentUnit(record.unitName);
    }
    if (record.profile === "host") {
      await this.consoleRuntimePaths.cleanupComputerDirectory(record);
    } else if (record.profile === "browser") {
      await this.runtime.deleteBrowserRuntimeIdentity(record);
    }
    await this.metadataStore.deleteComputer(name);
  }

  async deleteComputerSnapshot(name: string, snapshotName: string) {
    const record = await this.requireComputer(name);
    const vmRecord = requireVmRecord(record);
    await this.requireVmStopped(vmRecord, "delete snapshots");
    try {
      await this.runtime.deleteVmSnapshot(vmRecord, snapshotName);
    } catch (error) {
      if (isSnapshotNotFoundError(error)) {
        throw new ComputerSnapshotNotFoundError(vmRecord.name, snapshotName);
      }

      throw error;
    }
  }

  async startComputer(name: string): Promise<ComputerDetail> {
    await this.throwIfManagedGatewayMutation(name, "start");
    const record = await this.requireComputer(name);
    this.throwIfBroken(
      record,
      await this.getPersistedComputerRuntimeState(record),
      "Start is not supported for broken computers.",
    );
    if (record.profile === "container" || record.profile === "vm") {
      await this.networkProvider.ensureNetworkRuntime(
        await this.networkProvider.getNetworkRecord(record.networkId),
      );
    }
    if (record.profile === "browser") {
      await this.runtime.prepareBrowserRuntime(record);
      await this.runtime.startBrowserComputer(record);
    } else if (record.profile === "vm") {
      await this.runtime.prepareVmRuntime(record);
      await this.runtime.startUnit(record.unitName);
    } else if (record.profile === "container") {
      await this.runtime.startContainerComputer(record);
    } else {
      await this.runtime.startUnit(record.unitName);
    }
    if (record.profile === "host") {
      await this.waitForConsoleRuntimeReady(record, 5_000);
    }
    const updated = {
      ...record,
      lastActionAt: new Date().toISOString(),
    } satisfies PersistedComputer;
    await this.metadataStore.putComputer(updated);
    return await this.toComputerDetail(updated);
  }

  async stopComputer(name: string): Promise<ComputerDetail> {
    await this.throwIfManagedGatewayMutation(name, "stop");
    const record = await this.requireComputer(name);
    this.throwIfBroken(
      record,
      await this.getPersistedComputerRuntimeState(record),
      "Stop is not supported for broken computers.",
    );
    if (record.profile === "browser") {
      await this.runtime.stopBrowserComputer(record);
    } else if (record.profile === "container") {
      await this.runtime.stopContainerComputer(record);
    } else {
      await this.runtime.stopUnit(record.unitName);
    }
    const updated = {
      ...record,
      lastActionAt: new Date().toISOString(),
    } satisfies PersistedComputer;
    await this.metadataStore.putComputer(updated);
    return await this.toComputerDetail(updated);
  }

  async restartComputer(name: string): Promise<ComputerDetail> {
    await this.throwIfManagedGatewayMutation(name, "restart");
    const record = await this.requireComputer(name);
    this.throwIfBroken(
      record,
      await this.getPersistedComputerRuntimeState(record),
      "Restart is not supported for broken computers.",
    );
    if (record.profile === "container" || record.profile === "vm") {
      await this.networkProvider.ensureNetworkRuntime(
        await this.networkProvider.getNetworkRecord(record.networkId),
      );
    }
    if (record.profile === "browser") {
      await this.runtime.prepareBrowserRuntime(record);
      await this.runtime.restartBrowserComputer(record);
    } else if (record.profile === "vm") {
      await this.runtime.prepareVmRuntime(record);
      await this.runtime.restartUnit(record.unitName);
    } else if (record.profile === "container") {
      await this.runtime.restartContainerComputer(record);
    } else {
      await this.runtime.restartUnit(record.unitName);
    }
    if (record.profile === "host") {
      await this.waitForConsoleRuntimeReady(record, 5_000);
    }
    const updated = {
      ...record,
      lastActionAt: new Date().toISOString(),
    } satisfies PersistedComputer;
    await this.metadataStore.putComputer(updated);
    return await this.toComputerDetail(updated);
  }

  async restoreComputer(name: string, input: RestoreComputerInput): Promise<ComputerDetail> {
    const record = await this.requireComputer(name);
    const vmRecord = requireVmRecord(record);
    await this.requireVmStopped(vmRecord, "restore");
    try {
      await this.runtime.restoreVmComputer(vmRecord, input);
    } catch (error) {
      if (input.target === "snapshot" && isSnapshotNotFoundError(error)) {
        throw new ComputerSnapshotNotFoundError(vmRecord.name, input.snapshotName);
      }

      throw error;
    }

    const updated = {
      ...vmRecord,
      lastActionAt: new Date().toISOString(),
    } satisfies PersistedComputer;
    await this.metadataStore.putComputer(updated);
    return await this.toComputerDetail(updated);
  }

  async resizeDisplay(name: string, input: ResizeDisplayInput) {
    const record = await this.requireComputer(name);
    const displayRecord = requireMonitorCapableRecord(record);
    this.throwIfBroken(
      displayRecord,
      await this.getPersistedComputerRuntimeState(displayRecord),
      "Display resize is not supported for broken computers.",
    );
    const updated =
      displayRecord.profile === "browser"
        ? withBrowserViewport(displayRecord, input)
        : withVmViewport(displayRecord, input);
    await this.metadataStore.putComputer(updated);
    await this.runtime.resizeDisplay(updated, input);
    return await this.toComputerDetail(updated);
  }

  async runVmGuestCommand(name: string, input: VmGuestCommandInput): Promise<VmGuestCommandResult> {
    const record = await this.requireComputer(name);
    const vmRecord = requireVmRecord(record);
    await this.requireVmRunning(vmRecord, "run guest commands");
    return await this.runtime.runVmGuestCommand(vmRecord, input);
  }

  async readVmGuestFile(name: string, input: VmGuestFileReadInput): Promise<VmGuestFileReadResult> {
    const record = await this.requireComputer(name);
    const vmRecord = requireVmRecord(record);
    await this.requireVmRunning(vmRecord, "read guest files");
    return await this.runtime.readVmGuestFile(vmRecord, input);
  }

  async writeVmGuestFile(
    name: string,
    input: VmGuestFileWriteInput,
  ): Promise<VmGuestFileWriteResult> {
    const record = await this.requireComputer(name);
    const vmRecord = requireVmRecord(record);
    await this.requireVmRunning(vmRecord, "write guest files");
    return await this.runtime.writeVmGuestFile(vmRecord, input);
  }

  async listHostUnits(): Promise<HostUnitSummary[]> {
    return await this.runtime.listHostUnits();
  }

  async getHostUnit(unitName: string): Promise<HostUnitDetail> {
    const detail = await this.runtime.getHostUnit(unitName);
    if (detail === null) {
      throw new HostUnitNotFoundError(unitName);
    }

    return detail;
  }

  protected async beforeCreateConsoleSession(
    record: PersistedHostComputer | PersistedContainerComputer | PersistedVmComputer,
  ) {
    await this.requireConsoleAvailable(record);
  }

  protected async beforeOpenConsoleAttach(
    record: PersistedHostComputer | PersistedContainerComputer | PersistedVmComputer,
  ) {
    await this.requireConsoleAvailable(record);
  }

  protected async buildConsoleAttachLease(
    record: PersistedHostComputer | PersistedContainerComputer | PersistedVmComputer,
  ): Promise<ConsoleAttachLease> {
    return createConsoleAttachLease(
      record,
      this.consoleRuntimePaths,
      this.environment,
      this.activeConsoleAttaches,
    );
  }

  protected buildExecAttachLease(record: PersistedContainerComputer): ConsoleAttachLease {
    return createContainerExecLease(record, this.environment);
  }

  protected async requireComputer(name: string) {
    const record = await this.metadataStore.getComputer(name);
    if (record === null) {
      throw new ComputerNotFoundError(name);
    }

    return record;
  }

  protected async requireConsoleAvailable(
    record: PersistedHostComputer | PersistedContainerComputer | PersistedVmComputer,
  ) {
    if (record.profile === "container") {
      await this.requireContainerRunning(record, "console sessions");
      return;
    }

    if (record.profile === "vm") {
      const runtimeState = await this.runtime.getRuntimeState(record.unitName);
      this.throwIfBroken(
        record,
        runtimeState,
        "Console sessions are not supported for broken computers.",
      );
      if (mapComputerState(runtimeState) !== "running") {
        throw new ComputerConsoleUnavailableError(
          `Computer "${record.name}" must be running before opening a console.`,
        );
      }

      return;
    }

    this.throwIfBroken(
      record,
      await this.runtime.getRuntimeState(record.unitName),
      "Console sessions are not supported for broken computers.",
    );

    const isReady = await this.waitForConsoleRuntimeReady(record, 3_000);
    if (!isReady) {
      const runtimeState = await this.runtime.getRuntimeState(record.unitName);
      this.throwIfBroken(
        record,
        runtimeState,
        "Console sessions are not supported for broken computers.",
      );
      if (mapComputerState(runtimeState) !== "running") {
        throw new ComputerConsoleUnavailableError(
          `Computer "${record.name}" must be running before opening a console.`,
        );
      }

      throw new ComputerConsoleUnavailableError(
        `Computer "${record.name}" console runtime is not ready yet.`,
      );
    }
  }

  protected async waitForConsoleRuntimeReady(record: PersistedHostComputer, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() <= deadline) {
      const runtimeState = await this.runtime.getRuntimeState(record.unitName);
      if (mapComputerState(runtimeState) !== "running") {
        return false;
      }

      if (await this.consoleRuntimePaths.hasSocket(record)) {
        return true;
      }

      await delay(100);
    }

    return false;
  }

  protected async toComputerSummary(record: PersistedComputer): Promise<ComputerSummary> {
    const state = this.isManagedGatewayRecord(record)
      ? await this.getManagedGatewayState(record)
      : mapComputerState(await this.getPersistedComputerRuntimeState(record));
    const network = await this.networkProvider.toNetworkSummary(
      await this.networkProvider.getNetworkRecord(record.networkId),
      1,
    );
    const summary = toComputerSummary(record, state, network);
    if (this.isManagedGatewayRecord(record)) {
      summary.managed = record.managed;
      summary.capabilities.canStart = false;
      summary.capabilities.canStop = false;
      summary.capabilities.canRestart = false;
    }
    return summary;
  }

  protected async toComputerDetail(record: PersistedComputer): Promise<ComputerDetail> {
    const runtimeState = this.isManagedGatewayRecord(record)
      ? await this.getManagedGatewayRuntimeState(record)
      : await this.getPersistedComputerRuntimeState(record);
    const summary = await this.toComputerSummary(record);
    const detail = toComputerDetail(
      record,
      runtimeState,
      summary,
      this.browserRuntimePaths,
      this.vmRuntimePaths,
    );
    if (this.isManagedGatewayRecord(record)) {
      detail.managed = record.managed;
      detail.capabilities.canStart = false;
      detail.capabilities.canStop = false;
      detail.capabilities.canRestart = false;
    }
    return detail;
  }

  protected async requireBrowserRunning(record: PersistedBrowserComputer, capability: string) {
    const runtimeState = await this.getPersistedComputerRuntimeState(record);
    this.throwIfBroken(
      record,
      runtimeState,
      `Opening ${capability} is not supported for broken computers.`,
    );
    if (mapComputerState(runtimeState) !== "running") {
      throw new UnsupportedComputerFeatureError(
        `Computer "${record.name}" must be running before opening ${capability}.`,
      );
    }
  }

  protected async requireMonitorRunning(
    record: PersistedBrowserComputer | PersistedVmComputer,
    capability: string,
  ) {
    const runtimeState =
      record.profile === "browser"
        ? await this.getPersistedComputerRuntimeState(record)
        : await this.runtime.getRuntimeState(record.unitName);
    this.throwIfBroken(
      record,
      runtimeState,
      `Opening ${capability} is not supported for broken computers.`,
    );
    if (mapComputerState(runtimeState) !== "running") {
      throw new UnsupportedComputerFeatureError(
        `Computer "${record.name}" must be running before opening ${capability}.`,
      );
    }
  }

  protected async requireContainerRunning(record: PersistedContainerComputer, capability: string) {
    const runtimeState = await this.runtime.getContainerRuntimeState(record);
    this.throwIfBroken(
      record,
      runtimeState,
      `Opening ${capability} is not supported for broken computers.`,
    );
    if (mapComputerState(runtimeState) !== "running") {
      throw new UnsupportedComputerFeatureError(
        `Computer "${record.name}" must be running before opening ${capability}.`,
      );
    }
  }

  protected async requireVmStopped(record: PersistedVmComputer, capability: string) {
    const runtimeState = await this.runtime.getRuntimeState(record.unitName);
    this.throwIfBroken(
      record,
      runtimeState,
      `${capitalize(capability)} is not supported for broken computers.`,
    );
    if (mapComputerState(runtimeState) !== "stopped") {
      throw new UnsupportedComputerFeatureError(
        `Computer "${record.name}" must be stopped before ${capability}.`,
      );
    }
  }

  protected async requireVmRunning(record: PersistedVmComputer, capability: string) {
    const runtimeState = await this.runtime.getRuntimeState(record.unitName);
    this.throwIfBroken(
      record,
      runtimeState,
      `${capitalize(capability)} is not supported for broken computers.`,
    );
    if (mapComputerState(runtimeState) !== "running") {
      throw new UnsupportedComputerFeatureError(
        `Computer "${record.name}" must be running before ${capability}.`,
      );
    }
  }

  protected async getPersistedComputerRuntimeState(record: PersistedComputer) {
    return await getPersistedComputerRuntimeState(record, this.runtime);
  }

  protected async listManagedGatewayRecords(): Promise<ManagedGatewayComputerRecord[]> {
    const networks = await this.networkProvider.listNetworkRecords();
    return networks
      .filter((network) => network.kind === "isolated")
      .map((network) => createGatewayManagedComputerRecord(network));
  }

  protected async getManagedGatewayRecord(name: string): Promise<ManagedGatewayComputerRecord | null> {
    const records = await this.listManagedGatewayRecords();
    return records.find((record) => record.name === name) ?? null;
  }

  protected isManagedGatewayRecord(
    record: PersistedComputer | ManagedGatewayComputerRecord,
  ): record is ManagedGatewayComputerRecord {
    return "managed" in record && record.managed.kind === "gateway";
  }

  protected async throwIfManagedGatewayMutation(
    name: string,
    action: "delete" | "restart" | "start" | "stop",
  ) {
    const record = await this.getManagedGatewayRecord(name);
    if (record !== null) {
      throw new UnsupportedComputerFeatureError(
        `Gateway computer "${name}" is managed through network "${record.managed.networkName}" and does not support ${action}.`,
      );
    }
  }

  protected async getManagedGatewayRuntimeState(record: ManagedGatewayComputerRecord) {
    return await this.runtime.getContainerRuntimeState(record);
  }

  protected async getManagedGatewayState(record: ManagedGatewayComputerRecord) {
    const runtimeState = await this.getManagedGatewayRuntimeState(record);
    if (runtimeState !== null) {
      return mapComputerState(runtimeState);
    }

    const network = await this.networkProvider.getNetworkRecord(record.managed.networkId);
    const detail = await this.networkProvider.toNetworkDetail(network, 0);
    if (network.kind !== "isolated" || detail.gateway.runtime === undefined) {
      return "broken";
    }

    return detail.gateway.runtime.containerState === "running"
      ? "running"
      : detail.gateway.runtime.containerState === "stopped"
        ? "stopped"
        : "broken";
  }

  protected async requireManagedGatewayRunning(
    record: ManagedGatewayComputerRecord,
    capability: string,
  ) {
    const state = await this.getManagedGatewayState(record);
    if (state === "broken") {
      throw new UnsupportedComputerFeatureError(
        `Opening ${capability} is not supported for broken computers.`,
      );
    }
    if (state !== "running") {
      throw new UnsupportedComputerFeatureError(
        `Computer "${record.name}" must be running before opening ${capability}.`,
      );
    }
  }

  protected throwIfBroken(
    record: PersistedComputer,
    runtimeState: Awaited<ReturnType<ComputerRuntimePort["getRuntimeState"]>>,
    action: string,
  ) {
    throwIfBroken(record, runtimeState, action);
  }

  protected async resolveComputerNetwork(networkId: string | undefined) {
    return await this.networkProvider.getNetworkRecord(networkId ?? DEFAULT_HOST_NETWORK_ID);
  }

  protected assertSupportedNetworkAttachment(
    input: CreateComputerInput,
    network: PersistedNetworkRecord,
  ) {
    if (input.profile === "host" && network.kind !== "host") {
      throw new UnsupportedComputerFeatureError(
        `Computer "${input.name}" cannot use isolated network "${network.name}" yet.`,
      );
    }
  }
}
