import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import Docker from "dockerode";
import { SystemNetworkProvider } from "./networks";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
  tempDirectories.length = 0;
});

test("rolls back config when network runtime provisioning fails", async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), "computerd-networks-test-"));
  tempDirectories.push(tempDirectory);
  const configPath = join(tempDirectory, "networks.json");
  const runtimeDirectory = join(tempDirectory, "runtime");

  class FailingSystemNetworkProvider extends SystemNetworkProvider {
    override async ensureNetworkRuntime() {
      throw new Error("dnsmasq unavailable");
    }
  }

  const docker = {
    createNetwork: async () => undefined,
    listNetworks: async () => [],
    getNetwork() {
      return {
        remove: async () => undefined,
      };
    },
  } as unknown as Docker;

  const provider = new FailingSystemNetworkProvider({
    configPath,
    docker,
    dockerSocketPath: "/var/run/docker.sock",
    environment: {},
    runtimeDirectory,
  });

  await expect(
    provider.createIsolatedNetwork({
      name: "isolated-lab",
      cidr: "192.168.252.0/24",
    }),
  ).rejects.toThrow(/dnsmasq unavailable/i);

  await expect(readFile(configPath, "utf8")).resolves.toBe('{\n  "networks": []\n}\n');
});

test("persists gateway runtime topology for isolated networks", async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), "computerd-networks-test-"));
  tempDirectories.push(tempDirectory);
  const configPath = join(tempDirectory, "networks.json");
  const runtimeDirectory = join(tempDirectory, "runtime");

  class RecordingSystemNetworkProvider extends SystemNetworkProvider {
    override async ensureNetworkRuntime() {}
  }

  const docker = {
    createNetwork: async () => undefined,
    listNetworks: async () => [],
    getNetwork() {
      return {
        remove: async () => undefined,
      };
    },
  } as unknown as Docker;

  const provider = new RecordingSystemNetworkProvider({
    configPath,
    docker,
    dockerSocketPath: "/var/run/docker.sock",
    environment: {},
    runtimeDirectory,
  });

  const created = await provider.createIsolatedNetwork({
    name: "isolated-lab",
    cidr: "192.168.252.0/24",
  });

  expect(created.kind).toBe("isolated");
  if (created.kind !== "isolated") {
    throw new TypeError("Expected an isolated network.");
  }
  expect(created.gatewayRuntime).toMatchObject({
    image: "alpine:3.20",
    insideAddress: "192.168.252.1",
    hostBridgeAddress: "192.168.252.254",
  });

  await expect(readFile(configPath, "utf8")).resolves.toContain('"gatewayRuntime"');
});
