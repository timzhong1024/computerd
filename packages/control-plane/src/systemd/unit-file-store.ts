import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBrowserRuntimePaths, type BrowserRuntimePathsOptions } from "./browser-runtime";
import { createConsoleRuntimePaths, type ConsoleRuntimePathsOptions } from "./console-runtime";
import { createVmRuntimePaths, resolveVmNicMacAddress } from "./vm-runtime";
import type {
  PersistedBrowserComputer,
  PersistedComputer,
  PersistedHostComputer,
  PersistedVmComputer,
} from "./types";

export interface FileUnitStoreOptions {
  directory: string;
  browserRuntimeDirectory: string;
  browserStateDirectory: string;
  terminalRuntimeDirectory: string;
  vmRuntimeDirectory: string;
  vmStateDirectory: string;
  vmHostBridge: string;
  vmIsolatedBridge?: string;
}

export abstract class UnitFileStore {
  abstract deleteUnitFile(unitName: string): Promise<void>;
  abstract getUnitFileContents(unitName: string): Promise<string | null>;
  abstract writeUnitFile(computer: PersistedComputer): Promise<string>;
}

export class FileUnitStore extends UnitFileStore {
  private readonly consoleRuntimePaths;
  private readonly browserRuntimePaths;
  private readonly vmRuntimePaths;

  constructor(private readonly options: FileUnitStoreOptions) {
    super();
    this.consoleRuntimePaths = createConsoleRuntimePaths({
      runtimeDirectory: options.terminalRuntimeDirectory,
    });
    this.browserRuntimePaths = createBrowserRuntimePaths({
      runtimeRootDirectory: options.browserRuntimeDirectory,
      stateRootDirectory: options.browserStateDirectory,
    });
    this.vmRuntimePaths = createVmRuntimePaths({
      runtimeRootDirectory: options.vmRuntimeDirectory,
      stateRootDirectory: options.vmStateDirectory,
    });
  }

  async writeUnitFile(computer: PersistedComputer) {
    if (computer.profile === "container") {
      throw new TypeError("Container computers do not render systemd unit files.");
    }
    const contents =
      computer.profile === "host"
        ? renderHostUnitFile(computer, {
            runtimeDirectory: this.options.terminalRuntimeDirectory,
          })
        : computer.profile === "browser"
          ? renderBrowserUnitFile(computer, {
              runtimeRootDirectory: this.options.browserRuntimeDirectory,
              stateRootDirectory: this.options.browserStateDirectory,
            })
          : renderVmUnitFile(computer, {
              runtimeRootDirectory: this.options.vmRuntimeDirectory,
              stateRootDirectory: this.options.vmStateDirectory,
              vmHostBridge: this.options.vmHostBridge,
              vmIsolatedBridge: this.options.vmIsolatedBridge,
            });
    if (computer.profile === "host" && computer.access.console?.mode === "pty") {
      await this.consoleRuntimePaths.ensureComputerDirectory(computer);
    } else if (computer.profile === "browser") {
      const spec = this.browserRuntimePaths.specForComputer(computer);
      await mkdir(spec.profileDirectory, { recursive: true });
      await mkdir(spec.runtimeDirectory, { recursive: true });
    } else if (computer.profile === "vm") {
      const spec = this.vmRuntimePaths.specForComputer(computer);
      await mkdir(spec.stateDirectory, { recursive: true });
      await mkdir(spec.runtimeDirectory, { recursive: true });
    }
    await mkdir(this.options.directory, { recursive: true });
    await writeFile(join(this.options.directory, computer.unitName), contents);
    return contents;
  }

  async deleteUnitFile(unitName: string) {
    await rm(join(this.options.directory, unitName), { force: true });
  }

  async getUnitFileContents(unitName: string) {
    try {
      return await readFile(join(this.options.directory, unitName), "utf8");
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return null;
      }

      throw error;
    }
  }
}

