import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type {
  ComputerAudioSession,
  ComputerAutomationSession,
  ComputerMonitorSession,
  ComputerScreenshot,
  ComputerSnapshot,
  CreateComputerSnapshotInput,
  DisplayAction,
  ResizeDisplayInput,
  RunDisplayActionsObserve,
  RunDisplayActionsResult,
  RestoreComputerInput,
  VmGuestCommandInput,
  VmGuestCommandResult,
  VmGuestFileReadInput,
  VmGuestFileReadResult,
  VmGuestFileWriteInput,
  VmGuestFileWriteResult,
} from "@computerd/core";
import { executeDisplayActionsOverVnc } from "../display-actions";
import { UnsupportedComputerFeatureError } from "../shared";
import { WebSocket } from "ws";
import { createBrowserRuntimePaths } from "./browser-runtime";
import { createPipeWireRuntimeEnvironment, DefaultPipeWireHostManager } from "./pipewire-host";
import {
  QemuGuestAgentCommandError,
  QemuGuestAgentClient,
  QemuGuestAgentUnavailableError,
} from "./qemu-guest-agent";
import {
  createVmRuntimePaths,
  createVmSnapshotImagePath,
  resolveVmNicMacAddress,
  withPersistedVmRuntime,
} from "./vm-runtime";
import type { PersistedNetworkRecord } from "../networks";
import type {
  BrowserViewport,
  CreateVmComputerInput,
  PersistedBrowserComputer,
  HostUnitDetail,
  HostUnitSummary,
  PersistedComputer,
  PersistedVmComputer,
  UnitRuntimeState,
  BrowserAutomationLease,
  BrowserMonitorLease,
  BrowserAudioStreamLease,
} from "./types";
import { FileUnitStore, type FileUnitStoreOptions, type UnitFileStore } from "./unit-file-store";
import {
  DefaultSystemdDbusClient,
  type SystemdDbusClient,
  type SystemdDbusClientOptions,
} from "./dbus-client";

export abstract class SystemdRuntime {
  abstract createVmComputer(
    input: CreateVmComputerInput,
    imagePath: string,
    network: PersistedNetworkRecord,
  ): Promise<PersistedVmComputer["runtime"]>;
  abstract deleteBrowserRuntimeIdentity(computer: PersistedBrowserComputer): Promise<void>;
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
  abstract createVmSnapshot(
    computer: PersistedVmComputer,
    input: CreateComputerSnapshotInput,
  ): Promise<ComputerSnapshot>;
  abstract createScreenshot(
    computer: PersistedBrowserComputer | PersistedVmComputer,
  ): Promise<ComputerScreenshot>;
  abstract runDisplayActions(
    computer: PersistedBrowserComputer | PersistedVmComputer,
    ops: DisplayAction[],
    observe: RunDisplayActionsObserve,
  ): Promise<RunDisplayActionsResult>;
  abstract deletePersistentUnit(unitName: string): Promise<void>;
  abstract deleteVmSnapshot(computer: PersistedVmComputer, snapshotName: string): Promise<void>;
  abstract getHostUnit(unitName: string): Promise<HostUnitDetail | null>;
  abstract getRuntimeState(unitName: string): Promise<UnitRuntimeState | null>;
  abstract listHostUnits(): Promise<HostUnitSummary[]>;
  abstract listVmSnapshots(computer: PersistedVmComputer): Promise<ComputerSnapshot[]>;
  abstract openAutomationAttach(
    computer: PersistedBrowserComputer,
  ): Promise<BrowserAutomationLease>;
  abstract openAudioStream(computer: PersistedBrowserComputer): Promise<BrowserAudioStreamLease>;
  abstract openMonitorAttach(
    computer: PersistedBrowserComputer | PersistedVmComputer,
  ): Promise<BrowserMonitorLease>;
  abstract restartUnit(unitName: string): Promise<UnitRuntimeState>;
  abstract restoreVmComputer(
    computer: PersistedVmComputer,
    input: RestoreComputerInput,
  ): Promise<void>;
  abstract startUnit(unitName: string): Promise<UnitRuntimeState>;
  abstract stopUnit(unitName: string): Promise<UnitRuntimeState>;
  abstract resizeDisplay(
    computer: PersistedBrowserComputer | PersistedVmComputer,
    viewport: ResizeDisplayInput,
  ): Promise<void>;
  abstract runVmGuestCommand(
    computer: PersistedVmComputer,
    input: VmGuestCommandInput,
  ): Promise<VmGuestCommandResult>;
  abstract readVmGuestFile(
    computer: PersistedVmComputer,
    input: VmGuestFileReadInput,
  ): Promise<VmGuestFileReadResult>;
  abstract writeVmGuestFile(
    computer: PersistedVmComputer,
    input: VmGuestFileWriteInput,
  ): Promise<VmGuestFileWriteResult>;
}

