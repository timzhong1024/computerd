import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn as spawnProcess } from "node:child_process";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { spawn as spawnPty } from "@lydell/node-pty";
import { WebSocket, WebSocketServer } from "ws";
import { ZodError } from "zod";
import {
  parseComputerConsoleSession,
  parseComputerDetail,
  parseComputerMonitorSession,
  parseComputerSummaries,
  parseCreateComputerInput,
  parseHostUnitDetail,
  parseHostUnitSummaries,
  type ComputerConsoleSession,
  type ComputerDetail,
  type ComputerMonitorSession,
  type ComputerSummary,
  type CreateComputerInput,
  type HostUnitDetail,
  type HostUnitSummary,
} from "@computerd/core";
import {
  ComputerConsoleUnavailableError,
  ComputerConflictError,
  ComputerNotFoundError,
  type ConsoleAttachLease,
  HostUnitNotFoundError,
  UnsupportedComputerFeatureError,
} from "@computerd/control-plane";

class InvalidJsonBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJsonBodyError";
  }
}

interface CreateAppOptions {
  handleMcpRequest?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
  createConsoleSession: (name: string) => Promise<ComputerConsoleSession>;
  openConsoleAttach: (name: string) => Promise<ConsoleAttachLease>;
  listComputers: () => Promise<ComputerSummary[]>;
  createMonitorSession: (name: string) => Promise<ComputerMonitorSession>;
  getComputer: (name: string) => Promise<ComputerDetail>;
  createComputer: (input: CreateComputerInput) => Promise<ComputerDetail>;
  deleteComputer: (name: string) => Promise<void>;
  startComputer: (name: string) => Promise<ComputerDetail>;
  stopComputer: (name: string) => Promise<ComputerDetail>;
  restartComputer: (name: string) => Promise<ComputerDetail>;
  listHostUnits: () => Promise<HostUnitSummary[]>;
  getHostUnit: (unitName: string) => Promise<HostUnitDetail>;
}

