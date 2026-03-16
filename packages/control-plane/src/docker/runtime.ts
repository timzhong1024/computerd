import { request as httpRequest } from "node:http";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connect as connectNet } from "node:net";
import Docker from "dockerode";
import type {
  BrowserViewport,
  ComputerAutomationSession,
  ComputerAudioSession,
  ComputerMonitorSession,
  ComputerScreenshot,
  CreateBrowserComputerInput,
  CreateContainerComputerInput,
  DisplayAction,
  RunDisplayActionsObserve,
  RunDisplayActionsResult,
} from "@computerd/core";
import { executeDisplayActionsOverVnc } from "../display-actions";
import {
  UnsupportedComputerFeatureError,
  slugify,
  type BrowserAutomationLease,
  type BrowserAudioStreamLease,
  type BrowserMonitorLease,
  type PersistedBrowserComputer,
  type PersistedContainerComputer,
  type UnitRuntimeState,
} from "../shared";
import type { PersistedNetworkRecord } from "../networks";
import { createBrowserRuntimePaths, createBrowserRuntimeUser } from "../systemd/browser-runtime";

const DEFAULT_BROWSER_IMAGE = "computerd/browser-runtime:latest";
const CONTAINER_BROWSER_DEVTOOLS_PORT = 9222;
const CONTAINER_BROWSER_VNC_PORT = 5900;
const CONTAINER_STATE_ROOT = "/computerd/state";
const CONTAINER_RUNTIME_ROOT = "/computerd/runtime";

export abstract class DockerRuntime {
  abstract createBrowserComputer(
    input: CreateBrowserComputerInput,
    unitName: string,
    network: PersistedNetworkRecord,
  ): Promise<PersistedBrowserComputer["runtime"]>;
  abstract createContainerComputer(
    input: CreateContainerComputerInput,
    unitName: string,
    network: PersistedNetworkRecord,
  ): Promise<PersistedContainerComputer["runtime"]>;
  abstract createAutomationSession(
    computer: PersistedBrowserComputer,
  ): Promise<ComputerAutomationSession>;
  abstract createAudioSession(computer: PersistedBrowserComputer): Promise<ComputerAudioSession>;
  abstract createMonitorSession(
    computer: PersistedBrowserComputer,
  ): Promise<ComputerMonitorSession>;
  abstract createScreenshot(computer: PersistedBrowserComputer): Promise<ComputerScreenshot>;
  abstract runDisplayActions(
    computer: PersistedBrowserComputer,
    ops: DisplayAction[],
    observe: RunDisplayActionsObserve,
  ): Promise<RunDisplayActionsResult>;
  abstract deleteBrowserComputer(computer: PersistedBrowserComputer): Promise<void>;
  abstract deleteContainerComputer(computer: PersistedContainerComputer): Promise<void>;
  abstract getBrowserRuntimeState(
    computer: PersistedBrowserComputer,
  ): Promise<UnitRuntimeState | null>;
  abstract getContainerRuntimeState(
    computer: PersistedContainerComputer,
  ): Promise<UnitRuntimeState | null>;
  abstract openAutomationAttach(
    computer: PersistedBrowserComputer,
  ): Promise<BrowserAutomationLease>;
  abstract openAudioStream(computer: PersistedBrowserComputer): Promise<BrowserAudioStreamLease>;
  abstract openMonitorAttach(computer: PersistedBrowserComputer): Promise<BrowserMonitorLease>;
  abstract prepareBrowserRuntime(computer: PersistedBrowserComputer): Promise<void>;
  abstract restartBrowserComputer(computer: PersistedBrowserComputer): Promise<UnitRuntimeState>;
  abstract restartContainerComputer(
    computer: PersistedContainerComputer,
  ): Promise<UnitRuntimeState>;
  abstract startBrowserComputer(computer: PersistedBrowserComputer): Promise<UnitRuntimeState>;
  abstract startContainerComputer(computer: PersistedContainerComputer): Promise<UnitRuntimeState>;
  abstract stopBrowserComputer(computer: PersistedBrowserComputer): Promise<UnitRuntimeState>;
  abstract stopContainerComputer(computer: PersistedContainerComputer): Promise<UnitRuntimeState>;
  abstract updateBrowserViewport(
    computer: PersistedBrowserComputer,
    viewport: BrowserViewport,
  ): Promise<void>;
}