export interface CreateSystemdRuntimeOptions {
  dbusClient?: SystemdDbusClient;
  dbusClientOptions?: SystemdDbusClientOptions;
  qemuImgCommand?: string;
  unitFileStore?: UnitFileStore;
  unitFileStoreOptions: FileUnitStoreOptions;
}

const execFileAsync = promisify(execFile);

export class DefaultSystemdRuntime extends SystemdRuntime {
  private readonly resolvedDbusClient: SystemdDbusClient;
  private readonly resolvedUnitFileStore: UnitFileStore;
  private readonly browserRuntimePaths;
  private readonly vmRuntimePaths;
  private readonly pipeWireHostManager: DefaultPipeWireHostManager;
  private readonly qemuImgCommand: string;
  private readonly unitFileStoreOptions: FileUnitStoreOptions;

  constructor({
    dbusClientOptions,
    qemuImgCommand = "qemu-img",
    unitFileStoreOptions,
    dbusClient,
    unitFileStore,
  }: CreateSystemdRuntimeOptions) {
    super();
    this.resolvedDbusClient = dbusClient ?? new DefaultSystemdDbusClient(dbusClientOptions?.bus);
    this.resolvedUnitFileStore = unitFileStore ?? new FileUnitStore(unitFileStoreOptions);
    this.browserRuntimePaths = createBrowserRuntimePaths({
      runtimeRootDirectory: unitFileStoreOptions.browserRuntimeDirectory,
      stateRootDirectory: unitFileStoreOptions.browserStateDirectory,
    });
    this.vmRuntimePaths = createVmRuntimePaths({
      runtimeRootDirectory: unitFileStoreOptions.vmRuntimeDirectory,
      stateRootDirectory: unitFileStoreOptions.vmStateDirectory,
    });
    this.pipeWireHostManager = new DefaultPipeWireHostManager({
      browserRuntimeDirectory: unitFileStoreOptions.browserRuntimeDirectory,
      browserStateDirectory: unitFileStoreOptions.browserStateDirectory,
    });
    this.qemuImgCommand = qemuImgCommand;
    this.unitFileStoreOptions = unitFileStoreOptions;
  }

  async createVmComputer(
    input: CreateVmComputerInput,
    imagePath: string,
    network: PersistedNetworkRecord,
  ) {
    assertVmHostSupport(network.bridgeName);
    const runtime = withPersistedVmRuntime(input.runtime, imagePath, network.bridgeName);
    const spec = this.vmRuntimePaths.specForName(input.name);
    await mkdir(spec.stateDirectory, { recursive: true });
    await mkdir(spec.runtimeDirectory, { recursive: true });
    if (runtime.source.kind === "qcow2") {
      await assertPathExists(runtime.source.path, "Base qcow2 image");
      await createQcow2Overlay(this.qemuImgCommand, runtime.source.path, spec.diskImagePath);
    } else {
      await assertPathExists(runtime.source.path, "Install ISO");
      await createBlankDisk(
        this.qemuImgCommand,
        spec.diskImagePath,
        runtime.source.diskSizeGiB ?? 32,
      );
    }

    return runtime;
  }

  async deleteBrowserRuntimeIdentity(computer: PersistedBrowserComputer) {
    await this.pipeWireHostManager.deleteRuntimeIdentity(computer);
  }

  async deleteVmComputer(computer: PersistedVmComputer) {
    const spec = this.vmRuntimePaths.specForComputer(computer);
    await rm(spec.runtimeDirectory, { recursive: true, force: true });
    await rm(spec.stateDirectory, { recursive: true, force: true });
  }

  async ensureBrowserRuntimeIdentity(computer: PersistedBrowserComputer) {
    await this.pipeWireHostManager.ensureRuntimeIdentity(computer);
  }

  async prepareBrowserRuntime(computer: PersistedBrowserComputer) {
    await this.pipeWireHostManager.prepareRuntime(computer);
  }

  async prepareVmRuntime(computer: PersistedVmComputer) {
    if (computer.runtime.source.kind !== "qcow2") {
      return;
    }
    if (computer.runtime.source.cloudInit.enabled === false) {
      return;
    }

    const spec = this.vmRuntimePaths.specForComputer(computer);
    await mkdir(spec.stateDirectory, { recursive: true });
    await mkdir(spec.runtimeDirectory, { recursive: true });
    await createCloudInitSeed(
      spec,
      computer.name,
      computer.runtime.source.cloudInit,
      computer.runtime.nics[0]!,
    );
  }

  async createMonitorSession(computer: PersistedBrowserComputer | PersistedVmComputer) {
    const spec =
      computer.profile === "browser"
        ? this.browserRuntimePaths.specForComputer(computer)
        : this.vmRuntimePaths.specForComputer(computer);
    return {
      computerName: computer.name,
      protocol: "vnc",
      connect: {
        mode: "relative-websocket-path",
        url: `/api/computers/${encodeURIComponent(computer.name)}/monitor/ws`,
      },
      authorization: {
        mode: "none",
      },
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      viewport: spec.viewport,
    } satisfies Awaited<ReturnType<SystemdRuntime["createMonitorSession"]>>;
  }

