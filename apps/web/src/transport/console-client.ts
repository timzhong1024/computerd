import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { createConsoleSession } from "./computer-sessions";

export interface ConsoleClientHandle {
  dispose: () => void;
}

export type ConsoleConnectionState = "connecting" | "connected" | "disconnected" | "error";

interface ConnectConsoleClientOptions {
  computerName: string;
  onError?: (message: string) => void;
  onStateChange?: (state: ConsoleConnectionState) => void;
  target: HTMLDivElement;
}

export function connectConsoleClient({
  computerName,
  onError,
  onStateChange,
  target,
}: ConnectConsoleClientOptions): ConsoleClientHandle {
  const terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: '"IBM Plex Mono", "SFMono-Regular", monospace',
    fontSize: 13,
    theme: {
      background: "#11161a",
      foreground: "#edf3ef",
      cursor: "#f7c47a",
      black: "#11161a",
      brightBlack: "#53605b",
      green: "#6fcf97",
      brightGreen: "#94f0b8",
      red: "#ff7a7a",
      brightRed: "#ff9b9b",
      yellow: "#f7c47a",
      brightYellow: "#ffd9a1",
    },
  });
  const fitAddon = new FitAddon();

  terminal.loadAddon(fitAddon);
  terminal.open(target);
  fitAddon.fit();

  terminal.writeln(`computerd console shell prepared for ${computerName}`);
  terminal.writeln("");
  terminal.writeln("$ requesting console session");

  let websocket: WebSocket | null = null;
  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
    if (websocket?.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
    }
  });
  resizeObserver.observe(target);
  let disposed = false;
  let state: ConsoleConnectionState | null = null;
  const disposeInput = terminal.onData((data) => {
    if (websocket?.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({ type: "input", data }));
    }
  });

  updateState("connecting");
  void connect();

  return {
    dispose() {
      disposed = true;
      websocket?.close();
      disposeInput.dispose();
      resizeObserver.disconnect();
      terminal.dispose();
      target.replaceChildren();
    },
  };

  function updateState(nextState: ConsoleConnectionState) {
    if (disposed || state === nextState) {
      return;
    }

    state = nextState;
    onStateChange?.(nextState);
  }

  function reportError(message: string) {
    if (disposed) {
      return;
    }

    terminal.writeln(`$ error: ${message}`);
    onError?.(message);
    updateState("error");
  }

  async function connect() {
    try {
      const session = await createConsoleSession(computerName);
      if (disposed) {
        return;
      }

      websocket = new WebSocket(buildConsoleWebSocketUrl(session));
      websocket.addEventListener("open", () => {
        terminal.focus();
        websocket?.send(
          JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }),
        );
      });
      websocket.addEventListener("message", (event) => {
        const payload = parseConsoleWireMessage(String(event.data));
        if (!payload) {
          return;
        }

        if (payload.type === "ready") {
          terminal.writeln("$ console attached");
          terminal.focus();
          updateState("connected");
          return;
        }

        if (payload.type === "output") {
          terminal.write(payload.data);
          return;
        }

        if (payload.type === "exit") {
          terminal.writeln("");
          terminal.writeln(`$ session exited (${payload.exitCode ?? "unknown"})`);
          updateState("disconnected");
          websocket?.close();
          return;
        }

        if (payload.type === "error") {
          reportError(payload.message);
        }
      });
      websocket.addEventListener("close", () => {
        if (state !== "error") {
          updateState("disconnected");
        }
      });
      websocket.addEventListener("error", () => {
        reportError("Console websocket connection failed.");
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Console session request failed.";
      reportError(message);
    }
  }
}

function buildConsoleWebSocketUrl(session: Awaited<ReturnType<typeof createConsoleSession>>) {
  const baseUrl =
    session.connect.mode === "websocket-url"
      ? new URL(session.connect.url)
      : new URL(session.connect.url, toWebSocketOrigin(window.location));

  if (session.authorization.mode === "ticket") {
    baseUrl.searchParams.set("ticket", session.authorization.ticket);
  }

  return baseUrl.toString();
}

function toWebSocketOrigin(location: Location) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}`;
}

function parseConsoleWireMessage(value: string) {
  try {
    const payload = JSON.parse(value) as
      | { type: "ready" }
      | { type: "output"; data: string }
      | { type: "exit"; exitCode?: number }
      | { type: "error"; message: string };
    if (payload.type === "ready") {
      return payload;
    }
    if (payload.type === "output" && typeof payload.data === "string") {
      return payload;
    }
    if (payload.type === "exit") {
      return payload;
    }
    if (payload.type === "error" && typeof payload.message === "string") {
      return payload;
    }
  } catch {
    return null;
  }

  return null;
}
