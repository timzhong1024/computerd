import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import type { ComputerSnapshot, HostUnitDetail } from "@computerd/core";
import { createBrowserRuntimePaths, withBrowserViewport } from "./systemd/browser-runtime";
import { createConsoleRuntimePaths } from "./systemd/console-runtime";
import { createVmRuntimePaths, withPersistedVmRuntime } from "./systemd/vm-runtime";
import {
  ComputerNotFoundError,
  ComputerRuntimePort,
  slugify,
  type PersistedBrowserComputer,
  type PersistedComputer,
  type PersistedContainerComputer,
  type PersistedHostComputer,
  type PersistedVmComputer,
  type UnitRuntimeState,
} from "./shared";

interface DevelopmentComputerRuntimeOptions {
  browserRuntimePaths: ReturnType<typeof createBrowserRuntimePaths>;
  consoleRuntimePaths: ReturnType<typeof createConsoleRuntimePaths>;
  containerStates: Map<string, UnitRuntimeState>;
  hostUnits: HostUnitDetail[];
  records: Map<string, PersistedComputer>;
  runtimeStates: Map<string, UnitRuntimeState>;
  vmRuntimePaths: ReturnType<typeof createVmRuntimePaths>;
  vmSnapshots: Map<string, ComputerSnapshot[]>;
}

export class DevelopmentComputerRuntime extends ComputerRuntimePort {
  constructor(private readonly options: DevelopmentComputerRuntimeOptions) {
    super();
  }

  async createContainerComputer(
    input: Parameters<ComputerRuntimePort["createContainerComputer"]>[0],
    unitName: string,
    _network: Parameters<ComputerRuntimePort["createContainerComputer"]>[2],
  ) {
    const containerName = unitName.replace(/\.service$/, "");
    const containerId = `development-${slugify(input.name)}`;
    this.options.containerStates.set(containerId, {
      unitName: `docker:${slugify(input.name)}`,
      description: input.description,
      unitType: "container",
      loadState: "loaded",
      activeState: "inactive",
      subState: "created",
      execStart:
        input.runtime.command ?? (input.access?.console?.mode === "pty" ? "/bin/sh -i" : undefined),
      workingDirectory: input.runtime.workingDirectory,
      environment: input.runtime.environment,
    });
    return {
      ...input.runtime,
      command:
        input.runtime.command ?? (input.access?.console?.mode === "pty" ? "/bin/sh -i" : undefined),
      containerId,
      containerName,
    };
  }

  async createVmComputer(
    input: Parameters<ComputerRuntimePort["createVmComputer"]>[0],
    imagePath: string,
    network: Parameters<ComputerRuntimePort["createVmComputer"]>[2],
  ) {
    return withPersistedVmRuntime(input.runtime, imagePath, network.bridgeName);
  }

  async deleteBrowserRuntimeIdentity() {}

  async deleteContainerComputer(computer: PersistedContainerComputer) {
    this.options.containerStates.delete(computer.runtime.containerId);
  }

  async deleteVmComputer(computer: PersistedVmComputer) {
    this.options.vmSnapshots.delete(computer.name);
  }

  async ensureBrowserRuntimeIdentity() {}

  async prepareBrowserRuntime() {}