export function createApp({
  handleMcpRequest,
  createConsoleSession,
  openConsoleAttach,
  listComputers,
  createMonitorSession,
  getComputer,
  createComputer,
  deleteComputer,
  startComputer,
  stopComputer,
  restartComputer,
  listHostUnits,
  getHostUnit,
}: CreateAppOptions) {
  const websocketServer = new WebSocketServer({ noServer: true });
  const server = createServer(async (request, response) => {
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
        const websocketStubMatch =
          /^\/api\/computers\/(?<name>[^/]+)\/(?<surface>monitor|console)\/ws$/.exec(url.pathname);
        if (websocketStubMatch) {
          if (websocketStubMatch.groups?.surface === "console") {
            sendJson(response, 426, { error: "Console websocket endpoint requires upgrade." });
            return;
          }

          sendJson(response, 501, { error: "Realtime websocket bridge not implemented yet." });
          return;
        }

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

      if (request.method === "DELETE" && url.pathname.startsWith("/api/computers/")) {
        const name = decodeURIComponent(url.pathname.slice("/api/computers/".length));
        await deleteComputer(name);
        sendJson(response, 204, null);
        return;
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

      const computerSessionMatch =
        /^\/api\/computers\/(?<name>[^/]+)\/(?<surface>monitor|console)-sessions$/.exec(
          url.pathname,
        );
      if (request.method === "POST" && computerSessionMatch?.groups) {
        const encodedName = computerSessionMatch.groups.name;
        const matchedSurface = computerSessionMatch.groups.surface;

        if (!encodedName || !matchedSurface) {
          sendJson(response, 400, { error: "Invalid computer session path" });
          return;
        }

        const name = decodeURIComponent(encodedName);
        if (matchedSurface === "monitor") {
          sendJson(response, 200, parseComputerMonitorSession(await createMonitorSession(name)));
          return;
        }

        sendJson(response, 200, parseComputerConsoleSession(await createConsoleSession(name)));
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

      if (error instanceof ComputerConsoleUnavailableError) {
        sendJson(response, 409, { error: error.message });
        return;
      }

      if (error instanceof UnsupportedComputerFeatureError) {
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

  server.on("upgrade", (request, socket, head) => {
    void handleUpgradeRequest({
      request,
      socket,
      head,
      openConsoleAttach,
      websocketServer,
    });
  });
  server.on("close", () => {
    websocketServer.close();
  });

  return server;
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

async function handleUpgradeRequest({
  request,
  socket,
  head,
  openConsoleAttach,
  websocketServer,
}: {
  request: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  openConsoleAttach: (name: string) => Promise<ConsoleAttachLease>;
  websocketServer: WebSocketServer;
}) {
  const url = new URL(request.url ?? "/", "http://localhost");
  const consoleMatch = /^\/api\/computers\/(?<name>[^/]+)\/console\/ws$/.exec(url.pathname);
  if (!consoleMatch?.groups?.name) {
    writeUpgradeError(socket, 404, "Not Found");
    return;
  }

  let lease: ConsoleAttachLease;
  try {
    lease = await openConsoleAttach(decodeURIComponent(consoleMatch.groups.name));
  } catch (error: unknown) {
    writeUpgradeError(socket, mapUpgradeStatusCode(error), errorMessage(error));
    return;
  }

  websocketServer.handleUpgrade(request, socket, head, (websocket: WebSocket) => {
    bridgeConsoleWebSocket(websocket, lease);
  });
}

function bridgeConsoleWebSocket(websocket: WebSocket, lease: ConsoleAttachLease) {
  const terminal = createTerminalProcess(lease);
  let closed = false;

  terminal.onData((data) => {
    if (websocket.readyState !== WebSocket.OPEN) {
      return;
    }

    websocket.send(JSON.stringify({ type: "output", data }));
  });
  terminal.onExit(({ exitCode, signal }) => {
    if (websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({ type: "exit", exitCode, signal }));
      websocket.close();
    }
    cleanup();
  });

  websocket.on("message", (message: WebSocket.RawData) => {
    const payload = parseConsoleWireMessage(message.toString());
    if (!payload) {
      return;
    }

    if (payload.type === "input") {
      terminal.write(payload.data);
      return;
    }

    terminal.resize(payload.cols, payload.rows);
  });
  websocket.on("close", cleanup);
  websocket.on("error", cleanup);

  if (websocket.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify({ type: "ready" }));
  }

  function cleanup() {
    if (closed) {
      return;
    }

    closed = true;
    try {
      terminal.kill();
    } catch {
      // node-pty throws if the child already exited.
    }
    lease.release();
  }
}

interface TerminalProcess {
  kill: () => void;
  onData: (listener: (data: string) => void) => void;
  onExit: (listener: (event: { exitCode?: number; signal?: number }) => void) => void;
  resize: (cols: number, rows: number) => void;
  write: (data: string) => void;
}

function createTerminalProcess(lease: ConsoleAttachLease): TerminalProcess {
  const cwd = lease.cwd ?? process.cwd();
  const env = sanitizeSpawnEnvironment({
    ...process.env,
    ...lease.env,
  });

  try {
    const terminal = spawnPty(lease.command, lease.args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env,
    });

    return {
      kill() {
        terminal.kill();
      },
      onData(listener) {
        terminal.onData(listener);
      },
      onExit(listener) {
        terminal.onExit(listener);
      },
      resize(cols, rows) {
        terminal.resize(cols, rows);
      },
      write(data) {
        terminal.write(data);
      },
    };
  } catch (error: unknown) {
    if (process.env.COMPUTERD_RUNTIME_MODE !== "development") {
      throw error;
    }

    console.warn(
      `node-pty spawn failed for ${lease.computerName}; falling back to pipe-backed shell: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    const child = spawnProcess(lease.command, lease.args, {
      cwd,
      env,
      stdio: "pipe",
    });
    const dataListeners = new Set<(data: string) => void>();

    return {
      kill() {
        child.kill("SIGTERM");
      },
      onData(listener) {
        dataListeners.add(listener);
        child.stdout?.on("data", (chunk: Buffer | string) => listener(String(chunk)));
        child.stderr?.on("data", (chunk: Buffer | string) => listener(String(chunk)));
      },
      onExit(listener) {
        child.on("exit", (exitCode, signal) => {
          listener({
            exitCode: exitCode ?? undefined,
            signal: typeof signal === "string" ? undefined : (signal ?? undefined),
          });
        });
      },
      resize() {
        // Pipe-backed fallback does not support terminal resize semantics.
      },
      write(data) {
        for (const listener of dataListeners) {
          listener(renderFallbackInput(data));
        }
        child.stdin?.write(data.replaceAll("\r", "\n"));
      },
    };
  }
}

function sanitizeSpawnEnvironment(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function renderFallbackInput(data: string) {
  return data.replaceAll("\r", "\r\n").replaceAll("\u007f", "\b \b");
}

function parseConsoleWireMessage(value: string) {
  try {
    const payload = JSON.parse(value) as
      | { type: "input"; data: string }
      | { type: "resize"; cols: number; rows: number };
    if (payload.type === "input" && typeof payload.data === "string") {
      return payload;
    }
    if (
      payload.type === "resize" &&
      typeof payload.cols === "number" &&
      typeof payload.rows === "number"
    ) {
      return payload;
    }
  } catch {
    return null;
  }

  return null;
}

function writeUpgradeError(socket: Duplex, statusCode: number, message: string) {
  socket.write(
    `HTTP/1.1 ${statusCode} ${httpStatusText(statusCode)}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${message}`,
  );
  socket.destroy();
}

function mapUpgradeStatusCode(error: unknown) {
  if (error instanceof ComputerNotFoundError || error instanceof HostUnitNotFoundError) {
    return 404;
  }
  if (
    error instanceof UnsupportedComputerFeatureError ||
    error instanceof ComputerConsoleUnavailableError ||
    error instanceof ComputerConflictError
  ) {
    return 409;
  }

  return 500;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Internal Server Error";
}

function httpStatusText(statusCode: number) {
  const texts = {
    404: "Not Found",
    409: "Conflict",
    500: "Internal Server Error",
  } as const;
  return texts[statusCode as keyof typeof texts] ?? "Error";
}