  async createAudioSession(computer: PersistedBrowserComputer) {
    return {
      computerName: computer.name,
      protocol: "http-audio-stream",
      connect: {
        mode: "relative-websocket-path",
        url: `/api/computers/${encodeURIComponent(computer.name)}/audio`,
      },
      authorization: {
        mode: "none",
      },
      mimeType: "audio/ogg",
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    } satisfies Awaited<ReturnType<SystemdRuntime["createAudioSession"]>>;
  }

  async openMonitorAttach(computer: PersistedBrowserComputer | PersistedVmComputer) {
    const spec =
      computer.profile === "browser"
        ? this.browserRuntimePaths.specForComputer(computer)
        : this.vmRuntimePaths.specForComputer(computer);
    return {
      computerName: computer.name,
      host: "127.0.0.1",
      port: spec.vncPort,
      release() {},
    } satisfies Awaited<ReturnType<SystemdRuntime["openMonitorAttach"]>>;
  }

  async openAudioStream(computer: PersistedBrowserComputer) {
    const spec = this.browserRuntimePaths.specForComputer(computer);
    const captureEnvironment = createPipeWireRuntimeEnvironment(computer, {
      browserRuntimeDirectory: this.unitFileStoreOptions.browserRuntimeDirectory,
      browserStateDirectory: this.unitFileStoreOptions.browserStateDirectory,
    });
    return {
      computerName: computer.name,
      command: "/usr/bin/bash",
      args: [
        "-lc",
        `ffmpeg -hide_banner -loglevel error -fflags nobuffer -flags low_delay -f pulse -i ${quoteShell(spec.audioMonitorSourceName)} -c:a libopus -b:a 128k -frame_duration 20 -application lowdelay -f ogg pipe:1`,
      ],
      env: {
        ...captureEnvironment,
        PULSE_SERVER: `unix:${spec.pulseServerPath}`,
      },
      targetSelector: `pulse-source=${spec.audioMonitorSourceName}`,
      release() {},
    } satisfies Awaited<ReturnType<SystemdRuntime["openAudioStream"]>>;
  }

  async createAutomationSession(computer: PersistedBrowserComputer) {
    return {
      computerName: computer.name,
      protocol: "cdp",
      connect: {
        mode: "relative-websocket-path",
        url: `/api/computers/${encodeURIComponent(computer.name)}/automation/ws`,
      },
      authorization: {
        mode: "none",
      },
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    } satisfies Awaited<ReturnType<SystemdRuntime["createAutomationSession"]>>;
  }

  async openAutomationAttach(computer: PersistedBrowserComputer) {
    const websocketUrl = await resolveAutomationWebSocketUrl(
      this.browserRuntimePaths.specForComputer(computer).devtoolsPort,
    );
    return {
      computerName: computer.name,
      url: websocketUrl,
      release() {},
    } satisfies Awaited<ReturnType<SystemdRuntime["openAutomationAttach"]>>;
  }

  async createScreenshot(computer: PersistedBrowserComputer | PersistedVmComputer) {
    if (computer.profile === "vm") {
      return await this.createVmScreenshot(computer);
    }

    const spec = this.browserRuntimePaths.specForComputer(computer);
    const { stdout } = await execFileAsync("/usr/bin/bash", [
      "-lc",
      `DISPLAY=${quoteShell(spec.xvfbDisplay)} import -window root png:- | base64`,
    ]);
    return {
      computerName: computer.name,
      format: "png",
      mimeType: "image/png",
      capturedAt: new Date().toISOString(),
      width: spec.viewport.width,
      height: spec.viewport.height,
      dataBase64: stdout.trim(),
    } satisfies Awaited<ReturnType<SystemdRuntime["createScreenshot"]>>;
  }

  async runDisplayActions(
    computer: PersistedBrowserComputer | PersistedVmComputer,
    ops: DisplayAction[],
    observe: RunDisplayActionsObserve,
  ) {
    const spec =
      computer.profile === "browser"
        ? this.browserRuntimePaths.specForComputer(computer)
        : this.vmRuntimePaths.specForComputer(computer);

    return await executeDisplayActionsOverVnc({
      computerName: computer.name,
      host: "127.0.0.1",
      port: spec.vncPort,
      viewport: spec.viewport,
      ops,
      observe,
      captureScreenshot: async () => await this.createScreenshot(computer),
    });
  }

