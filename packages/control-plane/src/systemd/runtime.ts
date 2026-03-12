import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type {
  ComputerSnapshot,
  CreateComputerSnapshotInput,
  RestoreComputerInput,
} from "@computerd/core";
import { WebSocket } from "ws";
import { createBrowserRuntimePaths } from "./browser-runtime";
import { createPipeWireRuntimeEnvironment, createPipeWireHostManager } from "./pipewire-host";
import {
  createVmRuntimePaths,
  createVmSnapshotImagePath,
  resolveVmNicMacAddress,
  withPersistedVmRuntime,
} from "./vm-runtime";
import type {
  BrowserViewport,
  CreateVmComputerInput,
  PersistedBrowserComputer,
  HostUnitDetail,
  HostUnitSummary,
  PersistedComputer,
  PersistedVmComputer,
  UnitRuntimeState,
} from "./types";
import {
  createFileUnitStore,
  type FileUnitStoreOptions,
  type UnitFileStore,
} from "./unit-file-store";
import {
  createSystemdDbusClient,
  type SystemdDbusClient,
  type SystemdDbusClientOptions,
} from "./dbus-client";

export interface SystemdRuntime {
  createVmComputer: (
    input: CreateVmComputerInput,
    imagePath: string,
  ) => Promise<PersistedVmComputer["runtime"]>;
  deleteBrowserRuntimeIdentity: (computer: PersistedBrowserComputer) => Promise<void>;
  deleteVmComputer: (computer: PersistedVmComputer) => Promise<void>;
  ensureBrowserRuntimeIdentity: (computer: PersistedBrowserComputer) => Promise<void>;
  prepareBrowserRuntime: (computer: PersistedBrowserComputer) => Promise<void>;
  prepareVmRuntime: (computer: PersistedVmComputer) => Promise<void>;
  createAutomationSession: (
    computer: PersistedBrowserComputer,
  ) => Promise<import("./types").ComputerAutomationSession>;
  createAudioSession: (
    computer: PersistedBrowserComputer,
  ) => Promise<import("./types").ComputerAudioSession>;
  createMonitorSession: (
    computer: PersistedBrowserComputer | PersistedVmComputer,
  ) => Promise<import("./types").ComputerMonitorSession>;
  createPersistentUnit: (computer: PersistedComputer) => Promise<UnitRuntimeState>;
  createVmSnapshot: (
    computer: PersistedVmComputer,
    input: CreateComputerSnapshotInput,
  ) => Promise<ComputerSnapshot>;
  createScreenshot: (
    computer: PersistedBrowserComputer,
  ) => Promise<import("./types").ComputerScreenshot>;
  deletePersistentUnit: (unitName: string) => Promise<void>;
  deleteVmSnapshot: (computer: PersistedVmComputer, snapshotName: string) => Promise<void>;
  getHostUnit: (unitName: string) => Promise<HostUnitDetail | null>;
  getRuntimeState: (unitName: string) => Promise<UnitRuntimeState | null>;
  listHostUnits: () => Promise<HostUnitSummary[]>;
  listVmSnapshots: (computer: PersistedVmComputer) => Promise<ComputerSnapshot[]>;
  openAutomationAttach: (
    computer: PersistedBrowserComputer,
  ) => Promise<import("./types").BrowserAutomationLease>;
  openAudioStream: (
    computer: PersistedBrowserComputer,
  ) => Promise<import("./types").BrowserAudioStreamLease>;
  openMonitorAttach: (
    computer: PersistedBrowserComputer | PersistedVmComputer,
  ) => Promise<import("./types").BrowserMonitorLease>;
  restartUnit: (unitName: string) => Promise<UnitRuntimeState>;
  restoreVmComputer: (computer: PersistedVmComputer, input: RestoreComputerInput) => Promise<void>;
  startUnit: (unitName: string) => Promise<UnitRuntimeState>;
  stopUnit: (unitName: string) => Promise<UnitRuntimeState>;
  updateBrowserViewport: (
    computer: PersistedBrowserComputer,
    viewport: BrowserViewport,
  ) => Promise<void>;
}

export interface CreateSystemdRuntimeOptions {
  dbusClient?: SystemdDbusClient;
  dbusClientOptions?: SystemdDbusClientOptions;
  qemuImgCommand?: string;
  unitFileStore?: UnitFileStore;
  unitFileStoreOptions: FileUnitStoreOptions;
}

