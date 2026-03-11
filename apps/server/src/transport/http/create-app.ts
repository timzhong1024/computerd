import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import { spawn as spawnPty } from "@lydell/node-pty";
import { WebSocket, WebSocketServer } from "ws";
import { ZodError } from "zod";
import {
  parseComputerAutomationSession,
  parseComputerAudioSession,
  parseComputerConsoleSession,
  parseComputerDetail,
  parseComputerExecSession,
  parseComputerMonitorSession,
  parseComputerScreenshot,
  parseComputerSummaries,
  parseCreateComputerInput,
  parseHostUnitDetail,
  parseHostUnitSummaries,
  parseUpdateBrowserViewportInput,
  type ComputerAutomationSession,
  type ComputerAudioSession,
  type ComputerConsoleSession,
  type ComputerDetail,
  type ComputerExecSession,
  type ComputerMonitorSession,
  type ComputerScreenshot,
  type ComputerSummary,
  type CreateComputerInput,
  type HostUnitDetail,
  type HostUnitSummary,
} from "@computerd/core";
import {
  type BrowserAutomationLease,
  type BrowserAudioStreamLease,
  type BrowserMonitorLease,
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
  createAutomationSession: (name: string) => Promise<ComputerAutomationSession>;
  createAudioSession: (name: string) => Promise<ComputerAudioSession>;
  handleMcpRequest?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
  createConsoleSession: (name: string) => Promise<ComputerConsoleSession>;
  createExecSession: (name: string) => Promise<ComputerExecSession>;
  openConsoleAttach: (name: string) => Promise<ConsoleAttachLease>;
  openExecAttach: (name: string) => Promise<ConsoleAttachLease>;
  openAutomationAttach: (name: string) => Promise<BrowserAutomationLease>;
  openAudioStream: (name: string) => Promise<BrowserAudioStreamLease>;
  listComputers: () => Promise<ComputerSummary[]>;
  createMonitorSession: (name: string) => Promise<ComputerMonitorSession>;
  openMonitorAttach: (name: string) => Promise<BrowserMonitorLease>;
  createScreenshot: (name: string) => Promise<ComputerScreenshot>;
  getComputer: (name: string) => Promise<ComputerDetail>;
  createComputer: (input: CreateComputerInput) => Promise<ComputerDetail>;
  deleteComputer: (name: string) => Promise<void>;
  startComputer: (name: string) => Promise<ComputerDetail>;
  stopComputer: (name: string) => Promise<ComputerDetail>;
  restartComputer: (name: string) => Promise<ComputerDetail>;
  listHostUnits: () => Promise<HostUnitSummary[]>;
  getHostUnit: (unitName: string) => Promise<HostUnitDetail>;
  updateBrowserViewport: (
    name: string,
    input: { width: number; height: number },
  ) => Promise<ComputerDetail>;
}