  private async createVmScreenshot(computer: PersistedVmComputer) {
    const spec = this.vmRuntimePaths.specForComputer(computer);
    const jpegBuffer = await captureJpegFromVnc(spec.vncDisplay);
    const dimensions = readJpegDimensions(jpegBuffer);
    return {
      computerName: computer.name,
      format: "jpeg",
      mimeType: "image/jpeg",
      capturedAt: new Date().toISOString(),
      width: dimensions.width,
      height: dimensions.height,
      dataBase64: jpegBuffer.toString("base64"),
    } satisfies Awaited<ReturnType<SystemdRuntime["createScreenshot"]>>;
  }

  async listVmSnapshots(computer: PersistedVmComputer) {
    const spec = this.vmRuntimePaths.specForComputer(computer);
    const manifest = await readVmSnapshotManifest(spec.snapshotManifestPath);
    return manifest
      .map((snapshot) => ({
        name: snapshot.name,
        createdAt: snapshot.createdAt,
        sizeBytes: snapshot.sizeBytes,
      }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async createVmSnapshot(computer: PersistedVmComputer, input: CreateComputerSnapshotInput) {
    const spec = this.vmRuntimePaths.specForComputer(computer);
    const manifest = await readVmSnapshotManifest(spec.snapshotManifestPath);
    if (manifest.some((snapshot) => snapshot.name === input.name)) {
      throw new Error(`Snapshot "${input.name}" already exists for computer "${computer.name}".`);
    }

    await mkdir(spec.snapshotsDirectory, { recursive: true });
    const snapshotId = randomUUID();
    const snapshotPath = createVmSnapshotImagePath(spec, snapshotId);
    const tempSnapshotPath = `${snapshotPath}.tmp-${randomUUID()}`;
    await cloneQcow2Image(this.qemuImgCommand, spec.diskImagePath, tempSnapshotPath);
    await rename(tempSnapshotPath, snapshotPath);
    const snapshotStat = await stat(snapshotPath);
    const snapshot = {
      id: snapshotId,
      name: input.name,
      createdAt: new Date().toISOString(),
      sizeBytes: snapshotStat.size,
      filePath: snapshotPath,
    } satisfies PersistedVmSnapshot;
    await writeVmSnapshotManifest(spec.snapshotManifestPath, [...manifest, snapshot]);
    return {
      name: snapshot.name,
      createdAt: snapshot.createdAt,
      sizeBytes: snapshot.sizeBytes,
    };
  }

  async deleteVmSnapshot(computer: PersistedVmComputer, snapshotName: string) {
    const spec = this.vmRuntimePaths.specForComputer(computer);
    const manifest = await readVmSnapshotManifest(spec.snapshotManifestPath);
    const snapshot = manifest.find((entry) => entry.name === snapshotName);
    if (snapshot === undefined) {
      throw new Error(`Snapshot "${snapshotName}" was not found for computer "${computer.name}".`);
    }

    await rm(snapshot.filePath, { force: true });
    await writeVmSnapshotManifest(
      spec.snapshotManifestPath,
      manifest.filter((entry) => entry.name !== snapshotName),
    );
  }

  async restoreVmComputer(computer: PersistedVmComputer, input: RestoreComputerInput) {
    const spec = this.vmRuntimePaths.specForComputer(computer);
    if (input.target === "initial") {
      await rm(spec.diskImagePath, { force: true });
      if (computer.runtime.source.kind === "qcow2") {
        await assertPathExists(computer.runtime.source.path, "Base qcow2 image");
        await createQcow2Overlay(
          this.qemuImgCommand,
          computer.runtime.source.path,
          spec.diskImagePath,
        );
        return;
      }

      await assertPathExists(computer.runtime.source.path, "Install ISO");
      await createBlankDisk(
        this.qemuImgCommand,
        spec.diskImagePath,
        computer.runtime.source.diskSizeGiB ?? 32,
      );
      return;
    }

    const manifest = await readVmSnapshotManifest(spec.snapshotManifestPath);
    const snapshot = manifest.find((entry) => entry.name === input.snapshotName);
    if (snapshot === undefined) {
      throw new Error(
        `Snapshot "${input.snapshotName}" was not found for computer "${computer.name}".`,
      );
    }

    const tempDiskImagePath = `${spec.diskImagePath}.tmp-${randomUUID()}`;
    await cloneQcow2Image(this.qemuImgCommand, snapshot.filePath, tempDiskImagePath);
    await rename(tempDiskImagePath, spec.diskImagePath);
  }

  async resizeDisplay(
    computer: PersistedBrowserComputer | PersistedVmComputer,
    viewport: ResizeDisplayInput,
  ) {
    if (computer.profile === "browser") {
      await this.resizeBrowserDisplay(computer, viewport);
      return;
    }

    const runtimeState = await this.resolvedDbusClient.getRuntimeState(computer.unitName);
    if (runtimeState?.activeState !== "active") {
      return;
    }

    const result = await this.runVmGuestCommand(computer, {
      command: buildVmResizeCommand(viewport),
      captureOutput: true,
      shell: true,
      timeoutMs: 15_000,
    });
    if (result.timedOut || result.exitCode !== 0) {
      throw new UnsupportedComputerFeatureError(
        result.stderr || result.stdout || `VM "${computer.name}" does not support dynamic resize.`,
      );
    }
  }

  async runVmGuestCommand(computer: PersistedVmComputer, input: VmGuestCommandInput) {
    try {
      const client = this.createVmGuestAgentClient(computer);
      await client.waitForReady(input.timeoutMs);
      return await client.runCommand(input);
    } catch (error) {
      throw wrapVmGuestAgentError(computer.name, error);
    }
  }

  async readVmGuestFile(computer: PersistedVmComputer, input: VmGuestFileReadInput) {
    try {
      const client = this.createVmGuestAgentClient(computer);
      await client.waitForReady();
      return await client.readFile(input);
    } catch (error) {
      throw wrapVmGuestAgentError(computer.name, error);
    }
  }

  async writeVmGuestFile(computer: PersistedVmComputer, input: VmGuestFileWriteInput) {
    try {
      const client = this.createVmGuestAgentClient(computer);
      await client.waitForReady();
      return await client.writeFile(input);
    } catch (error) {
      throw wrapVmGuestAgentError(computer.name, error);
    }
  }

  async createPersistentUnit(computer: PersistedComputer) {
    await this.resolvedUnitFileStore.writeUnitFile(computer);
    await this.resolvedDbusClient.reloadDaemon();
    await this.resolvedDbusClient.setUnitEnabled(
      computer.unitName,
      computer.lifecycle.autostart === true,
    );
    const runtimeState = await this.resolvedDbusClient.getRuntimeState(computer.unitName);
    if (runtimeState !== null) {
      return runtimeState;
    }

    return {
      unitName: computer.unitName,
      description: computer.description,
      unitType: "service",
      loadState: "loaded",
      activeState: "inactive",
      subState: "dead",
      execStart: computer.profile === "host" ? computer.runtime.command : "/usr/bin/bash -lc",
      workingDirectory:
        computer.profile === "host"
          ? computer.runtime.workingDirectory
          : computer.profile === "browser"
            ? this.browserRuntimePaths.specForComputer(computer).stateDirectory
            : computer.profile === "vm"
              ? this.vmRuntimePaths.specForComputer(computer).stateDirectory
              : undefined,
      environment: computer.profile === "host" ? computer.runtime.environment : undefined,
      cpuWeight: computer.resources.cpuWeight,
      memoryMaxMiB: computer.resources.memoryMaxMiB,
    };
  }

  async deletePersistentUnit(unitName: string) {
    await this.resolvedDbusClient.deletePersistentUnit(unitName);
    await this.resolvedUnitFileStore.deleteUnitFile(unitName);
    await this.resolvedDbusClient.reloadDaemon();
  }

  async getRuntimeState(unitName: string) {
    return await this.resolvedDbusClient.getRuntimeState(unitName);
  }

  async startUnit(unitName: string) {
    return await this.resolvedDbusClient.startUnit(unitName);
  }

  async stopUnit(unitName: string) {
    return await this.resolvedDbusClient.stopUnit(unitName);
  }

  async restartUnit(unitName: string) {
    return await this.resolvedDbusClient.restartUnit(unitName);
  }

  async listHostUnits() {
    return await this.resolvedDbusClient.listHostUnits();
  }

  async getHostUnit(unitName: string) {
    return await this.resolvedDbusClient.getHostUnit(unitName);
  }

  private async resizeBrowserDisplay(
    computer: PersistedBrowserComputer,
    viewport: ResizeDisplayInput,
  ) {
    const spec = this.browserRuntimePaths.specForComputer(computer);
    const runtimeState = await this.resolvedDbusClient.getRuntimeState(computer.unitName);
    if (runtimeState?.activeState !== "active") {
      return;
    }

    await execFileAsync("/usr/bin/bash", [
      "-lc",
      [
        `DISPLAY=${quoteShell(spec.xvfbDisplay)}`,
        `xrandr -display ${quoteShell(spec.xvfbDisplay)} -s ${viewport.width}x${viewport.height}`,
      ].join(" "),
    ]).catch(async () => {
      await execFileAsync("/usr/bin/bash", [
        "-lc",
        [
          `DISPLAY=${quoteShell(spec.xvfbDisplay)}`,
          `xrandr -display ${quoteShell(spec.xvfbDisplay)} --fb ${viewport.width}x${viewport.height}`,
        ].join(" "),
      ]);
    });

    const websocketUrl = await resolveAutomationWebSocketUrl(spec.devtoolsPort);
    await resizeChromiumWindow(websocketUrl, viewport);
  }

  private createVmGuestAgentClient(computer: PersistedVmComputer) {
    const spec = this.vmRuntimePaths.specForComputer(computer);
    return new QemuGuestAgentClient(spec.guestAgentSocketPath);
  }
}

async function resizeChromiumWindow(websocketUrl: string, viewport: BrowserViewport) {
  const targetsResponse = await sendCdpCommand(websocketUrl, "Target.getTargets");
  const pageTarget = findPageTargetId(targetsResponse);
  if (pageTarget === null) {
    return;
  }

  const windowResponse = await sendCdpCommand(websocketUrl, "Browser.getWindowForTarget", {
    targetId: pageTarget,
  });
  const windowId = readWindowId(windowResponse);
  if (windowId === null) {
    return;
  }

  await sendCdpCommand(websocketUrl, "Browser.setWindowBounds", {
    windowId,
    bounds: {
      width: viewport.width,
      height: viewport.height,
      left: 0,
      top: 0,
    },
  });
}

async function sendCdpCommand(
  websocketUrl: string,
  method: string,
  params?: Record<string, unknown>,
) {
  const websocket = new WebSocket(websocketUrl);
  await onceWebSocketOpen(websocket);

  const id = 1;
  const responsePromise = new Promise<unknown>((resolve, reject) => {
    const messageHandler = (data: Buffer) => {
      const payload = JSON.parse(data.toString("utf8")) as {
        id?: unknown;
        result?: unknown;
        error?: unknown;
      };
      if (payload.id !== id) {
        return;
      }

      websocket.off("message", messageHandler);
      websocket.off("close", closeHandler);
      websocket.close();

      if (payload.error !== undefined) {
        reject(new Error(`CDP ${method} failed: ${JSON.stringify(payload.error)}`));
        return;
      }

      resolve(payload.result ?? null);
    };

    const closeHandler = () => {
      reject(new Error(`CDP websocket closed before ${method} completed.`));
    };

    websocket.on("message", messageHandler);
    websocket.once("close", closeHandler);
    websocket.send(JSON.stringify({ id, method, params }));
  });

  return await responsePromise.finally(() => {
    if (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING) {
      websocket.close();
    }
  });
}

function findPageTargetId(payload: unknown) {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("targetInfos" in payload) ||
    !Array.isArray(payload.targetInfos)
  ) {
    return null;
  }

  const pageTarget = payload.targetInfos.find(
    (target): target is { targetId: string; type: string } =>
      typeof target === "object" &&
      target !== null &&
      "targetId" in target &&
      typeof target.targetId === "string" &&
      "type" in target &&
      target.type === "page",
  );

  return pageTarget?.targetId ?? null;
}

function readWindowId(payload: unknown) {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "windowId" in payload &&
    typeof payload.windowId === "number"
  ) {
    return payload.windowId;
  }

  return null;
}

function onceWebSocketOpen(websocket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      websocket.off("open", openHandler);
      websocket.off("error", errorHandler);
    };

