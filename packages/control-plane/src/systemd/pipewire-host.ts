import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createBrowserRuntimePaths } from "./browser-runtime";
import type { PersistedBrowserComputer } from "./types";

const execFileAsync = promisify(execFile);

export interface PipeWireHostManagerOptions {
  browserRuntimeDirectory: string;
  browserStateDirectory: string;
}

export interface PipeWireHostManager {
  deleteRuntimeIdentity: (computer: PersistedBrowserComputer) => Promise<void>;
  ensureRuntimeIdentity: (computer: PersistedBrowserComputer) => Promise<void>;
  prepareRuntime: (computer: PersistedBrowserComputer) => Promise<void>;
}

export interface PipeWireNodeTarget {
  id?: number;
  selector: string;
}

export function createPipeWireHostManager({
  browserRuntimeDirectory,
  browserStateDirectory,
}: PipeWireHostManagerOptions): PipeWireHostManager {
  const browserRuntimePaths = createBrowserRuntimePaths({
    runtimeRootDirectory: browserRuntimeDirectory,
    stateRootDirectory: browserStateDirectory,
  });

  return {
    async ensureRuntimeIdentity(computer) {
      const spec = browserRuntimePaths.specForComputer(computer);
      await ensureSystemUser(spec.runtimeUser, spec.homeDirectory);
      await prepareBrowserRuntimeDirectories(spec.runtimeUser, [
        spec.stateDirectory,
        spec.runtimeDirectory,
        spec.homeDirectory,
        spec.configDirectory,
        spec.pipewireClientConfigDirectory,
        spec.profileDirectory,
      ]);
      await ensurePipeWireClientConfig(computer, spec.pipewireClientConfigDirectory);
    },
    async prepareRuntime(computer) {
      const spec = browserRuntimePaths.specForComputer(computer);
      await ensureSystemUser(spec.runtimeUser, spec.homeDirectory);
      await prepareBrowserRuntimeDirectories(spec.runtimeUser, [
        spec.stateDirectory,
        spec.runtimeDirectory,
        spec.homeDirectory,
        spec.configDirectory,
        spec.pipewireClientConfigDirectory,
        spec.profileDirectory,
      ]);
      await ensurePipeWireClientConfig(computer, spec.pipewireClientConfigDirectory);
    },
    async deleteRuntimeIdentity(computer) {
      const spec = browserRuntimePaths.specForComputer(computer);
      await execFileAsync("/usr/bin/bash", [
        "-lc",
        `id -u ${quoteShell(spec.runtimeUser)} >/dev/null 2>&1 && userdel ${quoteShell(spec.runtimeUser)} || true`,
      ]);
    },
  };
}

export async function resolvePipeWireNodeTarget(
  computer: PersistedBrowserComputer,
  options: Pick<PipeWireHostManagerOptions, "browserRuntimeDirectory" | "browserStateDirectory">,
) {
  const browserRuntimePaths = createBrowserRuntimePaths({
    runtimeRootDirectory: options.browserRuntimeDirectory,
    stateRootDirectory: options.browserStateDirectory,
  });
  const spec = browserRuntimePaths.specForComputer(computer);
  const { stdout } = await execFileAsync("pw-dump", [], {
    env: {
      ...process.env,
      ...createPipeWireRuntimeEnvironment(computer, options),
    },
  });
  const payload = JSON.parse(stdout) as PipeWireObject[];
  const target = selectPipeWireNodeTarget(payload, computer.name, spec.runtimeUser);
  if (target === undefined) {
    throw new Error(
      `PipeWire node for browser "${computer.name}" (user ${spec.runtimeUser}) was not found.`,
    );
  }

  return {
    id: target.id,
    selector: [
      `application.name=${target.applicationName ?? "computerd-browser"}`,
      `application.process.user=${target.applicationProcessUser ?? spec.runtimeUser}`,
      `computerd.computer.name=${target.computerName ?? computer.name}`,
    ].join(","),
  } satisfies PipeWireNodeTarget;
}

export function createPipeWireRuntimeEnvironment(
  computer: PersistedBrowserComputer,
  options: Pick<PipeWireHostManagerOptions, "browserRuntimeDirectory" | "browserStateDirectory">,
) {
  const browserRuntimePaths = createBrowserRuntimePaths({
    runtimeRootDirectory: options.browserRuntimeDirectory,
    stateRootDirectory: options.browserStateDirectory,
  });
  const spec = browserRuntimePaths.specForComputer(computer);

  return {
    HOME: spec.homeDirectory,
    XDG_CONFIG_HOME: spec.configDirectory,
    XDG_RUNTIME_DIR: spec.runtimeDirectory,
  };
}

export function selectPipeWireNodeTarget(
  payload: PipeWireObject[],
  computerName: string,
  runtimeUser: string,
) {
  return payload
    .map((entry) => toPipeWireNode(entry))
    .filter(
      (entry): entry is PipeWireNode =>
        entry !== null &&
        entry.mediaClass === "Stream/Output/Audio" &&
        entry.applicationName === "computerd-browser" &&
        entry.applicationProcessUser === runtimeUser &&
        entry.computerName === computerName,
    )
    .sort((left, right) => right.id - left.id)[0];
}

async function ensureSystemUser(user: string, homeDirectory: string) {
  await execFileAsync("/usr/bin/bash", [
    "-lc",
    [
      `if ! id -u ${quoteShell(user)} >/dev/null 2>&1; then`,
      `useradd --system --create-home --home-dir ${quoteShell(homeDirectory)} --shell /usr/sbin/nologin ${quoteShell(user)};`,
      "fi",
    ].join(" "),
  ]);
}

async function prepareBrowserRuntimeDirectories(user: string, directories: string[]) {
  for (const directory of directories) {
    await mkdir(directory, { recursive: true });
  }

  await execFileAsync("/usr/bin/bash", [
    "-lc",
    directories.map((directory) => `chown -R ${quoteShell(`${user}:${user}`)} ${quoteShell(directory)}`).join(" && "),
  ]);
}

async function ensurePipeWireClientConfig(
  computer: PersistedBrowserComputer,
  directory: string,
) {
  await mkdir(directory, { recursive: true });
  const slug = computer.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const contents = `context.properties = {\n  application.name = "computerd-browser"\n  media.role = "browser"\n  node.name = "computerd-browser-${slug}"\n  computerd.computer.name = "${computer.name}"\n  computerd.computer.slug = "${slug}"\n}\n`;
  await writeFile(join(directory, "computerd-browser.conf"), contents);
}

interface PipeWireObject {
  id?: number;
  info?: {
    props?: Record<string, string | number>;
  };
  type?: string;
}

interface PipeWireNode {
  applicationName?: string;
  applicationProcessUser?: string;
  computerName?: string;
  id: number;
  mediaClass?: string;
}

function toPipeWireNode(entry: PipeWireObject): PipeWireNode | null {
  if (typeof entry.id !== "number") {
    return null;
  }

  const props = entry.info?.props ?? {};
  return {
    id: entry.id,
    applicationName: asString(props["application.name"]),
    applicationProcessUser: asString(props["application.process.user"]),
    computerName: asString(props["computerd.computer.name"]),
    mediaClass: asString(props["media.class"]),
  };
}

function asString(value: string | number | undefined) {
  return typeof value === "string" ? value : typeof value === "number" ? `${value}` : undefined;
}

function quoteShell(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
