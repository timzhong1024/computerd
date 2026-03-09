import type {
  ComputerDetail,
  ComputerSummary,
  HostUnitDetail,
  HostUnitSummary,
} from "@computerd/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, test, vi } from "vitest";
import { createComputerdMcpServer } from "./index";

const connectedClients = new Set<Client>();
const connectedServers = new Set<ReturnType<typeof createComputerdMcpServer>>();

function createComputerDetail(name = "lab-terminal"): ComputerDetail {
  return {
    name,
    unitName: `computerd-${name}.service`,
    profile: "terminal",
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
    },
    resources: {},
    storage: {
      rootMode: "persistent",
    },
    network: {
      mode: "host",
    },
    lifecycle: {},
    status: {
      lastActionAt: "2026-03-09T08:00:00.000Z",
      primaryUnit: `computerd-${name}.service`,
    },
    runtime: {
      execStart: "/usr/bin/bash",
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
  const server = createComputerdMcpServer({
    listComputers: vi.fn().mockResolvedValue([] as ComputerSummary[]),
    getComputer: vi.fn().mockResolvedValue(createComputerDetail()),
    createComputer: vi.fn().mockResolvedValue(createComputerDetail()),
    deleteComputer: vi.fn().mockResolvedValue(undefined),
    startComputer: vi.fn().mockResolvedValue(createComputerDetail()),
    stopComputer: vi.fn().mockResolvedValue(createComputerDetail()),
    restartComputer: vi.fn().mockResolvedValue(createComputerDetail()),
    listHostUnits: vi.fn().mockResolvedValue([] as HostUnitSummary[]),
    getHostUnit: vi.fn().mockResolvedValue(createHostUnitDetail()),
  });
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
    "create_computer",
    "delete_computer",
    "get_computer",
    "get_host_unit",
    "list_computers",
    "list_host_units",
    "restart_computer",
    "start_computer",
    "stop_computer",
  ]);
});

test("invokes handlers and returns JSON payloads", async () => {
  const getComputer = vi.fn().mockResolvedValue(createComputerDetail());
  const server = createComputerdMcpServer({
    listComputers: vi.fn().mockResolvedValue([] as ComputerSummary[]),
    getComputer,
    createComputer: vi.fn().mockResolvedValue(createComputerDetail()),
    deleteComputer: vi.fn().mockResolvedValue(undefined),
    startComputer: vi.fn().mockResolvedValue(createComputerDetail()),
    stopComputer: vi.fn().mockResolvedValue(createComputerDetail()),
    restartComputer: vi.fn().mockResolvedValue(createComputerDetail()),
    listHostUnits: vi.fn().mockResolvedValue([] as HostUnitSummary[]),
    getHostUnit: vi.fn().mockResolvedValue(createHostUnitDetail()),
  });
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
      name: "lab-terminal",
    },
  });
  const content = result.content as Array<{ type: string; text?: string }>;

  expect(getComputer).toHaveBeenCalledWith("lab-terminal");
  expect(result.isError).not.toBe(true);
  if (content[0]?.type !== "text" || typeof content[0].text !== "string") {
    throw new TypeError("Expected a text MCP response");
  }

  await expect(JSON.parse(content[0].text)).toMatchObject({
    name: "lab-terminal",
  });
});
