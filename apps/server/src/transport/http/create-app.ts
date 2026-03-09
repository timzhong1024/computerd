import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { ZodError } from "zod";
import {
  parseComputerDetail,
  parseComputerSummaries,
  parseCreateComputerInput,
  parseHostUnitDetail,
  parseHostUnitSummaries,
  type ComputerDetail,
  type ComputerSummary,
  type CreateComputerInput,
  type HostUnitDetail,
  type HostUnitSummary,
} from "@computerd/core";
import {
  ComputerConflictError,
  ComputerNotFoundError,
  HostUnitNotFoundError,
} from "@computerd/control-plane";

class InvalidJsonBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJsonBodyError";
  }
}

interface CreateAppOptions {
  handleMcpRequest?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
  listComputers: () => Promise<ComputerSummary[]>;
  getComputer: (name: string) => Promise<ComputerDetail>;
  createComputer: (input: CreateComputerInput) => Promise<ComputerDetail>;
  startComputer: (name: string) => Promise<ComputerDetail>;
  stopComputer: (name: string) => Promise<ComputerDetail>;
  restartComputer: (name: string) => Promise<ComputerDetail>;
  listHostUnits: () => Promise<HostUnitSummary[]>;
  getHostUnit: (unitName: string) => Promise<HostUnitDetail>;
}

export function createApp({
  handleMcpRequest,
  listComputers,
  getComputer,
  createComputer,
  startComputer,
  stopComputer,
  restartComputer,
  listHostUnits,
  getHostUnit,
}: CreateAppOptions) {
  return createServer(async (request, response) => {
    try {
      if (request.url === "/healthz") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      const url = new URL(request.url ?? "/", "http://localhost");

      if (url.pathname === "/mcp" && handleMcpRequest) {
        if (await handleMcpRequest(request, response)) {
          return;
        }
      }

      if (request.method === "GET" && url.pathname === "/api/computers") {
        sendJson(response, 200, parseComputerSummaries(await listComputers()));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/computers") {
        const body = await readJsonBody(request);
        sendJson(
          response,
          201,
          parseComputerDetail(await createComputer(parseCreateComputerInput(body))),
        );
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/computers/")) {
        const actionMatch =
          /^\/api\/computers\/(?<name>[^/]+)\/(?<action>start|stop|restart)$/.exec(url.pathname);
        if (request.method === "GET" && actionMatch) {
          sendJson(response, 404, { error: "Not Found" });
          return;
        }

        if (request.method === "GET") {
          const name = decodeURIComponent(url.pathname.slice("/api/computers/".length));
          sendJson(response, 200, parseComputerDetail(await getComputer(name)));
          return;
        }
      }

      const computerActionMatch =
        /^\/api\/computers\/(?<name>[^/]+)\/(?<action>start|stop|restart)$/.exec(url.pathname);
      if (request.method === "POST" && computerActionMatch?.groups) {
        const encodedName = computerActionMatch.groups.name;
        const matchedAction = computerActionMatch.groups.action;

        if (!encodedName || !matchedAction) {
          sendJson(response, 400, { error: "Invalid computer action path" });
          return;
        }

        const name = decodeURIComponent(encodedName);
        const handlers = {
          restart: restartComputer,
          start: startComputer,
          stop: stopComputer,
        } as const;
        const action = matchedAction as keyof typeof handlers;

        sendJson(response, 200, parseComputerDetail(await handlers[action](name)));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/host-units") {
        sendJson(response, 200, parseHostUnitSummaries(await listHostUnits()));
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/host-units/")) {
        const unitName = decodeURIComponent(url.pathname.slice("/api/host-units/".length));
        sendJson(response, 200, parseHostUnitDetail(await getHostUnit(unitName)));
        return;
      }

      sendJson(response, 404, { error: "Not Found" });
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        sendJson(response, 400, { error: error.message });
        return;
      }

      if (error instanceof ComputerConflictError) {
        sendJson(response, 409, { error: error.message });
        return;
      }

      if (error instanceof ComputerNotFoundError || error instanceof HostUnitNotFoundError) {
        sendJson(response, 404, { error: error.message });
        return;
      }

      if (error instanceof InvalidJsonBodyError) {
        sendJson(response, 400, { error: error.message });
        return;
      }

      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Internal Server Error",
      });
    }
  });
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Uint8Array[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InvalidJsonBodyError("Request body must be valid JSON");
  }
}