function renderHostUnitFile(
  computer: PersistedHostComputer,
  consoleRuntimePathsOptions: ConsoleRuntimePathsOptions,
) {
  const hasConsole = computer.access.console?.mode === "pty";
  const consoleRuntimePaths = hasConsole
    ? createConsoleRuntimePaths(consoleRuntimePathsOptions)
    : null;
  const spec = consoleRuntimePaths?.specForComputer(computer);
  const lines = [
    "[Unit]",
    `Description=${computer.description ?? `Computerd host ${computer.name}`}`,
    "",
    "[Service]",
    "Type=simple",
    "KillMode=control-group",
    `ExecStart=${hasConsole && spec ? buildHostConsoleExecStart(computer, spec) : buildHostServiceExecStart(computer)}`,
  ];

  if (computer.resources.cpuWeight !== undefined) {
    lines.push(`CPUWeight=${computer.resources.cpuWeight}`);
  }

  if (computer.resources.memoryMaxMiB !== undefined) {
    lines.push(`MemoryMax=${computer.resources.memoryMaxMiB * 1024 * 1024}`);
  }

  lines.push("");
  lines.push("[Install]");
  lines.push("WantedBy=multi-user.target");
  lines.push("");

  return `${lines.join("\n")}`;
}

function renderBrowserUnitFile(
  computer: PersistedBrowserComputer,
  browserRuntimePathsOptions: BrowserRuntimePathsOptions,
) {
  const browserRuntimePaths = createBrowserRuntimePaths(browserRuntimePathsOptions);
  const spec = browserRuntimePaths.specForComputer(computer);
  const lines = [
    "[Unit]",
    `Description=${computer.description ?? `Computerd browser ${computer.name}`}`,
    "",
    "[Service]",
    "Type=simple",
    "KillMode=control-group",
    "TimeoutStopSec=10s",
    `User=${computer.runtime.runtimeUser}`,
    `Group=${computer.runtime.runtimeUser}`,
    `StateDirectory=computerd/computers/${spec.slug}`,
    `RuntimeDirectory=computerd/computers/${spec.slug}`,
    "RuntimeDirectoryMode=0700",
    `WorkingDirectory=${spec.stateDirectory}`,
    renderSystemdEnvironmentLine("HOME", spec.homeDirectory),
    renderSystemdEnvironmentLine("COMPUTERD_BROWSER_PROFILE_DIR", spec.profileDirectory),
    renderSystemdEnvironmentLine("COMPUTERD_BROWSER_RUNTIME_DIR", spec.runtimeDirectory),
    renderSystemdEnvironmentLine("COMPUTERD_BROWSER_DEVTOOLS_PORT", `${spec.devtoolsPort}`),
    renderSystemdEnvironmentLine("COMPUTERD_BROWSER_VNC_PORT", `${spec.vncPort}`),
    renderSystemdEnvironmentLine("COMPUTERD_BROWSER_DISPLAY", spec.xvfbDisplay),
    renderSystemdEnvironmentLine(
      "COMPUTERD_BROWSER_VIEWPORT",
      `${spec.viewport.width}x${spec.viewport.height}`,
    ),
    renderSystemdEnvironmentLine("XDG_CONFIG_HOME", spec.configDirectory),
    renderSystemdEnvironmentLine("PULSE_SERVER", `unix:${spec.pulseServerPath}`),
    renderSystemdEnvironmentLine("PULSE_SINK", spec.audioSinkName),
    renderSystemdEnvironmentLine(
      "PIPEWIRE_ALSA",
      renderPipeWireAlsaProperties(computer, spec.slug),
    ),
    renderSystemdEnvironmentLine(
      "PIPEWIRE_PROPS",
      renderPipeWireClientProperties(computer, spec.slug),
    ),
    `ExecStart=${buildBrowserExecStart(computer, spec)}`,
    `ExecStopPost=${buildBrowserExecStopPost(spec)}`,
  ];

  if (computer.resources.cpuWeight !== undefined) {
    lines.push(`CPUWeight=${computer.resources.cpuWeight}`);
  }

  if (computer.resources.memoryMaxMiB !== undefined) {
    lines.push(`MemoryMax=${computer.resources.memoryMaxMiB * 1024 * 1024}`);
  }

  lines.push("");
  lines.push("[Install]");
  lines.push("WantedBy=multi-user.target");
  lines.push("");

  return `${lines.join("\n")}`;
}