export function createApp({
  createAutomationSession,
  createAudioSession,
  handleMcpRequest,
  createConsoleSession,
  createExecSession,
  openConsoleAttach,
  openExecAttach,
  openAutomationAttach,
  openAudioStream,
  listComputers,
  createMonitorSession,
  openMonitorAttach,
  createScreenshot,
  getComputer,
  createComputer,
  deleteComputer,
  startComputer,
  stopComputer,
  restartComputer,
  listHostUnits,
  getHostUnit,
  updateBrowserViewport,
}: CreateAppOptions) {
  const websocketServer = new WebSocketServer({ noServer: true });
  const server = createServer(async (request, response) => {
    const requestLog = createRequestLogContext(request);
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
        /^\/api\/computers\/(?<name>[^/]+)\/(?<surface>monitor|console|exec|automation|audio)-sessions$/.exec(
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

        if (matchedSurface === "automation") {
          sendJson(
            response,
            200,
            parseComputerAutomationSession(await createAutomationSession(name)),
          );
          return;
        }

        if (matchedSurface === "audio") {
          sendJson(response, 200, parseComputerAudioSession(await createAudioSession(name)));
          return;
        }

        if (matchedSurface === "exec") {
          sendJson(response, 200, parseComputerExecSession(await createExecSession(name)));
          return;
        }

        sendJson(response, 200, parseComputerConsoleSession(await createConsoleSession(name)));
        return;
      }

      const browserAudioMatch = /^\/api\/computers\/(?<name>[^/]+)\/audio$/.exec(url.pathname);
      if (request.method === "GET" && browserAudioMatch?.groups?.name) {
        const name = decodeURIComponent(browserAudioMatch.groups.name);
        await streamAudioResponse(response, request, await openAudioStream(name));
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/computers/")) {
        const websocketStubMatch =
          /^\/api\/computers\/(?<name>[^/]+)\/(?<surface>monitor|console|exec|automation)\/ws$/.exec(
            url.pathname,
          );
        if (websocketStubMatch) {
          sendJson(response, 426, { error: "Websocket endpoint requires upgrade." });
          return;
        }

        const actionMatch =
          /^\/api\/computers\/(?<name>[^/]+)\/(?<action>start|stop|restart)$/.exec(url.pathname);
        if (request.method === "GET" && actionMatch) {
          sendJson(response, 404, { error: "Not Found" });
          return;
        }

        const name = decodeURIComponent(url.pathname.slice("/api/computers/".length));
        sendJson(response, 200, parseComputerDetail(await getComputer(name)));
        return;
      }
      const computerScreenshotMatch = /^\/api\/computers\/(?<name>[^/]+)\/screenshots$/.exec(
        url.pathname,
      );
      if (request.method === "POST" && computerScreenshotMatch?.groups?.name) {
        const name = decodeURIComponent(computerScreenshotMatch.groups.name);
        sendJson(response, 200, parseComputerScreenshot(await createScreenshot(name)));
        return;
      }

      const browserViewportMatch = /^\/api\/computers\/(?<name>[^/]+)\/viewport$/.exec(
        url.pathname,
      );
      if (request.method === "POST" && browserViewportMatch?.groups?.name) {
        const name = decodeURIComponent(browserViewportMatch.groups.name);
        const body = await readJsonBody(request);
        sendJson(
          response,
          200,
          parseComputerDetail(
            await updateBrowserViewport(name, parseUpdateBrowserViewportInput(body)),
          ),
        );
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
      logHttpRequestError(requestLog, error);

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

      if (looksLikeConflictError(error)) {
        sendJson(response, 409, { error: errorMessage(error) });
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
    } finally {
      logHttpRequestComplete(requestLog, response);
    }
  });

  server.on("upgrade", (request, socket, head) => {
    void handleUpgradeRequest({
      request,
      socket,
      head,
      openConsoleAttach,
      openExecAttach,
      openAutomationAttach,
      openMonitorAttach,
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

interface RequestLogContext {
  method: string;
  path: string;
  startedAt: number;
}

function createRequestLogContext(request: IncomingMessage): RequestLogContext {
  const url = new URL(request.url ?? "/", "http://localhost");
  return {
    method: request.method ?? "UNKNOWN",
    path: url.pathname,
    startedAt: Date.now(),
  };
}

function logHttpRequestComplete(context: RequestLogContext, response: ServerResponse) {
  console.info(
    JSON.stringify({
      type: "http_request",
      method: context.method,
      path: context.path,
      statusCode: response.statusCode,
      durationMs: Date.now() - context.startedAt,
    }),
  );
}

function logHttpRequestError(context: RequestLogContext, error: unknown) {
  console.error(
    JSON.stringify({
      type: "http_request_error",
      method: context.method,
      path: context.path,
      error: error instanceof Error ? error.message : "Unknown error",
    }),
  );
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
  openExecAttach,
  openAutomationAttach,
  openMonitorAttach,
  websocketServer,
}: {
  request: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  openConsoleAttach: (name: string) => Promise<ConsoleAttachLease>;
  openExecAttach: (name: string) => Promise<ConsoleAttachLease>;
  openAutomationAttach: (name: string) => Promise<BrowserAutomationLease>;
  openMonitorAttach: (name: string) => Promise<BrowserMonitorLease>;
  websocketServer: WebSocketServer;
}) {
  const requestLog = createRequestLogContext(request);
  const url = new URL(request.url ?? "/", "http://localhost");
  const upgradeMatch =
    /^\/api\/computers\/(?<name>[^/]+)\/(?<surface>console|exec|monitor|automation)\/ws$/.exec(
      url.pathname,
    );
  if (!upgradeMatch?.groups?.name || !upgradeMatch.groups.surface) {
    logUpgradeRequestComplete(requestLog, 404);
    writeUpgradeError(socket, 404, "Not Found");
    return;
  }

  const computerName = decodeURIComponent(upgradeMatch.groups.name);
  const surface = upgradeMatch.groups.surface;

  try {
    if (surface === "console") {
      const lease = await openConsoleAttach(computerName);
      websocketServer.handleUpgrade(request, socket, head, (websocket: WebSocket) => {
        logUpgradeRequestComplete(requestLog, 101);
        bridgeConsoleWebSocket(websocket, lease);
      });
      return;
    }

    if (surface === "exec") {
      const lease = await openExecAttach(computerName);
      websocketServer.handleUpgrade(request, socket, head, (websocket: WebSocket) => {
        logUpgradeRequestComplete(requestLog, 101);
        bridgeConsoleWebSocket(websocket, lease);
      });
      return;
    }

    if (surface === "monitor") {
      const lease = await openMonitorAttach(computerName);
      websocketServer.handleUpgrade(request, socket, head, (websocket: WebSocket) => {
        logUpgradeRequestComplete(requestLog, 101);
        bridgeMonitorWebSocket(websocket, lease);
      });
      return;
    }

    const lease = await openAutomationAttach(computerName);
    websocketServer.handleUpgrade(request, socket, head, (websocket: WebSocket) => {
      logUpgradeRequestComplete(requestLog, 101);
      bridgeAutomationWebSocket(websocket, lease);
    });
  } catch (error: unknown) {
    const statusCode = mapUpgradeStatusCode(error);
    logUpgradeRequestError(requestLog, error, statusCode);
    writeUpgradeError(socket, statusCode, errorMessage(error));
  }
}

function logUpgradeRequestComplete(context: RequestLogContext, statusCode: number) {
  console.info(
    JSON.stringify({
      type: "ws_upgrade",
      method: context.method,
      path: context.path,
      statusCode,
      durationMs: Date.now() - context.startedAt,
    }),
  );
}

function logUpgradeRequestError(context: RequestLogContext, error: unknown, statusCode: number) {
  console.error(
    JSON.stringify({
      type: "ws_upgrade_error",
      method: context.method,
      path: context.path,
      statusCode,
      error: error instanceof Error ? error.message : "Unknown error",
    }),
  );
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

function bridgeMonitorWebSocket(websocket: WebSocket, lease: BrowserMonitorLease) {
  const upstream = createConnection({
    host: lease.host,
    port: lease.port,
  });
  let closed = false;

  upstream.on("data", (chunk: Buffer) => {
    if (websocket.readyState === WebSocket.OPEN) {
      websocket.send(chunk, { binary: true });
    }
  });
  upstream.on("error", cleanup);
  upstream.on("close", cleanup);

  websocket.on("message", (message: WebSocket.RawData) => {
    upstream.write(message as Buffer);
  });
  websocket.on("close", cleanup);
  websocket.on("error", cleanup);

  function cleanup() {
    if (closed) {
      return;
    }

    closed = true;
    upstream.destroy();
    lease.release();
    if (websocket.readyState === WebSocket.OPEN) {
      websocket.close();
    }
  }
}

function bridgeAutomationWebSocket(websocket: WebSocket, lease: BrowserAutomationLease) {
  const upstream = new WebSocket(lease.url);
  let closed = false;

  upstream.on("message", (message, isBinary) => {
    if (websocket.readyState === WebSocket.OPEN) {
      websocket.send(message, { binary: isBinary });
    }
  });
  upstream.on("close", cleanup);
  upstream.on("error", cleanup);

  websocket.on("message", (message, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(message, { binary: isBinary });
    }
  });
  websocket.on("close", cleanup);
  websocket.on("error", cleanup);

  function cleanup() {
    if (closed) {
      return;
    }

    closed = true;
    upstream.close();
    lease.release();
    if (websocket.readyState === WebSocket.OPEN) {
      websocket.close();
    }
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
}

function sanitizeSpawnEnvironment(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
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

async function streamAudioResponse(
  response: ServerResponse,
  request: IncomingMessage,
  lease: BrowserAudioStreamLease,
) {
  response.statusCode = 200;
  response.setHeader("content-type", "audio/ogg");
  response.setHeader("cache-control", "no-store");
  response.setHeader("transfer-encoding", "chunked");

  const child = spawn(lease.command, lease.args, {
    env: {
      ...process.env,
      ...lease.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let cleanedUp = false;

  child.stdout.on("data", (chunk: Buffer) => {
    response.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    console.error(`[audio_stream:${lease.computerName}] ${chunk.toString("utf8").trim()}`);
  });
  child.on("error", (error) => {
    if (!response.headersSent) {
      sendJson(response, 500, { error: error.message });
      cleanup();
      return;
    }

    cleanup();
  });
  child.on("close", () => {
    cleanup();
  });
  request.on("close", cleanup);
  response.on("close", cleanup);

  function cleanup() {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    if (!child.killed) {
      child.kill("SIGTERM");
    }
    lease.release();
    if (!response.writableEnded) {
      response.end();
    }
  }
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

function looksLikeConflictError(error: unknown) {
  return (
    error instanceof Error &&
    (/does not support/i.test(error.message) ||
      /must be running/i.test(error.message) ||
      /already has an active/i.test(error.message) ||
      /PipeWire node .* was not found/i.test(error.message) ||
      /PipeWire runtime .* is not available/i.test(error.message))
  );
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