    const openHandler = () => {
      cleanup();
      resolve();
    };

    const errorHandler = () => {
      cleanup();
      reject(new Error(`Failed to connect to CDP websocket at ${websocket.url}.`));
    };

    websocket.once("open", openHandler);
    websocket.once("error", errorHandler);
  });
}

async function resolveAutomationWebSocketUrl(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!response.ok) {
    throw new Error(`Chromium DevTools endpoint is unavailable on port ${port}.`);
  }

  const payload = (await response.json()) as { webSocketDebuggerUrl?: unknown };
  if (
    typeof payload.webSocketDebuggerUrl !== "string" ||
    payload.webSocketDebuggerUrl.length === 0
  ) {
    throw new Error(`Chromium DevTools endpoint on port ${port} did not return a websocket URL.`);
  }

  return payload.webSocketDebuggerUrl;
}

function assertVmHostSupport(vmBridge: string) {
  execFileSync("/usr/bin/bash", [
    "-lc",
    ["set -eu", "[ -e /dev/kvm ]", `[ -d ${quoteShell(`/sys/class/net/${vmBridge}`)} ]`].join("; "),
  ]);
}

async function assertPathExists(path: string, label: string) {
  try {
    await access(path);
  } catch {
    throw new Error(`${label} "${path}" does not exist.`);
  }
}

