import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryHistory } from "@tanstack/react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { connectConsoleClient } from "./transport/console-client";
import { connectMonitorClient } from "./transport/monitor-client";

vi.mock("./transport/monitor-client", () => ({
  connectMonitorClient: vi.fn((_options: { onStateChange: (state: string) => void }) => ({
    dispose: vi.fn(),
  })),
}));

vi.mock("./transport/console-client", () => ({
  connectConsoleClient: vi.fn(() => ({
    dispose: vi.fn(),
  })),
}));

interface FakeComputer {
  name: string;
  unitName: string;
  profile: "terminal" | "browser";
  state: "stopped" | "running";
  runtime: Record<string, unknown>;
}

const hostUnits = [
  {
    unitName: "docker.service",
    unitType: "service",
    state: "active",
    description: "Docker Engine",
    capabilities: {
      canInspect: true,
    },
    execStart: "/usr/bin/dockerd",
    status: {
      activeState: "active",
      subState: "running",
      loadState: "loaded",
    },
    recentLogs: ["dockerd started"],
  },
];

let computers: FakeComputer[];
let openSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  computers = [
    {
      name: "starter-terminal",
      unitName: "computerd-starter-terminal.service",
      profile: "terminal",
      state: "stopped",
      runtime: {
        execStart: "/usr/bin/bash",
      },
    },
    {
      name: "research-browser",
      unitName: "computerd-research-browser.service",
      profile: "browser",
      state: "running",
      runtime: {
        browser: "chromium",
        persistentProfile: true,
        profileDirectory: "/var/lib/computerd/computers/research-browser/profile",
        runtimeDirectory: "/run/computerd/computers/research-browser",
        display: {
          protocol: "x11",
          mode: "virtual-display",
          viewport: {
            width: 1440,
            height: 900,
          },
        },
        automation: {
          protocol: "cdp",
          available: true,
        },
        screenshot: {
          format: "png",
          available: true,
        },
      },
    },
  ];

  vi.mocked(connectMonitorClient).mockReset();
  vi.mocked(connectMonitorClient).mockImplementation(
    ({ onStateChange }: { onStateChange: (state: "connected" | "unavailable") => void }) => {
      onStateChange("unavailable");
      return {
        dispose: vi.fn(),
      };
    },
  );
  vi.mocked(connectConsoleClient).mockReset();
  vi.mocked(connectConsoleClient).mockImplementation(() => ({
    dispose: vi.fn(),
  }));
  openSpy = vi.fn(() => ({ focus: vi.fn() }));
  vi.stubGlobal("open", openSpy);

  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";

      if (url === "/api/computers" && method === "GET") {
        return jsonResponse(computers.map((computer) => createComputerSummary(computer)));
      }

      if (url === "/api/host-units" && method === "GET") {
        return jsonResponse(
          hostUnits.map((unit) => ({
            unitName: unit.unitName,
            unitType: unit.unitType,
            state: unit.state,
            description: unit.description,
            capabilities: unit.capabilities,
          })),
        );
      }

      if (
        url.startsWith("/api/computers/") &&
        url.endsWith("/monitor-sessions") &&
        method === "POST"
      ) {
        const name = decodeURIComponent(
          url.slice("/api/computers/".length, -"/monitor-sessions".length),
        );
        return jsonResponse({
          computerName: name,
          protocol: "vnc",
          connect: {
            mode: "relative-websocket-path",
            url: `/api/computers/${encodeURIComponent(name)}/monitor/ws`,
          },
          authorization: {
            mode: "none",
          },
        });
      }

      if (
        url.startsWith("/api/computers/") &&
        url.endsWith("/console-sessions") &&
        method === "POST"
      ) {
        const name = decodeURIComponent(
          url.slice("/api/computers/".length, -"/console-sessions".length),
        );
        return jsonResponse({
          computerName: name,
          protocol: "ttyd",
          connect: {
            mode: "relative-websocket-path",
            url: `/api/computers/${encodeURIComponent(name)}/console/ws`,
          },
          authorization: {
            mode: "none",
          },
        });
      }

      if (
        url.startsWith("/api/computers/") &&
        url.endsWith("/automation-sessions") &&
        method === "POST"
      ) {
        const name = decodeURIComponent(
          url.slice("/api/computers/".length, -"/automation-sessions".length),
        );
        return jsonResponse({
          computerName: name,
          protocol: "cdp",
          connect: {
            mode: "relative-websocket-path",
            url: `/api/computers/${encodeURIComponent(name)}/automation/ws`,
          },
          authorization: {
            mode: "none",
          },
        });
      }

      if (url.startsWith("/api/computers/") && url.endsWith("/screenshots") && method === "POST") {
        const name = decodeURIComponent(
          url.slice("/api/computers/".length, -"/screenshots".length),
        );
        return jsonResponse({
          computerName: name,
          format: "png",
          mimeType: "image/png",
          capturedAt: "2026-03-09T08:00:00.000Z",
          width: 1440,
          height: 900,
          dataBase64: "c2NyZWVuc2hvdA==",
        });
      }

      if (url.startsWith("/api/computers/") && method === "GET") {
        const name = decodeURIComponent(url.slice("/api/computers/".length));
        const computer = computers.find((entry) => entry.name === name);
        return jsonResponse(createComputerDetail(computer ?? computers[0]!));
      }

      if (url.startsWith("/api/host-units/") && method === "GET") {
        return jsonResponse(hostUnits[0]);
      }

      if (url === "/api/computers" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        const nextComputer: FakeComputer = {
          name: body.name,
          unitName: `computerd-${body.name}.service`,
          profile: body.profile,
          state: "stopped",
          runtime: body.runtime,
        };
        computers = [...computers, nextComputer];
        return jsonResponse(createComputerDetail(nextComputer), 201);
      }

      const actionMatch = /^\/api\/computers\/(?<name>[^/]+)\/(?<action>start|stop|restart)$/.exec(
        url,
      );
      if (actionMatch?.groups) {
        const computer = computers.find((entry) => entry.name === actionMatch.groups?.name);
        if (computer === undefined) {
          return jsonResponse({ error: "missing" }, 404);
        }

        computer.state = actionMatch.groups.action === "stop" ? "stopped" : "running";
        return jsonResponse(createComputerDetail(computer));
      }

      return jsonResponse({ error: `Unhandled request ${method} ${url}` }, 500);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("renders computer inventory, host inspect, and monitor action links", async () => {
  renderApp("/");

  expect(await screen.findAllByText("starter-terminal")).toHaveLength(2);
  expect(await screen.findAllByText("docker.service")).toHaveLength(1);
  expect(
    screen.getByText("A computer control plane for homelab and agent workflows."),
  ).toBeInTheDocument();
  expect(await screen.findByText("computerd-starter-terminal.service")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /research-browser/i }));
  expect(await screen.findByTestId("open-monitor-link")).toHaveTextContent("Open browser");
  expect(screen.getByTestId("create-automation-session")).toBeEnabled();
  expect(screen.getByTestId("capture-screenshot")).toBeEnabled();
  expect(screen.queryByTestId("open-console-link")).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId("open-monitor-link"));
  expect(openSpy).toHaveBeenCalledWith(
    "/computers/research-browser/monitor",
    "computerd-browser-research-browser",
    expect.stringContaining("width=1472"),
  );
});