function renderVmUnitFile(
  computer: PersistedVmComputer,
  vmRuntimePathsOptions: {
    runtimeRootDirectory: string;
    stateRootDirectory: string;
    vmHostBridge: string;
    vmIsolatedBridge?: string;
  },
) {
  const vmRuntimePaths = createVmRuntimePaths({
    runtimeRootDirectory: vmRuntimePathsOptions.runtimeRootDirectory,
    stateRootDirectory: vmRuntimePathsOptions.stateRootDirectory,
  });
  const spec = vmRuntimePaths.specForComputer(computer);
  const lines = [
    "[Unit]",
    `Description=${computer.description ?? `Computerd VM ${computer.name}`}`,
    "",
    "[Service]",
    "Type=simple",
    "KillMode=control-group",
    "TimeoutStopSec=30s",
    `WorkingDirectory=${spec.stateDirectory}`,
    `ExecStart=${buildVmExecStart(computer, spec, resolveVmBridge(computer, vmRuntimePathsOptions.vmHostBridge, vmRuntimePathsOptions.vmIsolatedBridge))}`,
    `ExecStopPost=${buildVmExecStopPost(spec)}`,
  ];

  if (computer.resources.cpuWeight !== undefined) {
    lines.push(`CPUWeight=${computer.resources.cpuWeight}`);
  }

  if (computer.resources.memoryMaxMiB !== undefined) {
    lines.push(`MemoryMax=${computer.resources.memoryMaxMiB * 1024 * 1024}`);
  }

  lines.push("");
  lines.push("[Install]");
  lines.push("WantedBy=multi-user.target");
  lines.push("");

  return `${lines.join("\n")}`;
}

function buildHostConsoleExecStart(
  computer: PersistedHostComputer,
  spec: ReturnType<ReturnType<typeof createConsoleRuntimePaths>["specForComputer"]>,
) {
  const envAssignments = Object.entries(computer.runtime.environment ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${escapeShellToken(key)}=${escapeShellToken(value)}`)
    .join(" ");
  const envPrefix = envAssignments.length > 0 ? `env ${envAssignments} ` : "";
  const workingDirectory = computer.runtime.workingDirectory
    ? ` -c ${escapeShellToken(computer.runtime.workingDirectory)}`
    : "";
  const hostCommand = computer.runtime.command ?? "/bin/sh -i";
  const tmuxCommand = `${envPrefix}/usr/bin/bash -lc ${escapeShellToken(hostCommand)}`;
  const shellScript = [
    "set -eu",
    `mkdir -p ${escapeShellToken(spec.directoryPath)}`,
    `rm -f ${escapeShellToken(spec.socketPath)}`,
    `tmux -S ${escapeShellToken(spec.socketPath)} new-session -d -s ${escapeShellToken(spec.sessionName)}${workingDirectory} ${escapeShellToken(tmuxCommand)}`,
    `trap 'tmux -S ${escapeShellToken(spec.socketPath)} kill-session -t ${escapeShellToken(spec.sessionName)} >/dev/null 2>&1 || true; rm -f ${escapeShellToken(spec.socketPath)}' EXIT INT TERM`,
    `while tmux -S ${escapeShellToken(spec.socketPath)} has-session -t ${escapeShellToken(spec.sessionName)} >/dev/null 2>&1; do sleep 1; done`,
  ].join("; ");

  return `/usr/bin/bash -lc ${escapeSystemdExecArg(shellScript)}`;
}

function buildHostServiceExecStart(computer: PersistedHostComputer) {
  const envAssignments = Object.entries(computer.runtime.environment ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${escapeShellToken(key)}=${escapeShellToken(value)}`)
    .join(" ");
  const envPrefix = envAssignments.length > 0 ? `env ${envAssignments} ` : "";
  const hostCommand = computer.runtime.command ?? "/bin/sh -i";
  const shellScript = [
    "set -eu",
    computer.runtime.workingDirectory
      ? `cd ${escapeShellToken(computer.runtime.workingDirectory)}`
      : null,
    `${envPrefix}/usr/bin/bash -lc ${escapeShellToken(hostCommand)}`,
  ]
    .filter((line): line is string => line !== null)
    .join("; ");

  return `/usr/bin/bash -lc ${escapeSystemdExecArg(shellScript)}`;
}

