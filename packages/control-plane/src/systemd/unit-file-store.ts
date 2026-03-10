import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBrowserRuntimePaths, type BrowserRuntimePathsOptions } from "./browser-runtime";
import { createConsoleRuntimePaths, type ConsoleRuntimePathsOptions } from "./console-runtime";
import type {
  PersistedBrowserComputer,
  PersistedComputer,
  PersistedTerminalComputer,
} from "./types";

export interface UnitFileStore {
  deleteUnitFile: (unitName: string) => Promise<void>;
  getUnitFileContents: (unitName: string) => Promise<string | null>;
  writeUnitFile: (computer: PersistedComputer) => Promise<string>;
}

export interface FileUnitStoreOptions {
  directory: string;
  browserRuntimeDirectory: string;
  browserStateDirectory: string;
  terminalRuntimeDirectory: string;
}

export function createFileUnitStore({
  directory,
  browserRuntimeDirectory,
  browserStateDirectory,
  terminalRuntimeDirectory,
}: FileUnitStoreOptions): UnitFileStore {
  const consoleRuntimePaths = createConsoleRuntimePaths({
    runtimeDirectory: terminalRuntimeDirectory,
  });
  const browserRuntimePaths = createBrowserRuntimePaths({
    runtimeRootDirectory: browserRuntimeDirectory,
    stateRootDirectory: browserStateDirectory,
  });

  return {
    async writeUnitFile(computer) {
      const contents =
        computer.profile === "terminal"
          ? renderTerminalUnitFile(computer, {
              runtimeDirectory: terminalRuntimeDirectory,
            })
          : renderBrowserUnitFile(computer, {
              runtimeRootDirectory: browserRuntimeDirectory,
              stateRootDirectory: browserStateDirectory,
            });
      if (computer.profile === "terminal") {
        await consoleRuntimePaths.ensureComputerDirectory(computer);
      } else {
        const spec = browserRuntimePaths.specForComputer(computer);
        await mkdir(spec.profileDirectory, { recursive: true });
        await mkdir(spec.runtimeDirectory, { recursive: true });
      }
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, computer.unitName), contents);
      return contents;
    },
    async deleteUnitFile(unitName) {
      await rm(join(directory, unitName), { force: true });
    },
    async getUnitFileContents(unitName) {
      try {
        return await readFile(join(directory, unitName), "utf8");
      } catch (error: unknown) {
        if (isMissingFileError(error)) {
          return null;
        }

        throw error;
      }
    },
  };
}

function renderTerminalUnitFile(
  computer: PersistedTerminalComputer,
  consoleRuntimePathsOptions: ConsoleRuntimePathsOptions,
) {
  const consoleRuntimePaths = createConsoleRuntimePaths(consoleRuntimePathsOptions);
  const spec = consoleRuntimePaths.specForComputer(computer);
  const lines = [
    "[Unit]",
    `Description=${computer.description ?? `Computerd terminal ${computer.name}`}`,
    "",
    "[Service]",
    "Type=simple",
    "KillMode=control-group",
    `ExecStart=${buildTerminalExecStart(computer, spec)}`,
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
    `User=${computer.runtime.runtimeUser}`,
    `Group=${computer.runtime.runtimeUser}`,
    `StateDirectory=computerd/computers/${spec.slug}`,
    `RuntimeDirectory=computerd/computers/${spec.slug}`,
    `WorkingDirectory=${spec.stateDirectory}`,
    `Environment=HOME=${escapeEnvironmentAssignment(spec.homeDirectory)}`,
    `Environment=COMPUTERD_BROWSER_PROFILE_DIR=${escapeEnvironmentAssignment(spec.profileDirectory)}`,
    `Environment=COMPUTERD_BROWSER_RUNTIME_DIR=${escapeEnvironmentAssignment(spec.runtimeDirectory)}`,
    `Environment=COMPUTERD_BROWSER_DEVTOOLS_PORT=${spec.devtoolsPort}`,
    `Environment=COMPUTERD_BROWSER_VNC_PORT=${spec.vncPort}`,
    `Environment=COMPUTERD_BROWSER_DISPLAY=${spec.xvfbDisplay}`,
    `Environment=COMPUTERD_BROWSER_VIEWPORT=${spec.viewport.width}x${spec.viewport.height}`,
    `Environment=XDG_CONFIG_HOME=${escapeEnvironmentAssignment(spec.configDirectory)}`,
    `Environment=PIPEWIRE_ALSA=${escapeEnvironmentAssignment(renderPipeWireAlsaProperties(computer, spec.slug))}`,
    `Environment=PIPEWIRE_PROPS=${escapeEnvironmentAssignment(renderPipeWireClientProperties(computer, spec.slug))}`,
    `ExecStart=${buildBrowserExecStart(computer, spec)}`,
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

function buildTerminalExecStart(
  computer: PersistedTerminalComputer,
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
  const tmuxCommand = `${envPrefix}/usr/bin/bash -lc ${escapeShellToken(computer.runtime.execStart)}`;
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

function buildBrowserExecStart(
  computer: PersistedBrowserComputer,
  spec: ReturnType<ReturnType<typeof createBrowserRuntimePaths>["specForComputer"]>,
) {
  const width = spec.viewport.width;
  const height = spec.viewport.height;
  const browserLaunchCommand = [
    `Xvfb ${escapeShellToken(spec.xvfbDisplay)} -screen 0 ${width}x${height}x24 -nolisten tcp >/tmp/computerd-xvfb.log 2>&1 & XVFB_PID=$!`,
    `export DISPLAY=${escapeShellToken(spec.xvfbDisplay)}`,
    "pipewire >/tmp/computerd-pipewire.log 2>&1 & PIPEWIRE_PID=$!",
    "wireplumber >/tmp/computerd-wireplumber.log 2>&1 & WIREPLUMBER_PID=$!",
    "pipewire-pulse >/tmp/computerd-pipewire-pulse.log 2>&1 & PIPEWIRE_PULSE_PID=$!",
    'if [ "$(id -u)" -eq 0 ]; then CHROMIUM_SANDBOX_FLAG=--no-sandbox; else CHROMIUM_SANDBOX_FLAG=; fi',
    `chromium $CHROMIUM_SANDBOX_FLAG --user-data-dir=${escapeShellToken(spec.profileDirectory)} --no-first-run --no-default-browser-check --autoplay-policy=no-user-gesture-required --remote-debugging-port=${spec.devtoolsPort} --window-size=${width},${height} >/tmp/computerd-chromium.log 2>&1 & CHROMIUM_PID=$!`,
    `x11vnc -display ${escapeShellToken(spec.xvfbDisplay)} -forever -shared -rfbport ${spec.vncPort} -nopw -localhost >/tmp/computerd-x11vnc.log 2>&1 & X11VNC_PID=$!`,
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

function escapeEnvironmentAssignment(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function escapeShellToken(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function escapeSystemdExecArg(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
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
