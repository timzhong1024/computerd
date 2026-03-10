import { writeFile } from "node:fs/promises";
import { chromium, type Browser, type ConnectOverCDPOptions } from "playwright-core";
import {
  parseComputerAutomationSession,
  parseComputerDetail,
  parseComputerMonitorSession,
  parseComputerScreenshot,
  type BrowserComputerDetail,
  type ComputerAutomationSession,
  type ComputerDetail,
  type ComputerMonitorSession,
  type ComputerScreenshot,
  type ComputerSessionConnect,
} from "@computerd/core";

export interface ComputerdClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
}

export interface ConnectPlaywrightOptions {
  connectOverCDP?: (endpointURL: string, options?: ConnectOverCDPOptions) => Promise<Browser>;
  connectOptions?: ConnectOverCDPOptions;
}

export interface BrowserCliContext {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

export class ComputerdHttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly payload: unknown;

  constructor({
    status,
    statusText,
    payload,
  }: {
    status: number;
    statusText: string;
    payload: unknown;
  }) {
    super(createErrorMessage(status, statusText, payload));
    this.name = "ComputerdHttpError";
    this.status = status;
    this.statusText = statusText;
    this.payload = payload;
  }
}

export function createComputerdClient({
  baseUrl,
  fetch: fetchImplementation = globalThis.fetch,
}: ComputerdClientOptions) {
  const normalizedBaseUrl = new URL(baseUrl);

  if (typeof fetchImplementation !== "function") {
    throw new TypeError("A fetch implementation is required to create a computerd client.");
  }

  async function getJson<T>(path: string, parser: (value: unknown) => T): Promise<T> {
    const response = await fetchImplementation(new URL(path, normalizedBaseUrl), {
      method: "GET",
    });
    return await parseJsonResponse(response, parser);
  }

  async function postJson<T>(
    path: string,
    payload: unknown,
    parser: (value: unknown) => T,
  ): Promise<T> {
    const response = await fetchImplementation(new URL(path, normalizedBaseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return await parseJsonResponse(response, parser);
  }

  return {
    baseUrl: normalizedBaseUrl.toString(),
    async getComputer(name: string): Promise<ComputerDetail> {
      return await getJson(`/api/computers/${encodeURIComponent(name)}`, parseComputerDetail);
    },
    async createBrowserAutomationSession(name: string): Promise<ComputerAutomationSession> {
      return await postJson(
        `/api/computers/${encodeURIComponent(name)}/automation-sessions`,
        undefined,
        parseComputerAutomationSession,
      );
    },
    async createBrowserMonitorSession(name: string): Promise<ComputerMonitorSession> {
      return await postJson(
        `/api/computers/${encodeURIComponent(name)}/monitor-sessions`,
        undefined,
        parseComputerMonitorSession,
      );
    },
    async captureBrowserScreenshot(name: string): Promise<ComputerScreenshot> {
      return await postJson(
        `/api/computers/${encodeURIComponent(name)}/screenshots`,
        undefined,
        parseComputerScreenshot,
      );
    },
    async updateBrowserViewport(
      name: string,
      viewport: { width: number; height: number },
    ): Promise<ComputerDetail> {
      return await postJson(
        `/api/computers/${encodeURIComponent(name)}/viewport`,
        viewport,
        parseComputerDetail,
      );
    },
    resolveWebSocketUrl(input: string | { connect: ComputerSessionConnect }): string {
      const connect = typeof input === "string" ? inferConnectDescriptor(input) : input.connect;
      return resolveWebSocketUrl(normalizedBaseUrl, connect);
    },
    async connectPlaywright(
      name: string,
      options: ConnectPlaywrightOptions = {},
    ): Promise<Browser> {
      const session = await this.createBrowserAutomationSession(name);
      const websocketUrl = this.resolveWebSocketUrl(session);
      const connectOverCDP = options.connectOverCDP ?? chromium.connectOverCDP.bind(chromium);
      return await connectOverCDP(websocketUrl, options.connectOptions);
    },
  };
}

export async function runBrowserCli({
  argv,
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
}: BrowserCliContext): Promise<number> {
  try {
    const parsed = parseCliArgs(argv, env);
    const client = createComputerdClient({ baseUrl: parsed.baseUrl });

    if (parsed.command === "browser-info") {
      const detail = await client.getComputer(parsed.name);
      ensureBrowserDetail(detail, parsed.name);
      stdout.write(formatBrowserInfo(detail));
      return 0;
    }

    if (parsed.command === "browser-connect") {
      const session = await client.createBrowserAutomationSession(parsed.name);
      const websocketUrl = client.resolveWebSocketUrl(session);
      stdout.write(`CDP websocket: ${websocketUrl}\n\n`);
      stdout.write(createPlaywrightSnippet(parsed.name, websocketUrl));
      return 0;
    }

    const screenshot = await client.captureBrowserScreenshot(parsed.name);
    const outputPath = parsed.outputPath ?? `${parsed.name}-screenshot.png`;
    await writeFile(outputPath, Buffer.from(screenshot.dataBase64, "base64"));
    stdout.write(`Saved screenshot to ${outputPath}\n`);
    stdout.write(`Captured ${screenshot.width}x${screenshot.height} at ${screenshot.capturedAt}\n`);
    return 0;
  } catch (error: unknown) {
    stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
}

function ensureBrowserDetail(
  detail: ComputerDetail,
  name: string,
): asserts detail is BrowserComputerDetail {
  if (detail.profile !== "browser") {
    throw new TypeError(`Computer ${name} is not a browser computer.`);
  }
}

function formatBrowserInfo(detail: ComputerDetail) {
  ensureBrowserDetail(detail, detail.name);

  const viewport = `${detail.runtime.display.viewport.width}x${detail.runtime.display.viewport.height}`;
  const lines = [
    `name: ${detail.name}`,
    `state: ${detail.state}`,
    `profile: ${detail.profile}`,
    `browser: ${detail.runtime.browser}`,
    `viewport: ${viewport}`,
    `profile directory: ${detail.runtime.profileDirectory}`,
    `runtime directory: ${detail.runtime.runtimeDirectory}`,
    `automation available: ${detail.runtime.automation.available}`,
    `screenshot available: ${detail.runtime.screenshot.available}`,
    `viewport update endpoint: /api/computers/${encodeURIComponent(detail.name)}/viewport`,
  ];

  return `${lines.join("\n")}\n`;
}

function createPlaywrightSnippet(name: string, websocketUrl: string) {
  return [
    'import { chromium } from "playwright";',
    "",
    "const browser = await chromium.connectOverCDP(",
    `  ${JSON.stringify(websocketUrl)},`,
    ");",
    `console.log("Attached to ${name}");`,
    "",
  ].join("\n");
}

function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv) {
  const args = [...argv];
  const command = args.shift();

  if (!command || command === "--help" || command === "-h") {
    throw new TypeError(createUsageText());
  }

  const baseUrl =
    readStringFlag(args, "--base-url") ?? env.COMPUTERD_BASE_URL ?? "http://127.0.0.1:3000";
  const outputPath = readStringFlag(args, "--out");
  const name = args.shift();

  if (!name) {
    throw new TypeError(createUsageText());
  }

  if (args.length > 0) {
    throw new TypeError(`Unexpected arguments: ${args.join(" ")}\n\n${createUsageText()}`);
  }

  if (
    command !== "browser-info" &&
    command !== "browser-connect" &&
    command !== "browser-screenshot"
  ) {
    throw new TypeError(`Unknown command: ${command}\n\n${createUsageText()}`);
  }

  return {
    baseUrl,
    command,
    name,
    outputPath,
  };
}

function readStringFlag(args: string[], flagName: string) {
  const index = args.indexOf(flagName);
  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value) {
    throw new TypeError(`Missing value for ${flagName}.`);
  }

  args.splice(index, 2);
  return value;
}

function createUsageText() {
  return [
    "Usage:",
    "  browser-info <name> [--base-url <url>]",
    "  browser-connect <name> [--base-url <url>]",
    "  browser-screenshot <name> [--base-url <url>] [--out <file>]",
  ].join("\n");
}

async function parseJsonResponse<T>(response: Response, parser: (value: unknown) => T): Promise<T> {
  const payload = await readResponsePayload(response);
  if (!response.ok) {
    throw new ComputerdHttpError({
      status: response.status,
      statusText: response.statusText,
      payload,
    });
  }

  return parser(payload);
}

async function readResponsePayload(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await response.json();
  }

  const text = await response.text();
  if (text.length === 0) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function createErrorMessage(status: number, statusText: string, payload: unknown) {
  const payloadMessage =
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string"
      ? payload.error
      : typeof payload === "string"
        ? payload
        : statusText;

  return `Computerd request failed (${status} ${statusText}): ${payloadMessage}`;
}

function inferConnectDescriptor(url: string): ComputerSessionConnect {
  if (url.startsWith("ws://") || url.startsWith("wss://")) {
    return {
      mode: "websocket-url",
      url,
    };
  }

  return {
    mode: "relative-websocket-path",
    url,
  };
}

function resolveWebSocketUrl(baseUrl: URL, connect: ComputerSessionConnect) {
  if (connect.mode === "websocket-url") {
    return connect.url;
  }

  const websocketBaseUrl = new URL(baseUrl);
  if (websocketBaseUrl.protocol === "http:") {
    websocketBaseUrl.protocol = "ws:";
  } else if (websocketBaseUrl.protocol === "https:") {
    websocketBaseUrl.protocol = "wss:";
  }

  return new URL(connect.url, websocketBaseUrl).toString();
}

function formatCliError(error: unknown) {
  if (error instanceof ComputerdHttpError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected error";
}
