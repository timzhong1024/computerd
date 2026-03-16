import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import Docker from "dockerode";
import { DevelopmentNetworkProvider, SystemNetworkProvider } from "./networks";

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
    configVersion: 1,
    image: "computerd/gateway-runtime:latest",
    insideAddress: "192.168.252.1",
  });
  expect(created.gatewayRuntime).not.toHaveProperty("hostBridgeAddress");
  expect(created.gatewayRuntime).not.toHaveProperty("routingMark");
  expect(created.gatewayRuntime).not.toHaveProperty("routingTable");

  await expect(readFile(configPath, "utf8")).resolves.toContain('"gatewayRuntime"');
});

test("network detail exposes managed gateway runtime diagnostics", async () => {
  const provider = new DevelopmentNetworkProvider(
    new Map([
      [
        "network-isolated",
        {
          id: "network-isolated",
          name: "isolated-lab",
          kind: "isolated" as const,
          cidr: "192.168.252.0/24",
          bridgeName: "ctd12345678",
          dockerNetworkName: "computerd-network-isolated",
          createdAt: new Date().toISOString(),
          gateway: {
            dhcp: { provider: "dnsmasq" as const },
            dns: { provider: "dnsmasq" as const },
            programmableGateway: { provider: null },
          },
          gatewayRuntime: {
            configVersion: 1,
            image: "computerd/gateway-runtime:latest",
            containerName: "computerd-gateway-network-isolated",
            insideAddress: "192.168.252.1",
            transitCidr: "100.64.2.0/30",
            transitHostAddress: "100.64.2.1",
            transitGatewayAddress: "100.64.2.2",
            hostVethName: "ctgw12345678",
            gatewayVethName: "gw12345678",
          },
        },
      ],
    ]),
  );

  const detail = await provider.toNetworkDetail(
    await provider.getNetworkRecord("network-isolated"),
    0,
  );
  expect(detail.kind).toBe("isolated");
  if (detail.kind !== "isolated") {
    throw new TypeError("Expected an isolated network detail.");
  }
  const runtimeGateway = detail.gateway as typeof detail.gateway & {
    runtime: {
      mode: "managed-container";
      containerState: "running" | "stopped" | "missing";
      configVersion: number;
    };
  };

  expect(runtimeGateway.runtime).toEqual({
    mode: "managed-container",
    containerState: "running",
    configVersion: 1,
  });
});
