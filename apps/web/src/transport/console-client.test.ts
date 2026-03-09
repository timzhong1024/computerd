import { beforeEach, expect, test, vi } from "vitest";
import { connectConsoleClient } from "./console-client";
import { createConsoleSession } from "./computer-sessions";

const fitMock = vi.fn();

interface FakeTerminalDataListener {
  dispose: () => void;
}

class FakeTerminal {
  cols = 80;
  rows = 24;
  writes: string[] = [];
  focus = vi.fn();
  open = vi.fn();
  loadAddon = vi.fn();
  dispose = vi.fn();
  onDataListener: ((data: string) => void) | null = null;

  writeln(value: string) {
    this.writes.push(`${value}\n`);
  }

  write(value: string) {
    this.writes.push(value);
  }

  onData(listener: (data: string) => void): FakeTerminalDataListener {
    this.onDataListener = listener;
    return {
      dispose: () => {
        this.onDataListener = null;
      },
    };
  }

  emitData(value: string) {
    this.onDataListener?.(value);
  }
}

class FakeResizeObserver {
  callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    fakeResizeObservers.push(this);
  }

  observe = vi.fn();
  disconnect = vi.fn();

  trigger() {
    this.callback([] as ResizeObserverEntry[], this as unknown as ResizeObserver);
  }
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  sentMessages: string[] = [];
  url: string;
  private listeners = new Map<string, Array<(event?: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    fakeSockets.push(this);
  }

  addEventListener(type: string, listener: (event?: unknown) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(value: string) {
    this.sentMessages.push(value);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close");
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open");
  }

  message(data: unknown) {
    this.dispatch("message", { data });
  }

  error() {
    this.dispatch("error");
  }

  private dispatch(type: string, event?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

let fakeResizeObservers: FakeResizeObserver[] = [];
let fakeSockets: FakeWebSocket[] = [];
let fakeTerminal: FakeTerminal;

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = fitMock;
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor() {
      fakeTerminal = new FakeTerminal();
      return fakeTerminal;
    }
  },
}));

vi.mock("./computer-sessions", () => ({
  createConsoleSession: vi.fn(),
}));

beforeEach(() => {
  fitMock.mockReset();
  fakeResizeObservers = [];
  fakeSockets = [];
  fakeTerminal = new FakeTerminal();
  vi.mocked(createConsoleSession).mockReset();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

test("connects xterm to websocket transport and reacts to session events", async () => {
  vi.mocked(createConsoleSession).mockResolvedValue({
    computerName: "starter-terminal",
    protocol: "ttyd",
    connect: {
      mode: "relative-websocket-path",
      url: "/api/computers/starter-terminal/console/ws",
    },
    authorization: {
      mode: "ticket",
      ticket: "attach-ticket",
    },
  });

  const target = document.createElement("div");
  const states: string[] = [];
  const errors: string[] = [];

  connectConsoleClient({
    computerName: "starter-terminal",
    onError: (message) => errors.push(message),
    onStateChange: (state) => states.push(state),
    target,
  });

  await Promise.resolve();

  expect(states).toEqual(["connecting"]);
  expect(fakeSockets).toHaveLength(1);
  expect(fakeSockets[0]?.url).toBe(
    "ws://localhost:3000/api/computers/starter-terminal/console/ws?ticket=attach-ticket",
  );

  fakeSockets[0]?.open();
  expect(fakeTerminal.focus).toHaveBeenCalled();
  expect(fakeSockets[0]?.sentMessages).toContain(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));

  fakeSockets[0]?.message(JSON.stringify({ type: "ready" }));
  expect(states).toEqual(["connecting", "connected"]);

  fakeTerminal.emitData("ls\r");
  expect(fakeSockets[0]?.sentMessages).toContain(JSON.stringify({ type: "input", data: "ls\r" }));

  fakeResizeObservers[0]?.trigger();
  expect(fitMock).toHaveBeenCalled();

  fakeSockets[0]?.message(JSON.stringify({ type: "output", data: "hello" }));
  fakeSockets[0]?.message(JSON.stringify({ type: "exit", exitCode: 0 }));

  expect(states).toEqual(["connecting", "connected", "disconnected"]);
  expect(errors).toEqual([]);
  expect(fakeTerminal.writes.join("")).toContain("hello");
  expect(fakeTerminal.writes.join("")).toContain("$ console attached");
  expect(fakeTerminal.writes.join("")).toContain("$ session exited (0)");
});

test("surfaces session request failures as terminal errors", async () => {
  vi.mocked(createConsoleSession).mockRejectedValue(new Error("console unavailable"));

  const target = document.createElement("div");
  const states: string[] = [];
  const errors: string[] = [];

  connectConsoleClient({
    computerName: "starter-terminal",
    onError: (message) => errors.push(message),
    onStateChange: (state) => states.push(state),
    target,
  });

  await Promise.resolve();
  await Promise.resolve();

  expect(states).toEqual(["connecting", "error"]);
  expect(errors).toEqual(["console unavailable"]);
  expect(fakeTerminal.writes.join("")).toContain("$ error: console unavailable");
});
