import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createConsoleRuntimePaths, type ConsoleRuntimePathsOptions } from "./console-runtime";
import type { PersistedTerminalComputer } from "./types";

export interface UnitFileStore {
  deleteUnitFile: (unitName: string) => Promise<void>;
  getUnitFileContents: (unitName: string) => Promise<string | null>;
  writeTerminalUnitFile: (computer: PersistedTerminalComputer) => Promise<string>;
}

export interface FileUnitStoreOptions {
  directory: string;
  terminalRuntimeDirectory: string;
}

export function createFileUnitStore({
  directory,
  terminalRuntimeDirectory,
}: FileUnitStoreOptions): UnitFileStore {
  const consoleRuntimePaths = createConsoleRuntimePaths({
    runtimeDirectory: terminalRuntimeDirectory,
  });

  return {
    async writeTerminalUnitFile(computer) {
      const contents = renderTerminalUnitFile(computer, {
        runtimeDirectory: terminalRuntimeDirectory,
      });
      await consoleRuntimePaths.ensureComputerDirectory(computer);
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

function escapeEnvironmentAssignment(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function escapeShellToken(value: string) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function escapeSystemdExecArg(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function isMissingFileError(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