  async prepareVmRuntime() {}

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
    } satisfies Awaited<ReturnType<ComputerRuntimePort["createAutomationSession"]>>;
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
    } satisfies Awaited<ReturnType<ComputerRuntimePort["createAudioSession"]>>;
  }

  async createMonitorSession(computer: PersistedBrowserComputer | PersistedVmComputer) {
    const spec =
      computer.profile === "browser"
        ? this.options.browserRuntimePaths.specForComputer(computer)
        : this.options.vmRuntimePaths.specForComputer(computer);
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
    } satisfies Awaited<ReturnType<ComputerRuntimePort["createMonitorSession"]>>;
  }

  async createPersistentUnit(computer: PersistedComputer) {
    if (computer.profile === "host" && computer.access.console?.mode === "pty") {
      await ensureDevelopmentConsoleSocket(this.options.consoleRuntimePaths, computer);
    } else if (computer.profile === "browser") {
      const spec = this.options.browserRuntimePaths.specForComputer(computer);
      await mkdir(spec.profileDirectory, { recursive: true });
      await mkdir(spec.runtimeDirectory, { recursive: true });
    } else if (computer.profile === "vm") {
      const spec = this.options.vmRuntimePaths.specForComputer(computer);
      await mkdir(spec.stateDirectory, { recursive: true });
      await mkdir(spec.runtimeDirectory, { recursive: true });
      await writeFile(spec.serialSocketPath, "");
    }
    const state = {
      unitName: computer.unitName,
      description: computer.description,
      unitType: "service",
      loadState: "loaded",
      activeState: "inactive",
      subState: "dead",
      execStart:
        computer.profile === "host"
          ? computer.runtime.command
          : computer.profile === "vm"
            ? "/usr/bin/qemu-system-x86_64"
            : "/usr/bin/bash -lc",
      workingDirectory:
        computer.profile === "host"
          ? computer.runtime.workingDirectory
          : computer.profile === "browser"
            ? this.options.browserRuntimePaths.specForComputer(computer).stateDirectory
            : computer.profile === "vm"
              ? this.options.vmRuntimePaths.specForComputer(computer).stateDirectory
              : undefined,
      environment: computer.profile === "host" ? computer.runtime.environment : undefined,
      cpuWeight: computer.resources.cpuWeight,
      memoryMaxMiB: computer.resources.memoryMaxMiB,
    } satisfies UnitRuntimeState;
    this.options.runtimeStates.set(computer.unitName, state);
    return state;
  }

  async createScreenshot(computer: PersistedBrowserComputer | PersistedVmComputer) {
    if (computer.profile === "vm") {
      const spec = this.options.vmRuntimePaths.specForComputer(computer);
      return {
        computerName: computer.name,
        format: "jpeg",
        mimeType: "image/jpeg",
        capturedAt: new Date().toISOString(),
        width: spec.viewport.width,
        height: spec.viewport.height,
        dataBase64: Buffer.from(`development-screenshot:${computer.name}`).toString("base64"),
      } satisfies Awaited<ReturnType<ComputerRuntimePort["createScreenshot"]>>;
    }

    const spec = this.options.browserRuntimePaths.specForComputer(computer);
    return {
      computerName: computer.name,
      format: "png",
      mimeType: "image/png",
      capturedAt: new Date().toISOString(),
      width: spec.viewport.width,
      height: spec.viewport.height,
      dataBase64: Buffer.from(`development-screenshot:${computer.name}`).toString("base64"),
    } satisfies Awaited<ReturnType<ComputerRuntimePort["createScreenshot"]>>;
  }

  async createVmSnapshot(
    computer: PersistedVmComputer,
    input: Parameters<ComputerRuntimePort["createVmSnapshot"]>[1],
  ) {
    const snapshots = this.options.vmSnapshots.get(computer.name) ?? [];
    if (snapshots.some((snapshot) => snapshot.name === input.name)) {
      throw new Error(`Snapshot "${input.name}" already exists for computer "${computer.name}".`);
    }

    const snapshot = {
      name: input.name,
      createdAt: new Date().toISOString(),
      sizeBytes: 0,
    } satisfies ComputerSnapshot;
    this.options.vmSnapshots.set(computer.name, [snapshot, ...snapshots]);
    return snapshot;
  }

  async deletePersistentUnit(unitName: string) {
    const record = this.findRecordByUnitName(unitName);
    if (record?.profile === "host") {
      await cleanupDevelopmentConsoleRuntime(this.options.consoleRuntimePaths, record);
    } else if (record?.profile === "browser") {
      const spec = this.options.browserRuntimePaths.specForComputer(record);
      await writeFile(`${spec.runtimeDirectory}/stopped`, "");
    } else if (record?.profile === "vm") {
      const spec = this.options.vmRuntimePaths.specForComputer(record);
      await writeFile(`${spec.runtimeDirectory}/stopped`, "");
    }
    this.options.runtimeStates.delete(unitName);
  }

  async deleteVmSnapshot(computer: PersistedVmComputer, snapshotName: string) {
    const snapshots = this.options.vmSnapshots.get(computer.name) ?? [];
    if (!snapshots.some((snapshot) => snapshot.name === snapshotName)) {
      throw new Error(`Snapshot "${snapshotName}" was not found for computer "${computer.name}".`);
    }

    this.options.vmSnapshots.set(
      computer.name,
      snapshots.filter((snapshot) => snapshot.name !== snapshotName),
    );
  }

  async getContainerRuntimeState(computer: PersistedContainerComputer) {
    return this.options.containerStates.get(computer.runtime.containerId) ?? null;
  }

  async getRuntimeState(unitName: string) {
    return this.options.runtimeStates.get(unitName) ?? null;
  }

  async listHostUnits() {
    return this.options.hostUnits.map((unit) => ({
      unitName: unit.unitName,
      unitType: unit.unitType,
      state: unit.state,
      description: unit.description,
      capabilities: unit.capabilities,
    }));
  }

  async listVmSnapshots(computer: PersistedVmComputer) {
    return this.options.vmSnapshots.get(computer.name) ?? [];
  }

  async getHostUnit(unitName: string) {
    return this.options.hostUnits.find((unit) => unit.unitName === unitName) ?? null;
  }

  async openAutomationAttach(computer: PersistedBrowserComputer) {
    return {
      computerName: computer.name,
      url: `ws://127.0.0.1:${this.options.browserRuntimePaths.specForComputer(computer).devtoolsPort}/devtools/browser/development`,
      release() {},
    };
  }

  async openAudioStream(computer: PersistedBrowserComputer) {
    return {
      computerName: computer.name,
      command: "ffmpeg",
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-c:a",
        "libopus",
        "-b:a",
        "128k",
        "-f",
        "ogg",
        "pipe:1",
      ],
      env: {
        PIPEWIRE_PROPS: JSON.stringify({
          "application.name": "computerd-audio-capture",
          "computerd.computer.name": computer.name,
        }),
      },
      targetSelector: `computerd.computer.name=${computer.name}`,
      release() {},
    };
  }

  async openMonitorAttach(computer: PersistedBrowserComputer | PersistedVmComputer) {
    const spec =
      computer.profile === "browser"
        ? this.options.browserRuntimePaths.specForComputer(computer)
        : this.options.vmRuntimePaths.specForComputer(computer);
    return {
      computerName: computer.name,
      host: "127.0.0.1",
      port: spec.vncPort,
      release() {},
    };
  }

  async restartUnit(unitName: string) {
    const state = this.requireRuntimeState(unitName);
    state.activeState = "active";
    state.subState = "running";
    const record = this.findRecordByUnitName(unitName);
    if (record?.profile === "host") {
      await ensureDevelopmentConsoleSocket(this.options.consoleRuntimePaths, record);
    } else if (record?.profile === "browser") {
      const spec = this.options.browserRuntimePaths.specForComputer(record);
      await mkdir(spec.runtimeDirectory, { recursive: true });
    } else if (record?.profile === "vm") {
      const spec = this.options.vmRuntimePaths.specForComputer(record);
      await mkdir(spec.runtimeDirectory, { recursive: true });
      await writeFile(spec.serialSocketPath, "");
    }
    return state;
  }

  async restartContainerComputer(computer: PersistedContainerComputer) {
    const state = this.requireContainerState(computer);
    state.activeState = "active";
    state.subState = "running";
    return state;
  }

  async startUnit(unitName: string) {
    const state = this.requireRuntimeState(unitName);
    state.activeState = "active";
    state.subState = "running";
    const record = this.findRecordByUnitName(unitName);
    if (record?.profile === "host") {
      await ensureDevelopmentConsoleSocket(this.options.consoleRuntimePaths, record);
    } else if (record?.profile === "browser") {
      const spec = this.options.browserRuntimePaths.specForComputer(record);
      await mkdir(spec.runtimeDirectory, { recursive: true });
    } else if (record?.profile === "vm") {
      const spec = this.options.vmRuntimePaths.specForComputer(record);
      await mkdir(spec.runtimeDirectory, { recursive: true });
      await writeFile(spec.serialSocketPath, "");
    }
    return state;
  }

  async startContainerComputer(computer: PersistedContainerComputer) {
    const state = this.requireContainerState(computer);
    state.activeState = "active";
    state.subState = "running";
    return state;
  }

  async stopUnit(unitName: string) {
    const state = this.requireRuntimeState(unitName);
    state.activeState = "inactive";
    state.subState = "dead";
    const record = this.findRecordByUnitName(unitName);
    if (record?.profile === "host") {
      await cleanupDevelopmentConsoleRuntime(this.options.consoleRuntimePaths, record);
    } else if (record?.profile === "browser") {
      const spec = this.options.browserRuntimePaths.specForComputer(record);
      await writeFile(`${spec.runtimeDirectory}/stopped`, "");
    } else if (record?.profile === "vm") {
      const spec = this.options.vmRuntimePaths.specForComputer(record);
      await writeFile(`${spec.runtimeDirectory}/stopped`, "");
    }
    return state;
  }

  async stopContainerComputer(computer: PersistedContainerComputer) {
    const state = this.requireContainerState(computer);
    state.activeState = "inactive";
    state.subState = "exited";
    return state;
  }

  async restoreVmComputer(
    computer: PersistedVmComputer,
    input: Parameters<ComputerRuntimePort["restoreVmComputer"]>[1],
  ) {
    if (input.target === "initial") {
      return;
    }

    const snapshots = this.options.vmSnapshots.get(computer.name) ?? [];
    if (!snapshots.some((snapshot) => snapshot.name === input.snapshotName)) {
      throw new Error(
        `Snapshot "${input.snapshotName}" was not found for computer "${computer.name}".`,
      );
    }
  }

  async updateBrowserViewport(
    computer: PersistedBrowserComputer,
    viewport: Parameters<ComputerRuntimePort["updateBrowserViewport"]>[1],
  ) {
    const state = this.options.runtimeStates.get(computer.unitName);
    if (state?.activeState !== "active") {
      return;
    }

    const spec = this.options.browserRuntimePaths.specForComputer(
      withBrowserViewport(computer, viewport),
    );
    await mkdir(spec.runtimeDirectory, { recursive: true });
  }

  private findRecordByUnitName(unitName: string) {
    return [...this.options.records.values()].find((entry) => entry.unitName === unitName);
  }

  private requireRuntimeState(unitName: string) {
    const state = this.options.runtimeStates.get(unitName);
    if (!state) {
      throw new ComputerNotFoundError(unitName);
    }

    return state;
  }

  private requireContainerState(computer: PersistedContainerComputer) {
    const state = this.options.containerStates.get(computer.runtime.containerId);
    if (!state) {
      throw new ComputerNotFoundError(computer.name);
    }

    return state;
  }
}

