import Docker from "dockerode";
import { afterEach, expect, test, vi } from "vitest";
import { createDockerRuntime } from "./runtime";

vi.mock("dockerode", () => {
  const DockerConstructor = vi.fn(
    class MockDocker {
      createContainer = vi.fn();
      getContainer = vi.fn();
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
  createDockerRuntime({
    socketPath: "/tmp/computerd-docker.sock",
  });

  expect(Docker).toHaveBeenCalledWith({
    socketPath: "/tmp/computerd-docker.sock",
  });
});