test("creates a browser computer and refreshes inventory", async () => {
  renderApp("/");

  fireEvent.change(await screen.findByLabelText("Name"), {
    target: { value: "lab-browser" },
  });
  fireEvent.change(screen.getByLabelText("Profile"), {
    target: { value: "browser" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create computer" }));

  expect(await screen.findAllByText("lab-browser")).toHaveLength(2);
  await waitFor(() => {
    expect(screen.getByText(/chromium · profile persistent/i)).toBeInTheDocument();
  });
});

test("renders monitor session shell and unavailable websocket state", async () => {
  renderApp("/computers/research-browser/monitor");

  expect(await screen.findByTestId("novnc-shell")).toBeInTheDocument();
  expect(await screen.findByTestId("monitor-state")).toHaveTextContent("websocket unavailable");
  await waitFor(() => {
    expect(document.title).toBe("research-browser - Computerd Browser");
  });
  expect(connectMonitorClient).toHaveBeenCalled();
});

test("creates browser automation sessions and screenshot previews from the detail page", async () => {
  renderApp("/");

  fireEvent.click(await screen.findByRole("button", { name: /research-browser/i }));
  fireEvent.click(await screen.findByTestId("create-automation-session"));
  expect(await screen.findByTestId("automation-connect-url")).toHaveTextContent(
    "/api/computers/research-browser/automation/ws",
  );

  fireEvent.click(screen.getByTestId("capture-screenshot"));
  expect(await screen.findByTestId("browser-screenshot-preview")).toHaveAttribute(
    "src",
    "data:image/png;base64,c2NyZWVuc2hvdA==",
  );
});

test("surfaces monitor session request failures", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/computers/missing/monitor-sessions") {
        return jsonResponse({ error: 'Computer "missing" was not found.' }, 404);
      }

      return jsonResponse({ error: `Unhandled request GET ${url}` }, 500);
    }),
  );

  renderApp("/computers/missing/monitor");

  expect(await screen.findByRole("alert")).toHaveTextContent(/missing/i);
});

