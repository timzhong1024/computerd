import Docker from "dockerode";
import type {
  CreateContainerComputerInput,
  PersistedContainerComputer,
  UnitRuntimeState,
} from "../systemd/types";

export interface CreateDockerRuntimeOptions {
  docker?: Docker;
  socketPath?: string;
}

export interface DockerRuntime {
  createContainerComputer: (
    input: CreateContainerComputerInput,
    unitName: string,
  ) => Promise<PersistedContainerComputer["runtime"]>;
  deleteContainerComputer: (computer: PersistedContainerComputer) => Promise<void>;
  getContainerRuntimeState: (
    computer: PersistedContainerComputer,
  ) => Promise<UnitRuntimeState | null>;
  restartContainerComputer: (computer: PersistedContainerComputer) => Promise<UnitRuntimeState>;
  startContainerComputer: (computer: PersistedContainerComputer) => Promise<UnitRuntimeState>;
  stopContainerComputer: (computer: PersistedContainerComputer) => Promise<UnitRuntimeState>;
}

export function createDockerRuntime({
  docker,
  socketPath = "/var/run/docker.sock",
}: CreateDockerRuntimeOptions = {}): DockerRuntime {
  const dockerClient = docker ?? new Docker({ socketPath });

  return {
    async createContainerComputer(input, unitName) {
      const containerName = unitName.replace(/\.service$/, "");
      const command = resolveContainerCommand(input);
      const container = await dockerClient.createContainer({
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
        },
      });

      return {
        ...input.runtime,
        command: input.runtime.command ?? defaultContainerCommand(input),
        containerId: container.id,
        containerName,
      };
    },
    async deleteContainerComputer(computer) {
      const container = dockerClient.getContainer(computer.runtime.containerId);
      await container.remove({ force: true, v: true });
    },
    async getContainerRuntimeState(computer) {
      try {
        const inspection = await dockerClient.getContainer(computer.runtime.containerId).inspect();
        return toUnitRuntimeState(computer, inspection);
      } catch (error: unknown) {
        if (isMissingContainerError(error)) {
          return null;
        }

        throw error;
      }
    },
    async restartContainerComputer(computer) {
      const container = dockerClient.getContainer(computer.runtime.containerId);
      await container.restart();
      return await requireContainerRuntimeState(dockerClient, computer);
    },
    async startContainerComputer(computer) {
      const container = dockerClient.getContainer(computer.runtime.containerId);
      await container.start().catch((error: unknown) => {
        if (!looksLikeAlreadyStartedError(error)) {
          throw error;
        }
      });
      return await requireContainerRuntimeState(dockerClient, computer);
    },
    async stopContainerComputer(computer) {
      const container = dockerClient.getContainer(computer.runtime.containerId);
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
    },
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
  return toUnitRuntimeState(computer, inspection);
}

function toUnitRuntimeState(
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

function isMissingContainerError(error: unknown) {
  return error instanceof Error && /no such container/i.test(error.message);
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