const execFileAsync = promisify(execFile);

export function createSystemdRuntime({
  dbusClientOptions,
  qemuImgCommand = "qemu-img",
  unitFileStoreOptions,
  dbusClient,
  unitFileStore,
}: CreateSystemdRuntimeOptions): SystemdRuntime {
  const resolvedDbusClient = dbusClient ?? createSystemdDbusClient(dbusClientOptions);
  const resolvedUnitFileStore = unitFileStore ?? createFileUnitStore(unitFileStoreOptions);
  const browserRuntimePaths = createBrowserRuntimePaths({
    runtimeRootDirectory: unitFileStoreOptions.browserRuntimeDirectory,
    stateRootDirectory: unitFileStoreOptions.browserStateDirectory,
  });
  const vmRuntimePaths = createVmRuntimePaths({
    runtimeRootDirectory: unitFileStoreOptions.vmRuntimeDirectory,
    stateRootDirectory: unitFileStoreOptions.vmStateDirectory,
  });
  const pipeWireHostManager = createPipeWireHostManager({
    browserRuntimeDirectory: unitFileStoreOptions.browserRuntimeDirectory,
    browserStateDirectory: unitFileStoreOptions.browserStateDirectory,
  });

  return {
    async createVmComputer(input: CreateVmComputerInput, imagePath: string) {
      assertVmHostSupport(resolveVmBridgeName(input.network?.mode ?? "host", unitFileStoreOptions));
      const runtime = withPersistedVmRuntime(input.runtime, imagePath);
      const spec = vmRuntimePaths.specForName(input.name);
      await mkdir(spec.stateDirectory, { recursive: true });
      await mkdir(spec.runtimeDirectory, { recursive: true });
      if (runtime.source.kind === "qcow2") {
        await assertPathExists(runtime.source.path, "Base qcow2 image");
        await createQcow2Overlay(qemuImgCommand, runtime.source.path, spec.diskImagePath);
      } else {
        await assertPathExists(runtime.source.path, "Install ISO");
        await createBlankDisk(qemuImgCommand, spec.diskImagePath, runtime.source.diskSizeGiB ?? 32);
      }

      return runtime;
    },
    async deleteBrowserRuntimeIdentity(computer) {
      await pipeWireHostManager.deleteRuntimeIdentity(computer);
    },
    async deleteVmComputer(computer) {
      const spec = vmRuntimePaths.specForComputer(computer);
      await rm(spec.runtimeDirectory, { recursive: true, force: true });
      await rm(spec.stateDirectory, { recursive: true, force: true });
    },
    async ensureBrowserRuntimeIdentity(computer) {
      await pipeWireHostManager.ensureRuntimeIdentity(computer);
    },
    async prepareBrowserRuntime(computer) {
      await pipeWireHostManager.prepareRuntime(computer);
    },
    async prepareVmRuntime(computer) {
      if (computer.runtime.source.kind !== "qcow2") {
        return;
      }

      if (computer.runtime.source.cloudInit.enabled === false) {
        return;
      }

      const spec = vmRuntimePaths.specForComputer(computer);
      await mkdir(spec.stateDirectory, { recursive: true });
      await mkdir(spec.runtimeDirectory, { recursive: true });
      await createCloudInitSeed(
        spec,
        computer.name,
        computer.runtime.source.cloudInit,
        computer.runtime.nics[0]!,
      );
    },
    async createMonitorSession(computer) {
      const spec =
        computer.profile === "browser"
          ? browserRuntimePaths.specForComputer(computer)
          : vmRuntimePaths.specForComputer(computer);
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
      };
    },
    async createAudioSession(computer) {
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
      };
    },
    async openMonitorAttach(computer) {
      const spec =
        computer.profile === "browser"
          ? browserRuntimePaths.specForComputer(computer)
          : vmRuntimePaths.specForComputer(computer);
      return {
        computerName: computer.name,
        host: "127.0.0.1",
        port: spec.vncPort,
        release() {},
      };
    },
    async openAudioStream(computer) {
      const spec = browserRuntimePaths.specForComputer(computer);
      const captureEnvironment = createPipeWireRuntimeEnvironment(computer, {
        browserRuntimeDirectory: unitFileStoreOptions.browserRuntimeDirectory,
        browserStateDirectory: unitFileStoreOptions.browserStateDirectory,
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
      };
    },
    async createAutomationSession(computer) {
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
      };
    },
    async openAutomationAttach(computer) {
      const websocketUrl = await resolveAutomationWebSocketUrl(
        browserRuntimePaths.specForComputer(computer).devtoolsPort,
      );
      return {
        computerName: computer.name,
        url: websocketUrl,
        release() {},
      };
    },
    async createScreenshot(computer) {
      const spec = browserRuntimePaths.specForComputer(computer);
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
      };
    },
    async listVmSnapshots(computer) {
      const spec = vmRuntimePaths.specForComputer(computer);
      const manifest = await readVmSnapshotManifest(spec.snapshotManifestPath);
      return manifest
        .map((snapshot) => ({
          name: snapshot.name,
          createdAt: snapshot.createdAt,
          sizeBytes: snapshot.sizeBytes,
        }))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },
    async createVmSnapshot(computer, input) {
      const spec = vmRuntimePaths.specForComputer(computer);
      const manifest = await readVmSnapshotManifest(spec.snapshotManifestPath);
      if (manifest.some((snapshot) => snapshot.name === input.name)) {
        throw new Error(`Snapshot "${input.name}" already exists for computer "${computer.name}".`);
      }

      await mkdir(spec.snapshotsDirectory, { recursive: true });
      const snapshotId = randomUUID();
      const snapshotPath = createVmSnapshotImagePath(spec, snapshotId);
      const tempSnapshotPath = `${snapshotPath}.tmp-${randomUUID()}`;
      await cloneQcow2Image(qemuImgCommand, spec.diskImagePath, tempSnapshotPath);
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
    },
    async deleteVmSnapshot(computer, snapshotName) {
      const spec = vmRuntimePaths.specForComputer(computer);
      const manifest = await readVmSnapshotManifest(spec.snapshotManifestPath);
      const snapshot = manifest.find((entry) => entry.name === snapshotName);
      if (snapshot === undefined) {
        throw new Error(
          `Snapshot "${snapshotName}" was not found for computer "${computer.name}".`,
        );
      }

      await rm(snapshot.filePath, { force: true });
      await writeVmSnapshotManifest(
        spec.snapshotManifestPath,
        manifest.filter((entry) => entry.name !== snapshotName),
      );
    },
    async restoreVmComputer(computer, input) {
      const spec = vmRuntimePaths.specForComputer(computer);
      if (input.target === "initial") {
        await rm(spec.diskImagePath, { force: true });
        if (computer.runtime.source.kind === "qcow2") {
          await assertPathExists(computer.runtime.source.path, "Base qcow2 image");
          await createQcow2Overlay(
            qemuImgCommand,
            computer.runtime.source.path,
            spec.diskImagePath,
          );
          return;
        }

        await assertPathExists(computer.runtime.source.path, "Install ISO");
        await createBlankDisk(
          qemuImgCommand,
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
      await cloneQcow2Image(qemuImgCommand, snapshot.filePath, tempDiskImagePath);
      await rename(tempDiskImagePath, spec.diskImagePath);
    },
    async updateBrowserViewport(computer, viewport) {
      const spec = browserRuntimePaths.specForComputer(computer);
      const runtimeState = await resolvedDbusClient.getRuntimeState(computer.unitName);
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
    },
    async createPersistentUnit(computer) {
      await resolvedUnitFileStore.writeUnitFile(computer);
      await resolvedDbusClient.reloadDaemon();
      await resolvedDbusClient.setUnitEnabled(
        computer.unitName,
        computer.lifecycle.autostart === true,
      );
      const runtimeState = await resolvedDbusClient.getRuntimeState(computer.unitName);
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
              ? browserRuntimePaths.specForComputer(computer).stateDirectory
              : computer.profile === "vm"
                ? vmRuntimePaths.specForComputer(computer).stateDirectory
                : undefined,
        environment: computer.profile === "host" ? computer.runtime.environment : undefined,
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

function resolveVmBridgeName(networkMode: "host" | "isolated", options: FileUnitStoreOptions) {
  if (networkMode === "host") {
    return options.vmHostBridge;
  }

  if (options.vmIsolatedBridge === undefined) {
    throw new Error("Isolated VM bridge is not configured.");
  }

  return options.vmIsolatedBridge;
}

function quoteShell(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
