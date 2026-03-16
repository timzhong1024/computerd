import {
  createBrowserRuntimeSchema,
  computerAccessSchema,
  computerLifecycleSchema,
  computerProfileSchema,
  computerResourcesSchema,
  computerStorageSchema,
  createNetworkInputSchema,
  displayActionSchema,
  parseImportVmImageInput,
  parsePullContainerImageInput,
  parseCreateComputerInput,
  runDisplayActionsObserveSchema,
} from "@computerd/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BaseControlPlane } from "@computerd/control-plane";

export function createComputerdMcpServer(controlPlane: BaseControlPlane) {
  const server = new McpServer({
    name: "computerd-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "list_networks",
    {
      description: "List computerd networks and their health.",
    },
    async () => createJsonToolResult(await controlPlane.listNetworks()),
  );

  server.registerTool(
    "get_network",
    {
      description: "Inspect one computerd network by id.",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => createJsonToolResult(await controlPlane.getNetwork(id)),
  );

  server.registerTool(
    "create_network",
    {
      description: "Create a new isolated computerd network.",
      inputSchema: {
        name: createNetworkInputSchema.shape.name,
        cidr: createNetworkInputSchema.shape.cidr,
        gateway: createNetworkInputSchema.shape.gateway,
      },
    },
    async (input) => createJsonToolResult(await controlPlane.createNetwork(input)),
  );

  server.registerTool(
    "delete_network",
    {
      description: "Delete an empty computerd network.",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => createJsonToolResult(await controlPlane.deleteNetwork(id)),
  );

  server.registerTool(
    "list_images",
    {
      description: "List VM and container images visible to computerd.",
    },
    async () => createJsonToolResult(await controlPlane.imageProvider.listImages()),
  );

  server.registerTool(
    "get_image",
    {
      description: "Inspect one image by id.",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => createJsonToolResult(await controlPlane.imageProvider.getImage(id)),
  );

  server.registerTool(
    "import_vm_image",
    {
      description: "Import a VM image from a local file path or http/https URL into computerd.",
      inputSchema: {
        source: z.discriminatedUnion("type", [
          z.object({
            type: z.literal("file"),
            path: z.string().min(1),
          }),
          z.object({
            type: z.literal("url"),
            url: z.string().min(1),
          }),
        ]),
      },
    },
    async (input) =>
      createJsonToolResult(
        await controlPlane.imageProvider.importVmImage(parseImportVmImageInput(input)),
      ),
  );

  server.registerTool(
    "delete_vm_image",
    {
      description: "Delete a computerd-managed VM image by image inventory id.",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => createJsonToolResult(await controlPlane.imageProvider.deleteVmImage(id)),
  );

  server.registerTool(
    "pull_container_image",
    {
      description: "Pull a container image into the Docker image store.",
      inputSchema: {
        reference: z.string().min(1),
      },
    },
    async ({ reference }) =>
      createJsonToolResult(
        await controlPlane.imageProvider.pullContainerImage(
          parsePullContainerImageInput({ reference }).reference,
        ),
      ),
  );

  server.registerTool(
    "delete_container_image",
    {
      description: "Delete a container image by image inventory id.",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) =>
      createJsonToolResult(await controlPlane.imageProvider.deleteContainerImage(id)),
  );

  server.registerTool(
    "list_computers",
    {
      description: "List managed computers available through computerd.",
    },
    async () => createJsonToolResult(await controlPlane.listComputers()),
  );

  server.registerTool(
    "get_computer",
    {
      description: "Inspect one managed computer by name.",
      inputSchema: {
        name: z.string().min(1),
      },
    },
    async ({ name }) => createJsonToolResult(await controlPlane.getComputer(name)),
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
        networkId: z.string().min(1).optional(),
        lifecycle: computerLifecycleSchema.optional(),
        runtime: z.object({
          command: z.string().min(1).optional(),
          workingDirectory: z.string().optional(),
          environment: z.record(z.string(), z.string()).optional(),
          provider: z.literal("docker").optional(),
          image: z.string().optional(),
          imageId: z.string().optional(),
          sourceKind: z.enum(["qcow2", "iso"]).optional(),
          diskSizeGiB: z.number().int().positive().optional(),
          nics: z
            .array(
              z.object({
                name: z.string().min(1),
                macAddress: z.string().optional(),
                ipv4: z
                  .object({
                    type: z.enum(["disabled", "dhcp", "static"]),
                    address: z.string().optional(),
                    prefixLength: z.number().int().positive().optional(),
                  })
                  .optional(),
                ipv6: z
                  .object({
                    type: z.enum(["disabled", "dhcp", "slaac", "static"]),
                    address: z.string().optional(),
                    prefixLength: z.number().int().positive().optional(),
                  })
                  .optional(),
              }),
            )
            .optional(),
          hypervisor: z.literal("qemu").optional(),
          cloudInit: z
            .object({
              enabled: z.boolean().optional(),
              user: z.string().min(1).optional(),
              password: z.string().optional(),
              sshAuthorizedKeys: z.array(z.string().min(1)).optional(),
            })
            .optional(),
          browser: createBrowserRuntimeSchema.shape.browser.optional(),
          persistentProfile: z.boolean().optional(),
          viewport: createBrowserRuntimeSchema.shape.viewport.optional(),
        }),
      },
    },
    async (input) =>
      createJsonToolResult(await controlPlane.createComputer(parseCreateComputerInput(input))),
  );

  server.registerTool(
    "create_browser_monitor_session",
    {
      description: "Create a browser monitor session for a managed computer.",
      inputSchema: {
        name: z.string().min(1),
      },
    },
    async ({ name }) => createJsonToolResult(await controlPlane.createMonitorSession(name)),
  );

  server.registerTool(
    "create_browser_automation_session",
    {
      description: "Create a browser automation session that returns a CDP websocket endpoint.",
      inputSchema: {
        name: z.string().min(1),
      },
    },
    async ({ name }) => createJsonToolResult(await controlPlane.createAutomationSession(name)),
  );

  server.registerTool(
    "capture_browser_screenshot",
    {
      description: "Capture a fullscreen PNG screenshot from a running browser computer.",
      inputSchema: {
        name: z.string().min(1),
      },
    },
    async ({ name }) => createJsonToolResult(await controlPlane.createScreenshot(name)),
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
      createJsonToolResult(await controlPlane.updateBrowserViewport(name, { width, height })),
  );

  server.registerTool(
    "run_display_actions",
    {
      description:
        "Execute a batch of generic display actions against a browser or VM computer and optionally return a final screenshot.",
      inputSchema: {
        name: z.string().min(1),
        ops: z.array(displayActionSchema).min(1),
        observe: runDisplayActionsObserveSchema.optional(),
      },
    },
    async ({ name, ops, observe }) =>
      createJsonToolResult(
        await controlPlane.runDisplayActions(name, {
          ops,
          observe: observe ?? { screenshot: true },
        }),
      ),
  );

  server.registerTool(
    "start_computer",
    {
      description: "Start a managed computer.",
      inputSchema: {
        name: z.string().min(1),
      },
    },
    async ({ name }) => createJsonToolResult(await controlPlane.startComputer(name)),
  );

  server.registerTool(
    "delete_computer",
    {
      description: "Delete a managed computer and its persistent unit.",
      inputSchema: {
        name: z.string().min(1),
      },
    },
    async ({ name }) => createJsonToolResult(await controlPlane.deleteComputer(name)),
  );

  server.registerTool(
    "stop_computer",
    {
      description: "Stop a managed computer.",
      inputSchema: {
        name: z.string().min(1),
      },
    },
    async ({ name }) => createJsonToolResult(await controlPlane.stopComputer(name)),
  );

  server.registerTool(
    "restart_computer",
    {
      description: "Restart a managed computer.",
      inputSchema: {
        name: z.string().min(1),
      },
    },
    async ({ name }) => createJsonToolResult(await controlPlane.restartComputer(name)),
  );

  server.registerTool(
    "list_host_units",
    {
      description: "List lightweight host inspect units visible to computerd.",
    },
    async () => createJsonToolResult(await controlPlane.listHostUnits()),
  );

  server.registerTool(
    "get_host_unit",
    {
      description: "Inspect one host unit by unit name.",
      inputSchema: {
        unitName: z.string().min(1),
      },
    },
    async ({ unitName }) => createJsonToolResult(await controlPlane.getHostUnit(unitName)),
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
