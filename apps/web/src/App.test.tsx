import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App";

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
  ];

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

test("renders computer inventory, host inspect, and details", async () => {
  render(<App />);

  expect(await screen.findAllByText("starter-terminal")).toHaveLength(2);
  expect(await screen.findAllByText("docker.service")).toHaveLength(1);
  expect(
    screen.getByText("A computer control plane for homelab and agent workflows."),
  ).toBeInTheDocument();
  expect(await screen.findByText("computerd-starter-terminal.service")).toBeInTheDocument();
});

test("creates a browser computer and refreshes inventory", async () => {
  render(<App />);

  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "research-browser" },
  });
  fireEvent.change(screen.getByLabelText("Profile"), {
    target: { value: "browser" },
  });
  fireEvent.change(screen.getByLabelText("Start URL"), {
    target: { value: "https://openai.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create computer" }));

  expect(await screen.findAllByText("research-browser")).toHaveLength(2);
  await waitFor(() => {
    expect(screen.getByText(/chromium -> https:\/\/openai.com/i)).toBeInTheDocument();
  });
});

test("surfaces runtime payload validation errors", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ name: "broken" }],
    }),
  );

  render(<App />);

  expect(await screen.findByRole("alert")).toHaveTextContent(/profile/i);
});

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
    },
  };
}

function createComputerDetail(computer: FakeComputer) {
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
    runtime: computer.runtime,
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