export interface DefaultDockerRuntimeOptions {
  browserImage?: string;
  browserRuntimeDirectory?: string;
  browserStateDirectory?: string;
}

export class DefaultDockerRuntime extends DockerRuntime {
  private readonly browserImage: string;
  private readonly browserRuntimePaths;

  constructor(
    private readonly dockerClient: Docker,
    options: DefaultDockerRuntimeOptions = {},
  ) {
    super();
    this.browserImage = options.browserImage ?? DEFAULT_BROWSER_IMAGE;
    this.browserRuntimePaths = createBrowserRuntimePaths({
      runtimeRootDirectory: options.browserRuntimeDirectory ?? "/run/computerd/computers",
      stateRootDirectory: options.browserStateDirectory ?? "/var/lib/computerd/computers",
    });
  }

  async createBrowserComputer(
    input: CreateBrowserComputerInput,
    unitName: string,
    network: PersistedNetworkRecord,
  ): Promise<PersistedBrowserComputer["runtime"]> {
    const runtimeUser = createBrowserRuntimeUser(input.name);
    const runtime = {
      ...input.runtime,
      provider: "container" as const,
      runtimeUser,
    };
    const computer = createBrowserRuntimeRecord(input, unitName, network.id, runtime);
    const spec = this.browserRuntimePaths.specForComputer(computer);
    const containerName = `computerd-browser-${spec.slug}`;
    const createOptions = {
      name: containerName,
      Image: this.browserImage,
      Env: [
        `COMPUTERD_BROWSER_NAME=${input.name}`,
        `COMPUTERD_BROWSER_PROFILE_DIR=${join(CONTAINER_STATE_ROOT, "profile")}`,
        `COMPUTERD_BROWSER_RUNTIME_DIR=${CONTAINER_RUNTIME_ROOT}`,
        `COMPUTERD_BROWSER_CONTROL_SOCKET=${join(CONTAINER_RUNTIME_ROOT, "control.sock")}`,
        `COMPUTERD_BROWSER_VIEWPORT=${spec.viewport.width}x${spec.viewport.height}`,
        "COMPUTERD_BROWSER_DEVTOOLS_PORT=9222",
        "COMPUTERD_BROWSER_VNC_PORT=5900",
      ],
      ExposedPorts: {
        "5900/tcp": {},
        "9222/tcp": {},
      },
      Labels: {
        "computerd.managed": "true",
        "computerd.computer.name": input.name,
        "computerd.profile": "browser",
        "computerd.network.id": network.id,
      },
      HostConfig: {
        Binds: [
          `${spec.stateDirectory}:${CONTAINER_STATE_ROOT}`,
          `${spec.runtimeDirectory}:${CONTAINER_RUNTIME_ROOT}`,
        ],
        NetworkMode: network.kind === "isolated" ? network.dockerNetworkName : undefined,
        PortBindings: {
          "5900/tcp": [{ HostIp: "127.0.0.1", HostPort: `${spec.vncPort}` }],
          "9222/tcp": [{ HostIp: "127.0.0.1", HostPort: `${spec.devtoolsPort}` }],
        },
      },
    } satisfies Parameters<Docker["createContainer"]>[0];
    const container = await createContainerWithAutoPull(
      this.dockerClient,
      this.browserImage,
      createOptions,
    );

    return {
      ...runtime,
      provider: "container",
      containerId: container.id,
      containerName,
      hostVncPort: spec.vncPort,
      hostDevtoolsPort: spec.devtoolsPort,
      controlSocketPath: spec.controlSocketPath,
    };
  }