interface PersistedVmSnapshot {
  id: string;
  name: string;
  createdAt: string;
  sizeBytes: number;
  filePath: string;
}

async function createQcow2Overlay(
  qemuImgCommand: string,
  baseImagePath: string,
  diskImagePath: string,
) {
  await execFileAsync(qemuImgCommand, [
    "create",
    "-f",
    "qcow2",
    "-F",
    "qcow2",
    "-b",
    baseImagePath,
    diskImagePath,
  ]);
}

async function createBlankDisk(qemuImgCommand: string, diskImagePath: string, diskSizeGiB: number) {
  await execFileAsync(qemuImgCommand, ["create", "-f", "qcow2", diskImagePath, `${diskSizeGiB}G`]);
}

async function cloneQcow2Image(qemuImgCommand: string, sourcePath: string, targetPath: string) {
  await execFileAsync(qemuImgCommand, ["convert", "-O", "qcow2", sourcePath, targetPath]);
}

async function readVmSnapshotManifest(manifestPath: string): Promise<PersistedVmSnapshot[]> {
  try {
    const payload = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(payload) as
      | { snapshots?: PersistedVmSnapshot[] }
      | PersistedVmSnapshot[];
    const snapshots = Array.isArray(parsed) ? parsed : parsed.snapshots;
    if (!Array.isArray(snapshots)) {
      return [];
    }

    return snapshots.filter(isPersistedVmSnapshot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function writeVmSnapshotManifest(manifestPath: string, snapshots: PersistedVmSnapshot[]) {
  await mkdir(dirname(manifestPath), { recursive: true });
  const nextPayload = `${JSON.stringify({ snapshots }, null, 2)}\n`;
  const tempPath = `${manifestPath}.tmp-${randomUUID()}`;
  await writeFile(tempPath, nextPayload);
  await rename(tempPath, manifestPath);
}

function isPersistedVmSnapshot(value: unknown): value is PersistedVmSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "name" in value &&
    typeof value.name === "string" &&
    "createdAt" in value &&
    typeof value.createdAt === "string" &&
    "sizeBytes" in value &&
    typeof value.sizeBytes === "number" &&
    "filePath" in value &&
    typeof value.filePath === "string"
  );
}

async function createCloudInitSeed(
  spec: ReturnType<ReturnType<typeof createVmRuntimePaths>["specForName"]>,
  computerName: string,
  cloudInit: {
    enabled?: true;
    user: string;
    password?: string;
    sshAuthorizedKeys?: string[];
  },
  nic: {
    macAddress?: string;
    ipv4?:
      | { type: "disabled" }
      | { type: "dhcp" }
      | { type: "static"; address: string; prefixLength: number };
    ipv6?:
      | { type: "disabled" }
      | { type: "dhcp" }
      | { type: "slaac" }
      | { type: "static"; address: string; prefixLength: number };
  },
) {
  await mkdir(spec.cloudInitDirectory, { recursive: true });
  const userData = createCloudInitUserData(computerName, cloudInit);
  const metaData = [`instance-id: ${computerName}`, `local-hostname: ${computerName}`].join("\n");
  await writeFile(spec.cloudInitUserDataPath, userData);
  await writeFile(spec.cloudInitMetaDataPath, metaData);
  if (shouldWriteNetworkConfig(nic)) {
    const resolvedMacAddress = resolveVmNicMacAddress(spec, nic.macAddress, 0);
    await writeFile(
      spec.cloudInitNetworkConfigPath,
      createCloudInitNetworkConfig(nic, resolvedMacAddress),
    );
  }
  try {
    await execFileAsync("cloud-localds", [
      ...(shouldWriteNetworkConfig(nic)
        ? [`--network-config=${spec.cloudInitNetworkConfigPath}`]
        : []),
      spec.cloudInitImagePath,
      spec.cloudInitUserDataPath,
      spec.cloudInitMetaDataPath,
    ]);
    return;
  } catch {}

  try {
    await execFileAsync("genisoimage", [
      "-output",
      spec.cloudInitImagePath,
      "-volid",
      "cidata",
      "-joliet",
      "-rock",
      spec.cloudInitUserDataPath,
      spec.cloudInitMetaDataPath,
      ...(shouldWriteNetworkConfig(nic) ? [spec.cloudInitNetworkConfigPath] : []),
    ]);
    return;
  } catch {}

  await execFileAsync("mkisofs", [
    "-output",
    spec.cloudInitImagePath,
    "-volid",
    "cidata",
    "-joliet",
    "-rock",
    spec.cloudInitUserDataPath,
    spec.cloudInitMetaDataPath,
    ...(shouldWriteNetworkConfig(nic) ? [spec.cloudInitNetworkConfigPath] : []),
  ]);
}

export function createCloudInitUserData(
  computerName: string,
  cloudInit: {
    enabled?: true;
    user: string;
    password?: string;
    sshAuthorizedKeys?: string[];
  },
) {
  return [
    "#cloud-config",
    `hostname: ${computerName}`,
    cloudInit.password ? "ssh_pwauth: true" : null,
    "users:",
    `  - name: ${cloudInit.user}`,
    "    sudo: ALL=(ALL) NOPASSWD:ALL",
    "    shell: /bin/bash",
    cloudInit.password ? "    lock_passwd: false" : null,
    cloudInit.password ? `    plain_text_passwd: ${cloudInit.password}` : null,
    cloudInit.sshAuthorizedKeys && cloudInit.sshAuthorizedKeys.length > 0
      ? "    ssh_authorized_keys:"
      : null,
    ...(cloudInit.sshAuthorizedKeys ?? []).map((key) => `      - ${key}`),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function createCloudInitNetworkConfig(
  nic: {
    ipv4?:
      | { type: "disabled" }
      | { type: "dhcp" }
      | { type: "static"; address: string; prefixLength: number };
    ipv6?:
      | { type: "disabled" }
      | { type: "dhcp" }
      | { type: "slaac" }
      | { type: "static"; address: string; prefixLength: number };
  },
  macAddress: string,
) {
  const lines = [
    "version: 2",
    "ethernets:",
    "  primary:",
    "    match:",
    `      macaddress: ${macAddress}`,
    "    set-name: ens3",
  ];
  const addresses: string[] = [];
  const hasAnyConfiguredProtocol =
    nic.ipv4?.type === "dhcp" ||
    nic.ipv4?.type === "static" ||
    nic.ipv6?.type === "dhcp" ||
    nic.ipv6?.type === "slaac" ||
    nic.ipv6?.type === "static";

  if (!hasAnyConfiguredProtocol) {
    // Prevent systemd-networkd-wait-online from blocking boot on an intentionally disabled NIC.
    lines.push("    optional: true");
  }

  if (nic.ipv4?.type === "dhcp") {
    lines.push("    dhcp4: true");
  } else if (nic.ipv4?.type === "static") {
    lines.push("    dhcp4: false");
    addresses.push(`${nic.ipv4.address}/${nic.ipv4.prefixLength}`);
  } else {
    lines.push("    dhcp4: false");
  }

  if (nic.ipv6?.type === "dhcp") {
    lines.push("    dhcp6: true");
  } else if (nic.ipv6?.type === "slaac") {
    lines.push("    dhcp6: false", "    accept-ra: true");
  } else if (nic.ipv6?.type === "static") {
    lines.push("    dhcp6: false", "    accept-ra: false");
    addresses.push(`${nic.ipv6.address}/${nic.ipv6.prefixLength}`);
  } else {
    lines.push("    dhcp6: false");
  }

  if (addresses.length > 0) {
    lines.push("    addresses:", ...addresses.map((address) => `      - ${address}`));
  }

  return lines.join("\n");
}

function shouldWriteNetworkConfig(nic: {
  ipv4?: { type: "disabled" | "dhcp" | "static" };
  ipv6?: { type: "disabled" | "dhcp" | "slaac" | "static" };
}) {
  return nic.ipv4?.type !== undefined || nic.ipv6?.type !== undefined;
}

async function captureJpegFromVnc(display: number) {
  const outputPath = `/tmp/computerd-vnc-screenshot-${randomUUID()}.jpg`;

  try {
    await execFileAsync("/usr/bin/vncsnapshot", [`127.0.0.1:${display}`, outputPath]);
    return await readFile(outputPath);
  } finally {
    await rm(outputPath, { force: true });
  }
}

function readJpegDimensions(buffer: Buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error("Captured VNC screenshot is not a valid JPEG image.");
  }

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1] ?? -1;
    offset += 2;

    // Standalone markers without payload.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      break;
    }

    if (
      marker === 0xc0 ||
      marker === 0xc1 ||
      marker === 0xc2 ||
      marker === 0xc3 ||
      marker === 0xc5 ||
      marker === 0xc6 ||
      marker === 0xc7 ||
      marker === 0xc9 ||
      marker === 0xca ||
      marker === 0xcb ||
      marker === 0xcd ||
      marker === 0xce ||
      marker === 0xcf
    ) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }

    offset += segmentLength;
  }

  throw new Error("Could not determine JPEG screenshot dimensions.");
}

function buildVmResizeCommand(viewport: ResizeDisplayInput) {
  const size = `${viewport.width}x${viewport.height}`;
  return [
    "set -eu",
    'DISPLAY="${DISPLAY:-:0}"',
    'target="$(xrandr --query | awk \'/ connected/{print $1; exit}\')"',
    '[ -n "$target" ]',
    `xrandr --output "$target" --mode ${quoteShell(size)} || xrandr --output "$target" --auto --mode ${quoteShell(size)} || xrandr --size ${quoteShell(size)}`,
  ].join("; ");
}

function wrapVmGuestAgentError(computerName: string, error: unknown) {
  if (
    error instanceof UnsupportedComputerFeatureError ||
    error instanceof QemuGuestAgentUnavailableError ||
    error instanceof QemuGuestAgentCommandError
  ) {
    return new UnsupportedComputerFeatureError(
      `Computer "${computerName}" guest tools are unavailable: ${error.message}`,
    );
  }

  return error instanceof Error
    ? new UnsupportedComputerFeatureError(
        `Computer "${computerName}" guest tools failed: ${error.message}`,
      )
    : new UnsupportedComputerFeatureError(
        `Computer "${computerName}" guest tools failed unexpectedly.`,
      );
}

function quoteShell(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