function buildBrowserExecStart(
  computer: PersistedBrowserComputer,
  spec: ReturnType<ReturnType<typeof createBrowserRuntimePaths>["specForComputer"]>,
) {
  const width = spec.viewport.width;
  const height = spec.viewport.height;
  const xvfbLogPath = join(spec.runtimeDirectory, "xvfb.log");
  const pipewireLogPath = join(spec.runtimeDirectory, "pipewire.log");
  const wireplumberLogPath = join(spec.runtimeDirectory, "wireplumber.log");
  const pipewirePulseLogPath = join(spec.runtimeDirectory, "pipewire-pulse.log");
  const chromiumLogPath = join(spec.runtimeDirectory, "chromium.log");
  const x11vncLogPath = join(spec.runtimeDirectory, "x11vnc.log");
  const pulseSocketPath = spec.pulseServerPath;
  const browserLaunchCommand = [
    `Xvfb ${escapeShellToken(spec.xvfbDisplay)} -screen 0 ${width}x${height}x24 -nolisten tcp >${escapeShellToken(xvfbLogPath)} 2>&1 & XVFB_PID=$!`,
    `export DISPLAY=${escapeShellToken(spec.xvfbDisplay)}`,
    `pipewire >${escapeShellToken(pipewireLogPath)} 2>&1 & PIPEWIRE_PID=$!`,
    `wireplumber >${escapeShellToken(wireplumberLogPath)} 2>&1 & WIREPLUMBER_PID=$!`,
    `pipewire-pulse >${escapeShellToken(pipewirePulseLogPath)} 2>&1 & PIPEWIRE_PULSE_PID=$!`,
    `for _ in $(seq 1 50); do [ -S ${escapeShellToken(pulseSocketPath)} ] && break; sleep 0.1; done`,
    `[ -S ${escapeShellToken(pulseSocketPath)} ]`,
    'if [ "$(id -u)" -eq 0 ]; then CHROMIUM_SANDBOX_FLAG=--no-sandbox; else CHROMIUM_SANDBOX_FLAG=; fi',
    `chromium $CHROMIUM_SANDBOX_FLAG --user-data-dir=${escapeShellToken(spec.profileDirectory)} --no-first-run --no-default-browser-check --autoplay-policy=no-user-gesture-required --remote-debugging-port=${spec.devtoolsPort} --window-size=${width},${height} >${escapeShellToken(chromiumLogPath)} 2>&1 & CHROMIUM_PID=$!`,
    `x11vnc -display ${escapeShellToken(spec.xvfbDisplay)} -forever -shared -rfbport ${spec.vncPort} -nopw -localhost >${escapeShellToken(x11vncLogPath)} 2>&1 & X11VNC_PID=$!`,
    "trap 'kill $X11VNC_PID $CHROMIUM_PID $PIPEWIRE_PULSE_PID $WIREPLUMBER_PID $PIPEWIRE_PID $XVFB_PID >/dev/null 2>&1 || true' EXIT INT TERM",
    "wait $CHROMIUM_PID",
  ].join("; ");
  const shellScript = [
    "set -eu",
    `mkdir -p ${escapeShellToken(spec.profileDirectory)} ${escapeShellToken(spec.runtimeDirectory)} ${escapeShellToken(spec.homeDirectory)} ${escapeShellToken(spec.configDirectory)} ${escapeShellToken(spec.pipewireClientConfigDirectory)}`,
    `rm -f ${escapeShellToken(join(spec.runtimeDirectory, "x11vnc.pid"))}`,
    `rm -f ${escapeShellToken(join(spec.runtimeDirectory, "chromium.pid"))}`,
    `export XDG_RUNTIME_DIR=${escapeShellToken(spec.runtimeDirectory)}`,
    `export HOME=${escapeShellToken(spec.homeDirectory)}`,
    `export XDG_CONFIG_HOME=${escapeShellToken(spec.configDirectory)}`,
    `dbus-run-session -- /usr/bin/bash -lc ${escapeShellToken(browserLaunchCommand)}`,
  ].join("; ");

  return `/usr/bin/bash -lc ${escapeSystemdExecArg(shellScript)}`;
}

