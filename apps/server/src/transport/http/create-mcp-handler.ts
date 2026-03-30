import type { IncomingMessage, ServerResponse } from "node:http";
import type { BaseControlPlane } from "@computerd/control-plane";
import { createComputerdMcpServer } from "@computerd/mcp";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export function createMcpHandler(controlPlane: BaseControlPlane) {
  return async function handleMcpRequest(request: IncomingMessage, response: ServerResponse) {
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Method not allowed.",
          },
          id: null,
        }),
      );
      return true;
    }

    const server = createComputerdMcpServer(controlPlane);

    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      await server.connect(transport);
      await transport.handleRequest(request, response);
      response.on("close", () => {
        void transport.close();
        void server.close();
      });
      return true;
    } catch (error: unknown) {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : "Internal server error",
            },
            id: null,
          }),
        );
      }

      await server.close();
      return true;
    }
  };
}