  async createContainerComputer(
    input: CreateContainerComputerInput,
    unitName: string,
    network: PersistedNetworkRecord,
  ) {
    const containerName = unitName.replace(/\.service$/, "");
    const command = resolveContainerCommand(input);
    const createOptions = {
      name: containerName,
      Image: input.runtime.image,
      Cmd: command,
      WorkingDir: input.runtime.workingDirectory,
      Env: toDockerEnvironment(input.runtime.environment),
      Tty: input.access?.console?.mode === "pty",
      OpenStdin: input.access?.console?.mode === "pty",
      AttachStdin: input.access?.console?.mode === "pty",
      AttachStdout: true,
      AttachStderr: true,
      Labels: {
        "computerd.managed": "true",
        "computerd.computer.name": input.name,
        "computerd.profile": "container",
        "computerd.network.id": network.id,
      },
      HostConfig:
        network.kind === "host"
          ? {
              NetworkMode: "host",
            }
          : {
              NetworkMode: network.dockerNetworkName,
            },
    } satisfies Parameters<Docker["createContainer"]>[0];
    const container = await createContainerWithAutoPull(
      this.dockerClient,
      input.runtime.image,
      createOptions,
    );

    return {
      ...input.runtime,
      command: input.runtime.command ?? defaultContainerCommand(input),
      containerId: container.id,
      containerName,
    };
  }

