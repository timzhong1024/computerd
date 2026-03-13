import Docker from "dockerode";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_HOST_NETWORK_ID } from "../networks";
import { DefaultDockerRuntime } from "./runtime";

vi.mock("dockerode", () => {
  const DockerConstructor = vi.fn(
    class MockDocker {
      createContainer = vi.fn();
      getContainer = vi.fn();
      pull = vi.fn();
      modem = {
        followProgress: vi.fn((_stream, onFinished) => onFinished(null)),
      };
    },
  );

  return {
    default: DockerConstructor,
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

test("uses the configured docker socket path when creating a client", () => {
  new DefaultDockerRuntime(new Docker({ socketPath: "/tmp/computerd-docker.sock" }));

  expect(Docker).toHaveBeenCalledWith({
    socketPath: "/tmp/computerd-docker.sock",
  });
});

test("pulls missing images before retrying container creation", async () => {
  const runtime = new DefaultDockerRuntime(new Docker({ socketPath: "/var/run/docker.sock" }));
  const dockerClient = vi.mocked(Docker).mock.instances[0] as unknown as {
    createContainer: ReturnType<typeof vi.fn>;
    pull: ReturnType<typeof vi.fn>;
    modem: {
      followProgress: ReturnType<typeof vi.fn>;
    };
  };

  dockerClient.createContainer
    .mockRejectedValueOnce(new Error("No such image: ubuntu:24.04"))
    .mockResolvedValueOnce({ id: "container-123" });
  dockerClient.pull.mockResolvedValueOnce({ stream: true });

  const created = await runtime.createContainerComputer(
    {
      name: "workspace-container",
      profile: "container",
      access: {
        console: {
          mode: "pty",
          writable: true,
        },
        logs: true,
      },
      runtime: {
        provider: "docker",
        image: "ubuntu:24.04",
      },
    },
    "computerd-workspace-container.service",
    {
      id: DEFAULT_HOST_NETWORK_ID,
      name: "Host network",
      kind: "host",
      cidr: "192.168.250.0/24",
      bridgeName: "br0",
    },
  );

  expect(dockerClient.pull).toHaveBeenCalledWith("ubuntu:24.04");
  expect(dockerClient.modem.followProgress).toHaveBeenCalled();
  expect(dockerClient.createContainer).toHaveBeenCalledTimes(2);
  expect(created).toMatchObject({
    image: "ubuntu:24.04",
    containerId: "container-123",
    containerName: "computerd-workspace-container",
    command: "/bin/sh -i",
  });
});