function buildVmExecStart(
  computer: PersistedVmComputer,
  spec: ReturnType<ReturnType<typeof createVmRuntimePaths>["specForComputer"]>,
  vmBridge: string,
) {
  const memoryMiB = computer.resources.memoryMaxMiB ?? 2048;
  const vcpuCount = 1; // TODO: support multi core
  const installationMediaArg =
    computer.runtime.source.kind === "qcow2"
      ? computer.runtime.source.cloudInit.enabled !== false
        ? `-drive file=${escapeShellToken(spec.cloudInitImagePath)},if=virtio,media=cdrom,readonly=on`
        : null
      : `-drive file=${escapeShellToken(computer.runtime.source.path)},if=virtio,media=cdrom,readonly=on`;
  const primaryNicMacAddress = resolveVmNicMacAddress(
    spec,
    computer.runtime.nics[0]?.macAddress,
    0,
  );
  const qemuArgs = [
    "qemu-system-x86_64",
    "-enable-kvm",
    "-machine q35",
    "-cpu host",
    `-m ${memoryMiB}`,
    `-smp ${vcpuCount}`,
    "-display none",
    `-vnc 127.0.0.1:${spec.vncDisplay}`,
    `-serial unix:${spec.serialSocketPath},server=on,wait=off`,
    `-drive file=${escapeShellToken(spec.diskImagePath)},if=virtio,format=qcow2`,
    installationMediaArg,
    `-netdev bridge,id=net0,br=${escapeShellToken(vmBridge)}`,
    `-device virtio-net-pci,netdev=net0,mac=${primaryNicMacAddress}`,
  ]
    .filter((argument) => argument !== null)
    .join(" ");
  const shellScript = [
    "set -eu",
    `mkdir -p ${escapeShellToken(spec.stateDirectory)} ${escapeShellToken(spec.runtimeDirectory)}`,
    `rm -f ${escapeShellToken(spec.serialSocketPath)}`,
    `${qemuArgs}`,
  ].join("; ");

  return `/usr/bin/bash -lc ${escapeSystemdExecArg(shellScript)}`;
}

function resolveVmBridge(
  computer: PersistedVmComputer,
  vmHostBridge: string,
  vmIsolatedBridge?: string,
) {
  return computer.network.mode === "host"
    ? vmHostBridge
    : (vmIsolatedBridge ?? "__computerd_missing_isolated_bridge__");
}

function buildBrowserExecStopPost(
  spec: ReturnType<ReturnType<typeof createBrowserRuntimePaths>["specForComputer"]>,
) {
  const shellScript = [
    "set +e",
    `pkill -u ${escapeShellToken(spec.runtimeUser)} -f ${escapeShellToken(`x11vnc -display ${spec.xvfbDisplay}`)} >/dev/null 2>&1 || true`,
    `pkill -u ${escapeShellToken(spec.runtimeUser)} -f ${escapeShellToken(`Xvfb ${spec.xvfbDisplay}`)} >/dev/null 2>&1 || true`,
    `pkill -u ${escapeShellToken(spec.runtimeUser)} -f ${escapeShellToken(spec.profileDirectory)} >/dev/null 2>&1 || true`,
    `pkill -u ${escapeShellToken(spec.runtimeUser)} -x pipewire >/dev/null 2>&1 || true`,
    `pkill -u ${escapeShellToken(spec.runtimeUser)} -x pipewire-pulse >/dev/null 2>&1 || true`,
    `pkill -u ${escapeShellToken(spec.runtimeUser)} -x wireplumber >/dev/null 2>&1 || true`,
    `rm -rf ${escapeShellToken(spec.runtimeDirectory)}`,
  ].join("; ");

  return `/usr/bin/bash -lc ${escapeSystemdExecArg(shellScript)}`;
}

function buildVmExecStopPost(
  spec: ReturnType<ReturnType<typeof createVmRuntimePaths>["specForComputer"]>,
) {
  const shellScript = [`rm -f ${escapeShellToken(spec.serialSocketPath)}`].join("; ");
  return `/usr/bin/bash -lc ${escapeSystemdExecArg(shellScript)}`;
}

function escapeEnvironmentAssignment(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function renderSystemdEnvironmentLine(key: string, value: string) {
  return `Environment="${escapeEnvironmentAssignment(`${key}=${value}`)}"`;
}

function escapeShellToken(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function escapeSystemdExecArg(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').split("$").join("$$")}"`;
}

function renderPipeWireAlsaProperties(computer: PersistedBrowserComputer, slug: string) {
  return `{ application.name = "computerd-browser" media.role = "browser" node.name = "computerd-browser-${slug}" computerd.computer.name = "${computer.name}" computerd.computer.slug = "${slug}" }`;
}

function renderPipeWireClientProperties(computer: PersistedBrowserComputer, slug: string) {
  return `{ application.name = "computerd-browser" media.role = "browser" node.name = "computerd-browser-${slug}" computerd.computer.name = "${computer.name}" computerd.computer.slug = "${slug}" }`;
}

function isMissingFileError(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
