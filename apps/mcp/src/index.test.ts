import type {
  ComputerDetail,
  ComputerSummary,
  HostUnitDetail,
  HostUnitSummary,
} from "@computerd/core";
import type { BaseControlPlane } from "@computerd/control-plane";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, test, vi } from "vitest";
import { createComputerdMcpServer } from "./index";

const connectedClients = new Set<Client>();
const connectedServers = new Set<ReturnType<typeof createComputerdMcpServer>>();

function createComputerDetail(name = "lab-host"): ComputerDetail {
  return {
    name,
    unitName: `computerd-${name}.service`,
    profile: "host",
    state: "running",
    createdAt: "2026-03-09T08:00:00.000Z",
    access: {
      console: {
        mode: "pty",
        writable: true,
      },
      logs: true,
    },
    capabilities: {
      canInspect: true,
      canStart: false,
      canStop: true,
      canRestart: true,
      consoleAvailable: true,
      browserAvailable: false,
      automationAvailable: false,
      screenshotAvailable: false,
      audioAvailable: false,
    },
    resources: {},
    storage: {
      rootMode: "persistent",
    },
    network: {
      id: "network-host",
      name: "Host network",
      kind: "host",
      cidr: "192.168.250.0/24",
      status: {
        state: "healthy",
        bridgeName: "br0",
      },
      gateway: {
        dhcp: { provider: "dnsmasq", state: "unsupported" },
        dns: { provider: "dnsmasq", state: "unsupported" },
        programmableGateway: { provider: null, state: "unsupported" },
        health: { state: "healthy", natState: "unsupported" },
      },
      attachedComputerCount: 1,
      deletable: false,
    },
    lifecycle: {},
    status: {
      lastActionAt: "2026-03-09T08:00:00.000Z",
      primaryUnit: `computerd-${name}.service`,
    },
    runtime: {
      command: "/usr/bin/bash",
    },
  };
}

function createHostUnitDetail(unitName = "docker.service"): HostUnitDetail {
  return {
    unitName,
    unitType: "service",
    state: "active",
    description: "Docker Engine",
    capabilities: {
      canInspect: true,
    },
    execStart: "/usr/bin/dockerd",
    status: {
      activeState: "active",
      subState: "running",
      loadState: "loaded",
    },
    recentLogs: ["dockerd started"],
  };
}

afterEach(async () => {
  await Promise.all([...connectedClients].map((client) => client.close()));
  await Promise.all([...connectedServers].map((server) => server.close()));
  connectedClients.clear();
  connectedServers.clear();
});

