import {
  createBrowserRuntimeSchema,
  computerAccessSchema,
  computerLifecycleSchema,
  computerNetworkSchema,
  computerProfileSchema,
  computerResourcesSchema,
  computerStorageSchema,
  parseCreateComputerInput,
} from "@computerd/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ControlPlane } from "@computerd/control-plane";

export interface ComputerdMcpContext {
  createAutomationSession: ControlPlane["createAutomationSession"];
  createComputer: ControlPlane["createComputer"];
  createMonitorSession: ControlPlane["createMonitorSession"];
  createScreenshot: ControlPlane["createScreenshot"];
  deleteComputer: ControlPlane["deleteComputer"];
  getComputer: ControlPlane["getComputer"];
  listComputers: ControlPlane["listComputers"];
  listHostUnits: ControlPlane["listHostUnits"];
  getHostUnit: ControlPlane["getHostUnit"];
  restartComputer: ControlPlane["restartComputer"];
  startComputer: ControlPlane["startComputer"];
  stopComputer: ControlPlane["stopComputer"];
  updateBrowserViewport: ControlPlane["updateBrowserViewport"];
}

export function createComputerdMcpServer(context: ComputerdMcpContext) {
  const server = new McpServer({
    name: "computerd-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "list_computers",
    {
      description: "List managed computers available through computerd.",
    },
    async () => createJsonToolResult(await context.listComputers()),
  );

  server.registerTool(
    "get_computer",
    {
      description: "Inspect one managed computer by name.",
      inputSchema: {
        name: z.string().min(1),
      },
    },
    async ({ name }) => createJsonToolResult(await context.getComputer(name)),
  );

  server.registerTool(
    "create_computer",
    {
      description: "Create a managed computer using computerd's structured schema.",
      inputSchema: {
        name: z.string().min(1),
        description: z.string().optional(),
        profile: computerProfileSchema,
        access: computerAccessSchema.optional(),
        resources: computerResourcesSchema.optional(),
        storage: computerStorageSchema.optional(),
        network: computerNetworkSchema.optional(),
        lifecycle: computerLifecycleSchema.optional(),
        runtime: z.object({
          command: z.string().min(1).optional(),
          workingDirectory: z.string().optional(),
          environment: z.record(z.string(), z.string()).optional(),
          provider: z.literal("docker").optional(),
          image: z.string().optional(),
          browser: createBrowserRuntimeSchema.shape.browser.optional(),
          persistentProfile: z.boolean().optional(),
          viewport: createBrowserRuntimeSchema.shape.viewport.optional(),
        }),
      },
    },
    async (input) =>
      createJsonToolResult(await context.createComputer(parseCreateComputerInput(input))),
  );

  server.registerTool(
    "create_browser_monitor_session",
    {
      description: "Create a browser monitor session for a managed computer.",
      inputSchema: {
        name: z.string().min(1),
      },
    },
    async ({ name }) => createJsonToolResult(await context.createMonitorSession(name)),
  );

  server.registerTool(
    "create_browser_automation_session",
    {
      description: "Create a browser automation session that returns a CDP websocket endpoint.",
      inputSchema: {
        name: z.string().min(1),
      },
    },
    async ({ name }) => createJsonToolResult(await context.createAutomationSession(name)),
  );

  server.registerTool(
    "capture_browser_screenshot",
    {
      description: "Capture a fullscreen PNG screenshot from a running browser computer.",
      inputSchema: {
        name: z.string().min(1),
      },
    },
    async ({ name }) => createJsonToolResult(await context.createScreenshot(name)),
  );

  server.registerTool(
    "set_browser_viewport",
    {
      description:
        "Update a browser computer viewport and apply it to the running virtual display.",
      inputSchema: {
        name: z.string().min(1),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      },
    },
    async ({ name, width, height }) =>
      createJsonToolResult(await context.updateBrowserViewport(name, { width, height })),
  );

  server.registerTool(
    "start_computer",
    {
      description: "Start a managed computer.",
      inputSchema: {
        name: z.string().min(1),
      },
    },
    async ({ name }) => createJsonToolResult(await context.startComputer(name)),
  );

  server.registerTool(
    "delete_computer",
    {
      description: "Delete a managed computer and its persistent unit.",
      inputSchema: {
        name: z.string().min(1),
      },
    },
    async ({ name }) => createJsonToolResult(await context.deleteComputer(name)),
  );

  server.registerTool(
    "stop_computer",
    {
      description: "Stop a managed computer.",
      inputSchema: {
        name: z.string().min(1),
      },
    },
    async ({ name }) => createJsonToolResult(await context.stopComputer(name)),
  );

  server.registerTool(
    "restart_computer",
    {
      description: "Restart a managed computer.",
      inputSchema: {
        name: z.string().min(1),
      },
    },
    async ({ name }) => createJsonToolResult(await context.restartComputer(name)),
  );

  server.registerTool(
    "list_host_units",
    {
      description: "List lightweight host inspect units visible to computerd.",
    },
    async () => createJsonToolResult(await context.listHostUnits()),
  );

  server.registerTool(
    "get_host_unit",
    {
      description: "Inspect one host unit by unit name.",
      inputSchema: {
        unitName: z.string().min(1),
      },
    },
    async ({ unitName }) => createJsonToolResult(await context.getHostUnit(unitName)),
  );

  return server;
}

function createJsonToolResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload ?? null, null, 2),
      },
    ],
  };
}