test("renders console placeholder route", async () => {
  renderApp("/computers/starter-terminal/console");

  expect(await screen.findByText("Console shell")).toBeInTheDocument();
  expect(await screen.findByTestId("console-shell")).toBeInTheDocument();
  expect(screen.getByTestId("console-state")).toHaveTextContent("connecting");
  expect(connectConsoleClient).toHaveBeenCalledWith(
    expect.objectContaining({
      computerName: "starter-terminal",
      onStateChange: expect.any(Function),
    }),
  );
});

function renderApp(initialPath: string) {
  const history = createMemoryHistory({
    initialEntries: [initialPath],
  });

  return render(<App history={history} />);
}

function createComputerSummary(computer: FakeComputer) {
  return {
    name: computer.name,
    unitName: computer.unitName,
    profile: computer.profile,
    state: computer.state,
    createdAt: "2026-03-09T08:00:00.000Z",
    access:
      computer.profile === "terminal"
        ? {
            console: {
              mode: "pty",
              writable: true,
            },
            logs: true,
          }
        : {
            display: {
              mode: "virtual-display",
            },
            logs: true,
          },
    capabilities: {
      canInspect: true,
      canStart: computer.state === "stopped",
      canStop: computer.state === "running",
      canRestart: computer.state === "running",
      consoleAvailable: computer.profile === "terminal",
      browserAvailable: computer.profile === "browser",
      automationAvailable: computer.profile === "browser" && computer.state === "running",
      screenshotAvailable: computer.profile === "browser" && computer.state === "running",
    },
  };
}

function createComputerDetail(computer: FakeComputer) {
  const runtime =
    computer.profile === "browser"
      ? {
          browser: "chromium",
          persistentProfile: true,
          profileDirectory:
            (computer.runtime.profileDirectory as string | undefined) ??
            `/var/lib/computerd/computers/${computer.name}/profile`,
          runtimeDirectory:
            (computer.runtime.runtimeDirectory as string | undefined) ??
            `/run/computerd/computers/${computer.name}`,
          display: {
            protocol: "x11",
            mode: "virtual-display",
            viewport: {
              width: 1440,
              height: 900,
            },
          },
          automation: {
            protocol: "cdp",
            available: true,
          },
          screenshot: {
            format: "png",
            available: true,
          },
        }
      : computer.runtime;

  return {
    ...createComputerSummary(computer),
    resources: {},
    storage: {
      rootMode: "persistent",
    },
    network: {
      mode: "host",
    },
    lifecycle: {},
    status: {
      lastActionAt: "2026-03-09T08:00:00.000Z",
      primaryUnit: computer.unitName,
    },
    runtime,
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}