test("registers computer and host inspect tools", async () => {
  const server = createComputerdMcpServer(
    createMockControlPlane({
      deleteContainerImage: vi.fn().mockResolvedValue(undefined),
      deleteVmImage: vi.fn().mockResolvedValue(undefined),
      createAutomationSession: vi.fn().mockResolvedValue({
        computerName: "research-browser",
        protocol: "cdp",
        connect: {
          mode: "relative-websocket-path",
          url: "/api/computers/research-browser/automation/ws",
        },
        authorization: { mode: "none" },
      }),
      listComputers: vi.fn().mockResolvedValue([] as ComputerSummary[]),
      createMonitorSession: vi.fn().mockResolvedValue({
        computerName: "research-browser",
        protocol: "vnc",
        connect: {
          mode: "relative-websocket-path",
          url: "/api/computers/research-browser/monitor/ws",
        },
        authorization: { mode: "none" },
      }),
      createScreenshot: vi.fn().mockResolvedValue({
        computerName: "research-browser",
        format: "png",
        mimeType: "image/png",
        capturedAt: "2026-03-09T08:00:00.000Z",
        width: 1440,
        height: 900,
        dataBase64: "c2NyZWVu",
      }),
      getComputer: vi.fn().mockResolvedValue(createComputerDetail()),
      getNetwork: vi.fn().mockResolvedValue({
        id: "network-host",
        name: "Host network",
        kind: "host",
        cidr: "192.168.250.0/24",
        status: {
          state: "healthy",
          bridgeName: "br0",
        },
        gateway: {
          dhcp: { provider: "dnsmasq", state: "unsupported" },
          dns: { provider: "dnsmasq", state: "unsupported" },
          programmableGateway: { provider: null, state: "unsupported" },
          health: { state: "healthy", natState: "unsupported" },
        },
        attachedComputerCount: 1,
        deletable: false,
      }),
      getImage: vi.fn().mockResolvedValue({
        id: "filesystem-vm:dev-qcow2",
        kind: "qcow2",
        provider: "filesystem-vm",
        name: "ubuntu-cloud.qcow2",
        status: "available",
        path: "/images/ubuntu-cloud.qcow2",
        sizeBytes: 123,
        sourceType: "managed-import",
      }),
      createComputer: vi.fn().mockResolvedValue(createComputerDetail()),
      createNetwork: vi.fn().mockResolvedValue({
        id: "network-isolated-dev",
        name: "isolated-dev",
        kind: "isolated",
        cidr: "192.168.252.0/24",
        status: {
          state: "healthy",
          bridgeName: "ctddeadbeef",
        },
        gateway: {
          dhcp: { provider: "dnsmasq", state: "healthy" },
          dns: { provider: "dnsmasq", state: "healthy" },
          programmableGateway: { provider: null, state: "unsupported" },
          health: { state: "healthy", natState: "healthy" },
        },
        attachedComputerCount: 0,
        deletable: true,
      }),
      deleteComputer: vi.fn().mockResolvedValue(undefined),
      deleteNetwork: vi.fn().mockResolvedValue(undefined),
      listImages: vi.fn().mockResolvedValue([]),
      listNetworks: vi.fn().mockResolvedValue([]),
      importVmImage: vi.fn().mockResolvedValue({
        id: "filesystem-vm:imported",
        kind: "qcow2",
        provider: "filesystem-vm",
        name: "imported.qcow2",
        status: "available",
        path: "/var/lib/computerd/images/vm/imported.qcow2",
        sizeBytes: 123,
        sourceType: "managed-import",
      }),
      pullContainerImage: vi.fn().mockResolvedValue({
        id: "docker:sha256:ubuntu",
        kind: "container",
        provider: "docker",
        name: "ubuntu:24.04",
        status: "available",
        reference: "ubuntu:24.04",
        imageId: "sha256:ubuntu",
        repoTags: ["ubuntu:24.04"],
        sizeBytes: 123,
      }),
      startComputer: vi.fn().mockResolvedValue(createComputerDetail()),
      stopComputer: vi.fn().mockResolvedValue(createComputerDetail()),
      restartComputer: vi.fn().mockResolvedValue(createComputerDetail()),
      updateBrowserViewport: vi.fn().mockResolvedValue(createComputerDetail("research-browser")),
      listHostUnits: vi.fn().mockResolvedValue([] as HostUnitSummary[]),
      getHostUnit: vi.fn().mockResolvedValue(createHostUnitDetail()),
    }),
  );
  const client = new Client({
    name: "computerd-mcp-test-client",
    version: "0.1.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  connectedServers.add(server);
  connectedClients.add(client);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const result = await client.listTools();
  const toolNames = result.tools.map((tool) => tool.name).sort();

  expect(toolNames).toEqual([
    "capture_browser_screenshot",
    "create_browser_automation_session",
    "create_browser_monitor_session",
    "create_computer",
    "create_network",
    "delete_computer",
    "delete_container_image",
    "delete_network",
    "delete_vm_image",
    "get_computer",
    "get_host_unit",
    "get_image",
    "get_network",
    "import_vm_image",
    "list_computers",
    "list_host_units",
    "list_images",
    "list_networks",
    "pull_container_image",
    "restart_computer",
    "set_browser_viewport",
    "start_computer",
    "stop_computer",
  ]);
});

test("invokes handlers and returns JSON payloads", async () => {
  const getComputer = vi.fn().mockResolvedValue(createComputerDetail());
  const server = createComputerdMcpServer(
    createMockControlPlane({
      deleteContainerImage: vi.fn().mockResolvedValue(undefined),
      deleteVmImage: vi.fn().mockResolvedValue(undefined),
      createAutomationSession: vi.fn(),
      listComputers: vi.fn().mockResolvedValue([] as ComputerSummary[]),
      createMonitorSession: vi.fn(),
      createScreenshot: vi.fn(),
      getComputer,
      getNetwork: vi.fn(),
      getImage: vi.fn().mockResolvedValue({
        id: "filesystem-vm:dev-qcow2",
        kind: "qcow2",
        provider: "filesystem-vm",
        name: "ubuntu-cloud.qcow2",
        status: "available",
        path: "/images/ubuntu-cloud.qcow2",
        sizeBytes: 123,
        sourceType: "managed-import",
      }),
      createComputer: vi.fn().mockResolvedValue(createComputerDetail()),
      createNetwork: vi.fn(),
      deleteComputer: vi.fn().mockResolvedValue(undefined),
      deleteNetwork: vi.fn(),
      listImages: vi.fn().mockResolvedValue([]),
      listNetworks: vi.fn().mockResolvedValue([]),
      importVmImage: vi.fn().mockResolvedValue({
        id: "filesystem-vm:imported",
        kind: "qcow2",
        provider: "filesystem-vm",
        name: "imported.qcow2",
        status: "available",
        path: "/var/lib/computerd/images/vm/imported.qcow2",
        sizeBytes: 123,
        sourceType: "managed-import",
      }),
      pullContainerImage: vi.fn().mockResolvedValue({
        id: "docker:sha256:ubuntu",
        kind: "container",
        provider: "docker",
        name: "ubuntu:24.04",
        status: "available",
        reference: "ubuntu:24.04",
        imageId: "sha256:ubuntu",
        repoTags: ["ubuntu:24.04"],
        sizeBytes: 123,
      }),
      startComputer: vi.fn().mockResolvedValue(createComputerDetail()),
      stopComputer: vi.fn().mockResolvedValue(createComputerDetail()),
      restartComputer: vi.fn().mockResolvedValue(createComputerDetail()),
      updateBrowserViewport: vi.fn().mockResolvedValue(createComputerDetail("research-browser")),
      listHostUnits: vi.fn().mockResolvedValue([] as HostUnitSummary[]),
      getHostUnit: vi.fn().mockResolvedValue(createHostUnitDetail()),
    }),
  );
  const client = new Client({
    name: "computerd-mcp-test-client",
    version: "0.1.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  connectedServers.add(server);
  connectedClients.add(client);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const result = await client.callTool({
    name: "get_computer",
    arguments: {
      name: "lab-host",
    },
  });
  const content = result.content as Array<{ type: string; text?: string }>;

  expect(getComputer).toHaveBeenCalledWith("lab-host");
  expect(result.isError).not.toBe(true);
  if (content[0]?.type !== "text" || typeof content[0].text !== "string") {
    throw new TypeError("Expected a text MCP response");
  }

  await expect(JSON.parse(content[0].text)).toMatchObject({
    name: "lab-host",
  });
});

function createMockControlPlane(methods: Record<string, unknown>) {
  return methods as unknown as BaseControlPlane;
}