export async function ensureDevelopmentConsoleSocket(
  consoleRuntimePaths: ReturnType<typeof createConsoleRuntimePaths>,
  computer: PersistedHostComputer,
) {
  const spec = await consoleRuntimePaths.ensureComputerDirectory(computer);
  if (process.platform !== "darwin") {
    ensureDevelopmentTmuxSession(spec, computer);
    return;
  }

  await writeFile(spec.socketPath, "");
}

async function cleanupDevelopmentConsoleRuntime(
  consoleRuntimePaths: ReturnType<typeof createConsoleRuntimePaths>,
  computer: PersistedHostComputer,
) {
  const spec = consoleRuntimePaths.specForComputer(computer);
  if (process.platform !== "darwin") {
    try {
      execFileSync("tmux", ["-S", spec.socketPath, "kill-session", "-t", spec.sessionName], {
        stdio: "ignore",
      });
    } catch {
      // Ignore missing development tmux sessions during cleanup.
    }
  }

  await consoleRuntimePaths.cleanupComputerDirectory(computer);
}

function ensureDevelopmentTmuxSession(
  spec: ReturnType<ReturnType<typeof createConsoleRuntimePaths>["specForComputer"]>,
  computer: PersistedHostComputer,
) {
  try {
    execFileSync("tmux", ["-S", spec.socketPath, "has-session", "-t", spec.sessionName], {
      stdio: "ignore",
    });
    return;
  } catch {
    // Create the session below when it does not exist yet.
  }

  const command = buildDevelopmentTmuxCommand(computer);
  execFileSync(
    "tmux",
    ["-S", spec.socketPath, "new-session", "-d", "-s", spec.sessionName, command],
    {
      stdio: "ignore",
    },
  );
}

function buildDevelopmentTmuxCommand(computer: PersistedHostComputer) {
  const segments = ["set -eu"];
  if (computer.runtime.workingDirectory) {
    segments.push(`cd ${escapeShellToken(computer.runtime.workingDirectory)}`);
  }

  if (computer.runtime.environment) {
    for (const [key, value] of Object.entries(computer.runtime.environment)) {
      segments.push(`export ${key}=${escapeShellToken(value)}`);
    }
  }

  segments.push(`exec ${computer.runtime.command ?? "/bin/sh -i"}`);
  return segments.join("; ");
}

function escapeShellToken(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
