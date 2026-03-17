import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createConnection } from "node:net";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { type Duplex, Readable } from "node:stream";
import { randomUUID } from "node:crypto";
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
  parseComputerSnapshot,
  parseComputerSnapshots,
  parseComputerSummaries,
  parseCreateComputerInput,
  parseCreateComputerSnapshotInput,
  parseHostUnitDetail,
  parseHostUnitSummaries,
  parseImageDetail,
  parseImageSummaries,
  parseImportVmImageInput,
  parseNetworkDetail,
  parseNetworkSummaries,
  parseCreateNetworkInput,
  parsePullContainerImageInput,
  parseResizeDisplayInput,
  parseRestoreComputerInput,
  parseRunDisplayActionsInput,
  parseVmGuestCommandInput,
  parseVmGuestCommandResult,
  parseVmGuestFileReadInput,
  parseVmGuestFileReadResult,
  parseVmGuestFileWriteInput,
  parseVmGuestFileWriteResult,
} from "@computerd/core";
import {
  type BrowserAutomationLease,
  type BrowserAudioStreamLease,
  type BrowserMonitorLease,
  type BaseControlPlane,
  BrokenImageError,
  BrokenComputerError,
  ComputerConsoleUnavailableError,
  ComputerConflictError,
  ComputerNotFoundError,
  ComputerSnapshotConflictError,
  ComputerSnapshotNotFoundError,
  type ConsoleAttachLease,
  HostUnitNotFoundError,
  ImageMutationNotAllowedError,
  ImageNotFoundError,
  NetworkConflictError,
  NetworkNotFoundError,
  AttachedNetworkDeleteError,
  UnsupportedComputerFeatureError,
} from "@computerd/control-plane";
import { createMcpHandler } from "./create-mcp-handler";

class InvalidJsonBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJsonBodyError";
  }
}

interface CreateAppOptions {
  handleMcpRequest?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
  overrides?: Partial<BaseControlPlane>;
}