  async createAutomationSession(
    computer: PersistedBrowserComputer,
  ): Promise<ComputerAutomationSession> {
    return {
      computerName: computer.name,
      protocol: "cdp" as const,
      connect: {
        mode: "relative-websocket-path" as const,
        url: `/api/computers/${encodeURIComponent(computer.name)}/automation/ws`,
      },
      authorization: { mode: "none" as const },
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
  }

  async createAudioSession(computer: PersistedBrowserComputer): Promise<ComputerAudioSession> {
    return await Promise.reject(
      new UnsupportedComputerFeatureError(
        `Computer "${computer.name}" does not support audio sessions.`,
      ),
    );
  }

  async createMonitorSession(computer: PersistedBrowserComputer): Promise<ComputerMonitorSession> {
    const spec = this.requireBrowserSpec(computer);
    return {
      computerName: computer.name,
      protocol: "vnc" as const,
      connect: {
        mode: "relative-websocket-path" as const,
        url: `/api/computers/${encodeURIComponent(computer.name)}/monitor/ws`,
      },
      authorization: { mode: "none" as const },
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      viewport: spec.viewport,
    };
  }

  async createScreenshot(computer: PersistedBrowserComputer) {
    const spec = this.requireBrowserSpec(computer);
    const response = await requestControlJson<{ screenshot: ComputerScreenshot }>(
      spec.controlSocketPath,
      "POST",
      "/screenshot",
      {},
    );
    return response.screenshot;
  }

  async runDisplayActions(
    computer: PersistedBrowserComputer,
    ops: DisplayAction[],
    observe: RunDisplayActionsObserve,
  ) {
    const spec = this.requireBrowserSpec(computer);
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

  async deleteBrowserComputer(computer: PersistedBrowserComputer) {
    await this.removeContainer(computer.runtime.containerId);
  }

  async deleteContainerComputer(computer: PersistedContainerComputer) {
    await this.removeContainer(computer.runtime.containerId);
  }

  async getBrowserRuntimeState(computer: PersistedBrowserComputer) {
    if (!computer.runtime.containerId) {
      return null;
    }
    try {
      const inspection = await this.dockerClient
        .getContainer(computer.runtime.containerId)
        .inspect();
      return toBrowserUnitRuntimeState(computer, inspection);
    } catch (error: unknown) {
      if (isMissingContainerError(error)) {
        return null;
      }
      throw error;
    }
  }

  async getContainerRuntimeState(computer: PersistedContainerComputer) {
    try {
      const inspection = await this.dockerClient
        .getContainer(computer.runtime.containerId)
        .inspect();
      return toContainerUnitRuntimeState(computer, inspection);
    } catch (error: unknown) {
      if (isMissingContainerError(error)) {
        return null;
      }
      throw error;
    }
  }

  async openAutomationAttach(computer: PersistedBrowserComputer) {
    const spec = this.requireBrowserSpec(computer);
    const metadata = await fetchJson<{ webSocketDebuggerUrl?: string }>(
      `http://127.0.0.1:${spec.devtoolsPort}/json/version`,
    );
    if (!metadata.webSocketDebuggerUrl) {
      throw new Error(`Browser "${computer.name}" did not expose a CDP websocket URL.`);
    }
    return {
      computerName: computer.name,
      url: metadata.webSocketDebuggerUrl,
      release() {},
    };
  }

  async openAudioStream(computer: PersistedBrowserComputer): Promise<BrowserAudioStreamLease> {
    return await Promise.reject(
      new UnsupportedComputerFeatureError(
        `Computer "${computer.name}" does not support audio streams.`,
      ),
    );
  }

  async openMonitorAttach(computer: PersistedBrowserComputer) {
    const spec = this.requireBrowserSpec(computer);
    return {
      computerName: computer.name,
      host: "127.0.0.1",
      port: spec.vncPort,
      release() {},
    };
  }

  async prepareBrowserRuntime(computer: PersistedBrowserComputer) {
    const spec = this.requireBrowserSpec(computer);
    await ensureAccess(spec.controlSocketPath, constants.W_OK).catch(() => undefined);
  }

  async restartBrowserComputer(computer: PersistedBrowserComputer) {
    const containerId = requireString(computer.runtime.containerId, "browser container id");
    await this.dockerClient.getContainer(containerId).restart();
    await waitForBrowserReady(this.requireBrowserSpec(computer));
    return (await this.getBrowserRuntimeState(computer)) ?? missingBrowserState(computer);
  }

  async restartContainerComputer(computer: PersistedContainerComputer) {
    const container = this.dockerClient.getContainer(computer.runtime.containerId);
    await container.restart();
    return await requireContainerRuntimeState(this.dockerClient, computer);
  }

  async startBrowserComputer(computer: PersistedBrowserComputer) {
    const containerId = requireString(computer.runtime.containerId, "browser container id");
    const container = this.dockerClient.getContainer(containerId);
    await container.start().catch((error: unknown) => {
      if (!looksLikeAlreadyStartedError(error)) {
        throw error;
      }
    });
    await waitForBrowserReady(this.requireBrowserSpec(computer));
    return (await this.getBrowserRuntimeState(computer)) ?? missingBrowserState(computer);
  }

  async startContainerComputer(computer: PersistedContainerComputer) {
    const container = this.dockerClient.getContainer(computer.runtime.containerId);
    await container.start().catch((error: unknown) => {
      if (!looksLikeAlreadyStartedError(error)) {
        throw error;
      }
    });
    return await requireContainerRuntimeState(this.dockerClient, computer);
  }

  async stopBrowserComputer(computer: PersistedBrowserComputer) {
    const containerId = requireString(computer.runtime.containerId, "browser container id");
    await this.dockerClient
      .getContainer(containerId)
      .stop()
      .catch((error: unknown) => {
        if (!looksLikeAlreadyStoppedError(error) && !isMissingContainerError(error)) {
          throw error;
        }
      });
    return (
      (await this.getBrowserRuntimeState(computer)) ?? {
        ...missingBrowserState(computer),
        activeState: "inactive",
        subState: "dead",
      }
    );
  }

  async stopContainerComputer(computer: PersistedContainerComputer) {
    const container = this.dockerClient.getContainer(computer.runtime.containerId);
    await container.stop().catch((error: unknown) => {
      if (!looksLikeAlreadyStoppedError(error) && !isMissingContainerError(error)) {
        throw error;
      }
    });
    return (
      (await this.getContainerRuntimeState(computer)) ?? {
        unitName: computer.unitName,
        description: computer.description,
        unitType: "container",
        loadState: "loaded",
        activeState: "inactive",
        subState: "dead",
        execStart: computer.runtime.command,
        workingDirectory: computer.runtime.workingDirectory,
        environment: computer.runtime.environment,
      }
    );
  }

  async updateBrowserViewport(computer: PersistedBrowserComputer, viewport: BrowserViewport) {
    const spec = this.requireBrowserSpec(computer);
    await requestControlJson<{ appliedViewport: BrowserViewport; restarted: boolean }>(
      spec.controlSocketPath,
      "POST",
      "/resize",
      viewport,
    );
  }

  private requireBrowserSpec(computer: PersistedBrowserComputer) {
    if (computer.runtime.provider !== "container") {
      throw new UnsupportedComputerFeatureError(
        `Computer "${computer.name}" does not use the browser container runtime.`,
      );
    }
    return this.browserRuntimePaths.specForComputer(computer);
  }

  private async removeContainer(containerId: string | undefined) {
    if (!containerId) {
      return;
    }
    const container = this.dockerClient.getContainer(containerId);
    await container.remove({ force: true, v: true });
  }
}

async function createContainerWithAutoPull(
  docker: Docker,
  image: string,
  options: Parameters<Docker["createContainer"]>[0],
) {
  try {
    return await docker.createContainer(options);
  } catch (error: unknown) {
    if (!isMissingImageError(error)) {
      throw error;
    }

    await pullImage(docker, image);
    return await docker.createContainer(options);
  }
}

function createBrowserRuntimeRecord(
  input: CreateBrowserComputerInput,
  unitName: string,
  networkId: string,
  runtime: PersistedBrowserComputer["runtime"],
): PersistedBrowserComputer {
  const timestamp = new Date().toISOString();
  return {
    name: input.name,
    unitName,
    description: input.description,
    createdAt: timestamp,
    lastActionAt: timestamp,
    profile: "browser",
    access: input.access ?? {
      display: {
        mode: "virtual-display",
      },
      logs: true,
    },
    resources: {
      cpuWeight: input.resources?.cpuWeight,
      memoryMaxMiB: input.resources?.memoryMaxMiB,
    },
    storage: input.storage ?? {
      rootMode: "persistent",
    },
    networkId,
    lifecycle: input.lifecycle ?? {},
    runtime,
  };
}

function defaultContainerCommand(input: CreateContainerComputerInput) {
  if (input.access?.console?.mode === "pty") {
    return "/bin/sh -i";
  }

  return input.runtime.command;
}

function resolveContainerCommand(input: CreateContainerComputerInput) {
  const command = input.runtime.command ?? defaultContainerCommand(input);
  if (!command) {
    return undefined;
  }

  if (command === "/bin/sh -i") {
    return ["/bin/sh", "-i"];
  }

  return ["/bin/sh", "-lc", command];
}

function toDockerEnvironment(environment: Record<string, string> | undefined) {
  if (!environment) {
    return undefined;
  }

  return Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
}

async function requireContainerRuntimeState(docker: Docker, computer: PersistedContainerComputer) {
  const inspection = await docker.getContainer(computer.runtime.containerId).inspect();
  return toContainerUnitRuntimeState(computer, inspection);
}

async function waitForBrowserReady(
  spec: ReturnType<ReturnType<typeof createBrowserRuntimePaths>["specForComputer"]>,
) {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await ensureAccess(spec.controlSocketPath, constants.R_OK | constants.W_OK);
      await requestControlJson(spec.controlSocketPath, "GET", "/health");
      await probeTcpPort(spec.vncPort);
      const metadata = await fetchJson<{ Browser?: string }>(
        `http://127.0.0.1:${spec.devtoolsPort}/json/version`,
      );
      if (metadata.Browser) {
        return;
      }
      lastError = new Error("CDP discovery payload was incomplete.");
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }

  throw new Error(
    `Browser container readiness probe failed for control socket "${spec.controlSocketPath}": ${String(lastError)}`,
  );
}

async function requestControlJson<T = unknown>(
  socketPath: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath,
        path,
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const payload = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(`control socket ${method} ${path} failed: ${response.statusCode}`));
            return;
          }
          try {
            resolve((payload.length === 0 ? {} : JSON.parse(payload)) as T);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    if (body !== undefined) {
      request.write(JSON.stringify(body));
    }
    request.end();
  });
}

async function probeTcpPort(port: number) {
  await new Promise<void>((resolve, reject) => {
    const socket = connectNet({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request to ${url} failed with ${response.status}.`);
  }
  return (await response.json()) as T;
}

async function pullImage(docker: Docker, image: string) {
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (error: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function toBrowserUnitRuntimeState(
  computer: PersistedBrowserComputer,
  inspection: Awaited<ReturnType<Docker.Container["inspect"]>>,
): UnitRuntimeState {
  return {
    unitName: computer.unitName,
    description: computer.description,
    unitType: "container",
    loadState: "loaded",
    activeState: inspection.State.Running ? "active" : "inactive",
    subState: inspection.State.Status ?? (inspection.State.Running ? "running" : "dead"),
    workingDirectory: inspection.Config.WorkingDir,
    environment: fromDockerEnvironment(inspection.Config.Env),
    execMainPid: inspection.State.Pid > 0 ? inspection.State.Pid : undefined,
    execMainStatus: inspection.State.ExitCode ?? undefined,
  };
}

function toContainerUnitRuntimeState(
  computer: PersistedContainerComputer,
  inspection: Awaited<ReturnType<Docker.Container["inspect"]>>,
): UnitRuntimeState {
  return {
    unitName: computer.unitName,
    description: computer.description,
    unitType: "container",
    loadState: "loaded",
    activeState: inspection.State.Running ? "active" : "inactive",
    subState: inspection.State.Status ?? (inspection.State.Running ? "running" : "dead"),
    execStart: computer.runtime.command,
    workingDirectory: inspection.Config.WorkingDir || computer.runtime.workingDirectory,
    environment: fromDockerEnvironment(inspection.Config.Env),
    execMainPid: inspection.State.Pid > 0 ? inspection.State.Pid : undefined,
    execMainStatus: inspection.State.ExitCode ?? undefined,
  };
}

function missingBrowserState(computer: PersistedBrowserComputer): UnitRuntimeState {
  return {
    unitName: computer.unitName,
    description: computer.description,
    unitType: "container",
    loadState: "loaded",
    activeState: "inactive",
    subState: "dead",
  };
}

function fromDockerEnvironment(environment: string[] | undefined) {
  if (!environment) {
    return undefined;
  }

  return Object.fromEntries(
    environment.map((entry) => {
      const [key, ...valueParts] = entry.split("=");
      return [key, valueParts.join("=")];
    }),
  );
}

function requireString(value: string | undefined, label: string) {
  if (!value) {
    throw new Error(`Missing ${label}.`);
  }
  return value;
}

async function ensureAccess(path: string, mode: number) {
  await access(path, mode);
}

function isMissingContainerError(error: unknown) {
  return error instanceof Error && /no such container/i.test(error.message);
}

function isMissingImageError(error: unknown) {
  return (
    error instanceof Error &&
    (/no such image/i.test(error.message) ||
      /not found: manifest unknown/i.test(error.message) ||
      /pull access denied/i.test(error.message))
  );
}

function looksLikeAlreadyStartedError(error: unknown) {
  return error instanceof Error && /container .* is already running/i.test(error.message);
}

function looksLikeAlreadyStoppedError(error: unknown) {
  return (
    error instanceof Error &&
    (/is not running/i.test(error.message) || /container .* is not running/i.test(error.message))
  );
}