export function createApp(controlPlane: BaseControlPlane, options: CreateAppOptions = {}) {
  const appControlPlane = withControlPlaneOverrides(controlPlane, options.overrides);
  const handleMcpRequest = options.handleMcpRequest ?? createMcpHandler(appControlPlane);
  const websocketServer = new WebSocketServer({ noServer: true });
  const server = createServer(async (request, response) => {
    const requestLog = createRequestLogContext(request);
    try {
      if (request.url === "/healthz") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      const url = new URL(request.url ?? "/", "http://localhost");

      if (url.pathname === "/mcp") {
        if (await handleMcpRequest(request, response)) {
          return;
        }
      }

      if (request.method === "GET" && url.pathname === "/api/images") {
        sendJson(
          response,
          200,
          parseImageSummaries(await appControlPlane.imageProvider.listImages()),
        );
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/networks") {
        sendJson(response, 200, parseNetworkSummaries(await appControlPlane.listNetworks()));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/networks") {
        const body = await readJsonBody(request);
        sendJson(
          response,
          201,
          parseNetworkDetail(await appControlPlane.createNetwork(parseCreateNetworkInput(body))),
        );
        return;
      }

      const networkDetailMatch = /^\/api\/networks\/(?<id>.+)$/.exec(url.pathname);
      if (request.method === "GET" && networkDetailMatch?.groups?.id) {
        sendJson(
          response,
          200,
          parseNetworkDetail(
            await appControlPlane.getNetwork(decodeURIComponent(networkDetailMatch.groups.id)),
          ),
        );
        return;
      }

      if (request.method === "DELETE" && networkDetailMatch?.groups?.id) {
        await appControlPlane.deleteNetwork(decodeURIComponent(networkDetailMatch.groups.id));
        sendJson(response, 204, null);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/images/container/pull") {
        const body = await readJsonBody(request);
        const input = parsePullContainerImageInput(body);
        sendJson(
          response,
          201,
          parseImageDetail(await appControlPlane.imageProvider.pullContainerImage(input.reference)),
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/images/vm/import") {
        const body = await readJsonBody(request);
        sendJson(
          response,
          201,
          parseImageDetail(
            await appControlPlane.imageProvider.importVmImage(parseImportVmImageInput(body)),
          ),
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/images/vm/upload") {
        const form = await readFormDataBody(request);
        const file = form.get("file");
        if (!(file instanceof File)) {
          sendJson(response, 400, { error: 'Expected a "file" upload field.' });
          return;
        }

        const tempPath = join(
          tmpdir(),
          `computerd-vm-upload-${randomUUID()}${extname(file.name) || ".bin"}`,
        );
        try {
          await writeFile(tempPath, new Uint8Array(await file.arrayBuffer()));
          sendJson(
            response,
            201,
            parseImageDetail(
              await appControlPlane.imageProvider.importVmImage({
                source: {
                  type: "file",
                  path: tempPath,
                },
              }),
            ),
          );
          return;
        } finally {
          await rm(tempPath, { force: true }).catch(() => undefined);
        }
      }

      const vmImageDeleteMatch = /^\/api\/images\/vm\/(?<id>.+)$/.exec(url.pathname);
      if (request.method === "DELETE" && vmImageDeleteMatch?.groups?.id) {
        await appControlPlane.imageProvider.deleteVmImage(
          decodeURIComponent(vmImageDeleteMatch.groups.id),
        );
        sendJson(response, 204, null);
        return;
      }

      const containerImageDeleteMatch = /^\/api\/images\/container\/(?<id>.+)$/.exec(url.pathname);
      if (request.method === "DELETE" && containerImageDeleteMatch?.groups?.id) {
        await appControlPlane.imageProvider.deleteContainerImage(
          decodeURIComponent(containerImageDeleteMatch.groups.id),
        );
        sendJson(response, 204, null);
        return;
      }

      const imageDetailMatch = /^\/api\/images\/(?<id>.+)$/.exec(url.pathname);
      if (request.method === "GET" && imageDetailMatch?.groups?.id) {
        sendJson(
          response,
          200,
          parseImageDetail(
            await appControlPlane.imageProvider.getImage(
              decodeURIComponent(imageDetailMatch.groups.id),
            ),
          ),
        );
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/computers") {
        sendJson(response, 200, parseComputerSummaries(await appControlPlane.listComputers()));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/computers") {
        const body = await readJsonBody(request);
        sendJson(
          response,
          201,
          parseComputerDetail(await appControlPlane.createComputer(parseCreateComputerInput(body))),
        );
        return;
      }

      const computerSnapshotsMatch = /^\/api\/computers\/(?<name>[^/]+)\/snapshots$/.exec(
        url.pathname,
      );
      if (computerSnapshotsMatch?.groups?.name) {
        const name = decodeURIComponent(computerSnapshotsMatch.groups.name);
        if (request.method === "GET") {
          sendJson(
            response,
            200,
            parseComputerSnapshots(await appControlPlane.listComputerSnapshots(name)),
          );
          return;
        }

        if (request.method === "POST") {
          const body = await readJsonBody(request);
          sendJson(
            response,
            201,
            parseComputerSnapshot(
              await appControlPlane.createComputerSnapshot(
                name,
                parseCreateComputerSnapshotInput(body),
              ),
            ),
          );
          return;
        }
      }

      const computerRestoreMatch = /^\/api\/computers\/(?<name>[^/]+)\/restore$/.exec(url.pathname);
      if (request.method === "POST" && computerRestoreMatch?.groups?.name) {
        const name = decodeURIComponent(computerRestoreMatch.groups.name);
        const body = await readJsonBody(request);
        sendJson(
          response,
          200,
          parseComputerDetail(
            await appControlPlane.restoreComputer(name, parseRestoreComputerInput(body)),
          ),
        );
        return;
      }

      const deleteSnapshotMatch =
        /^\/api\/computers\/(?<name>[^/]+)\/snapshots\/(?<snapshotName>[^/]+)$/.exec(url.pathname);
      if (
        request.method === "DELETE" &&
        deleteSnapshotMatch?.groups?.name &&
        deleteSnapshotMatch.groups.snapshotName
      ) {
        const name = decodeURIComponent(deleteSnapshotMatch.groups.name);
        const snapshotName = decodeURIComponent(deleteSnapshotMatch.groups.snapshotName);
        await appControlPlane.deleteComputerSnapshot(name, snapshotName);
        sendJson(response, 204, null);
        return;
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/api/computers/")) {
        const name = decodeURIComponent(url.pathname.slice("/api/computers/".length));
        await appControlPlane.deleteComputer(name);
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
          restart: (computerName: string) => appControlPlane.restartComputer(computerName),
          start: (computerName: string) => appControlPlane.startComputer(computerName),
          stop: (computerName: string) => appControlPlane.stopComputer(computerName),
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
          sendJson(
            response,
            200,
            parseComputerMonitorSession(await appControlPlane.createMonitorSession(name)),
          );
          return;
        }

        if (matchedSurface === "automation") {
          sendJson(
            response,
            200,
            parseComputerAutomationSession(await appControlPlane.createAutomationSession(name)),
          );
          return;
        }

        if (matchedSurface === "audio") {
          sendJson(
            response,
            200,
            parseComputerAudioSession(await appControlPlane.createAudioSession(name)),
          );
          return;
        }

        if (matchedSurface === "exec") {
          sendJson(
            response,
            200,
            parseComputerExecSession(await appControlPlane.createExecSession(name)),
          );
          return;
        }

        sendJson(
          response,
          200,
          parseComputerConsoleSession(await appControlPlane.createConsoleSession(name)),
        );
        return;
      }

      const browserAudioMatch = /^\/api\/computers\/(?<name>[^/]+)\/audio$/.exec(url.pathname);
      if (request.method === "GET" && browserAudioMatch?.groups?.name) {
        const name = decodeURIComponent(browserAudioMatch.groups.name);
        await streamAudioResponse(response, request, await appControlPlane.openAudioStream(name));
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/computers/")) {
        const websocketStubMatch =
          /^\/api\/computers\/(?<name>[^/]+)\/(?<surface>monitor|console|exec|automation)\/ws$/.exec(
            url.pathname,
          );
        if (websocketStubMatch?.groups?.name) {
          const name = decodeURIComponent(websocketStubMatch.groups.name);
          const detail = await appControlPlane.getComputer(name);
          if (detail.state === "broken") {
            sendJson(response, 409, {
              error: `Computer "${name}" is broken because its backing runtime entity is missing. Websocket attach is not supported for broken computers.`,
            });
            return;
          }

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
        sendJson(response, 200, parseComputerDetail(await appControlPlane.getComputer(name)));
        return;
      }
      const computerScreenshotMatch = /^\/api\/computers\/(?<name>[^/]+)\/screenshots$/.exec(
        url.pathname,
      );
      if (request.method === "POST" && computerScreenshotMatch?.groups?.name) {
        const name = decodeURIComponent(computerScreenshotMatch.groups.name);
        sendJson(
          response,
          200,
          parseComputerScreenshot(await appControlPlane.createScreenshot(name)),
        );
        return;
      }

      const resizeDisplayMatch = /^\/api\/computers\/(?<name>[^/]+)\/resize$/.exec(url.pathname);
      if (request.method === "POST" && resizeDisplayMatch?.groups?.name) {
        const name = decodeURIComponent(resizeDisplayMatch.groups.name);
        const body = await readJsonBody(request);
        sendJson(
          response,
          200,
          parseComputerDetail(
            await appControlPlane.resizeDisplay(name, parseResizeDisplayInput(body)),
          ),
        );
        return;
      }

      const vmGuestCommandMatch = /^\/api\/computers\/(?<name>[^/]+)\/guest-command$/.exec(
        url.pathname,
      );
      if (request.method === "POST" && vmGuestCommandMatch?.groups?.name) {
        const name = decodeURIComponent(vmGuestCommandMatch.groups.name);
        const body = await readJsonBody(request);
        sendJson(
          response,
          200,
          parseVmGuestCommandResult(
            await appControlPlane.runVmGuestCommand(name, parseVmGuestCommandInput(body)),
          ),
        );
        return;
      }

      const vmGuestFileReadMatch = /^\/api\/computers\/(?<name>[^/]+)\/guest-files\/read$/.exec(
        url.pathname,
      );
      if (request.method === "POST" && vmGuestFileReadMatch?.groups?.name) {
        const name = decodeURIComponent(vmGuestFileReadMatch.groups.name);
        const body = await readJsonBody(request);
        sendJson(
          response,
          200,
          parseVmGuestFileReadResult(
            await appControlPlane.readVmGuestFile(name, parseVmGuestFileReadInput(body)),
          ),
        );
        return;
      }

      const vmGuestFileWriteMatch = /^\/api\/computers\/(?<name>[^/]+)\/guest-files\/write$/.exec(
        url.pathname,
      );
      if (request.method === "POST" && vmGuestFileWriteMatch?.groups?.name) {
        const name = decodeURIComponent(vmGuestFileWriteMatch.groups.name);
        const body = await readJsonBody(request);
        sendJson(
          response,
          200,
          parseVmGuestFileWriteResult(
            await appControlPlane.writeVmGuestFile(name, parseVmGuestFileWriteInput(body)),
          ),
        );
        return;
      }

      const displayActionsMatch = /^\/api\/computers\/(?<name>[^/]+)\/display-actions$/.exec(
        url.pathname,
      );
      if (request.method === "POST" && displayActionsMatch?.groups?.name) {
        const name = decodeURIComponent(displayActionsMatch.groups.name);
        const body = await readJsonBody(request);
        const input = parseRunDisplayActionsInput({
          computerName: name,
          ...body,
        });
        sendJson(response, 200, await appControlPlane.runDisplayActions(name, input));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/host-units") {
        sendJson(response, 200, parseHostUnitSummaries(await appControlPlane.listHostUnits()));
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/host-units/")) {
        const unitName = decodeURIComponent(url.pathname.slice("/api/host-units/".length));
        sendJson(response, 200, parseHostUnitDetail(await appControlPlane.getHostUnit(unitName)));
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

      if (error instanceof ComputerSnapshotConflictError) {
        sendJson(response, 409, { error: error.message });
        return;
      }

      if (error instanceof ComputerConsoleUnavailableError) {
        sendJson(response, 409, { error: error.message });
        return;
      }

      if (error instanceof BrokenComputerError) {
        sendJson(response, 409, { error: error.message });
        return;
      }

      if (error instanceof NetworkConflictError) {
        sendJson(response, 409, { error: error.message });
        return;
      }

      if (error instanceof AttachedNetworkDeleteError) {
        sendJson(response, 409, { error: error.message });
        return;
      }

      if (error instanceof BrokenImageError) {
        sendJson(response, 409, { error: error.message });
        return;
      }

      if (error instanceof ImageMutationNotAllowedError) {
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

      if (
        error instanceof ComputerNotFoundError ||
        error instanceof HostUnitNotFoundError ||
        error instanceof ComputerSnapshotNotFoundError ||
        error instanceof ImageNotFoundError ||
        error instanceof NetworkNotFoundError
      ) {
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
      controlPlane: appControlPlane,
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

async function readFormDataBody(request: IncomingMessage) {
  const requestInit = {
    method: request.method,
    headers: request.headers as HeadersInit,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : (Readable.toWeb(request) as BodyInit),
    duplex: "half",
  } as RequestInit & { duplex: "half" };
  const webRequest = new Request("http://localhost/upload", requestInit);
  return await webRequest.formData();
}

async function handleUpgradeRequest({
  request,
  socket,
  head,
  controlPlane,
  websocketServer,
}: {
  request: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  controlPlane: BaseControlPlane;
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
      const lease = await controlPlane.openConsoleAttach(computerName);
      websocketServer.handleUpgrade(request, socket, head, (websocket: WebSocket) => {
        logUpgradeRequestComplete(requestLog, 101);
        bridgeConsoleWebSocket(websocket, lease);
      });
      return;
    }

    if (surface === "exec") {
      const lease = await controlPlane.openExecAttach(computerName);
      websocketServer.handleUpgrade(request, socket, head, (websocket: WebSocket) => {
        logUpgradeRequestComplete(requestLog, 101);
        bridgeConsoleWebSocket(websocket, lease);
      });
      return;
    }

    if (surface === "monitor") {
      const lease = await controlPlane.openMonitorAttach(computerName);
      websocketServer.handleUpgrade(request, socket, head, (websocket: WebSocket) => {
        logUpgradeRequestComplete(requestLog, 101);
        bridgeMonitorWebSocket(websocket, lease);
      });
      return;
    }

    const lease = await controlPlane.openAutomationAttach(computerName);
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

function withControlPlaneOverrides(
  controlPlane: BaseControlPlane,
  overrides: Partial<BaseControlPlane> | undefined,
) {
  if (!overrides) {
    return controlPlane;
  }

  return Object.assign(Object.create(controlPlane), overrides) as BaseControlPlane;
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

abstract class TerminalProcess {
  abstract kill(): void;
  abstract onData(listener: (data: string) => void): void;
  abstract onExit(listener: (event: { exitCode?: number; signal?: number | string }) => void): void;
  abstract resize(cols: number, rows: number): void;
  abstract write(data: string): void;
}

export function createTerminalProcess(lease: ConsoleAttachLease): TerminalProcess {
  const cwd = lease.cwd ?? process.cwd();
  const env = sanitizeSpawnEnvironment({
    ...process.env,
    ...lease.env,
  });
  if (lease.pty === false) {
    const child = spawn(lease.command, lease.args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return new RawTerminalProcess(child);
  }

  const terminal = spawnPty(lease.command, lease.args, {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd,
    env,
  });

  return new PtyTerminalProcess(terminal);
}

class PtyTerminalProcess extends TerminalProcess {
  constructor(private readonly terminal: ReturnType<typeof spawnPty>) {
    super();
  }

  kill() {
    this.terminal.kill();
  }

  onData(listener: (data: string) => void) {
    this.terminal.onData(listener);
  }

  onExit(listener: (event: { exitCode?: number; signal?: number | string }) => void) {
    this.terminal.onExit(listener);
  }

  resize(cols: number, rows: number) {
    this.terminal.resize(cols, rows);
  }

  write(data: string) {
    this.terminal.write(data);
  }
}

class RawTerminalProcess extends TerminalProcess {
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    super();
  }

  kill() {
    if (!this.child.killed) {
      this.child.kill("SIGTERM");
    }
  }

  onData(listener: (data: string) => void) {
    this.child.stdout.on("data", (chunk: Buffer) => {
      listener(chunk.toString("utf8"));
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      listener(chunk.toString("utf8"));
    });
  }

  onExit(listener: (event: { exitCode?: number; signal?: number | string }) => void) {
    this.child.on("close", (exitCode, signal) => {
      listener({
        exitCode: exitCode ?? undefined,
        signal: signal ?? undefined,
      });
    });
  }

  resize() {}

  write(data: string) {
    this.child.stdin.write(data);
  }
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
    error instanceof ComputerConflictError ||
    error instanceof BrokenComputerError ||
    error instanceof BrokenImageError
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
