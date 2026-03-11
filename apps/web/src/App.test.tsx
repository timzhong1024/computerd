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
  profile: "host" | "browser" | "container";
  state: "stopped" | "running" | "broken";
  access?: Record<string, unknown>;
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
    command: "/usr/bin/dockerd",
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
      name: "starter-host",
      unitName: "computerd-starter-host.service",
      profile: "host",
      state: "stopped",
      runtime: {
        command: "/usr/bin/bash",
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
        runtimeUser: "computerd-b-research-browser",
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
        audio: {
          protocol: "pipewire",
          isolation: "host-pipewire-user",
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
        url.endsWith("/audio-sessions") &&
        method === "POST"
      ) {
        const name = decodeURIComponent(
          url.slice("/api/computers/".length, -"/audio-sessions".length),
        );
        return jsonResponse({
          computerName: name,
          protocol: "http-audio-stream",
          connect: {
            mode: "relative-websocket-path",
            url: `/api/computers/${encodeURIComponent(name)}/audio`,
          },
          authorization: {
            mode: "none",
          },
          mimeType: "audio/ogg",
        });
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

      if (url.startsWith("/api/computers/") && method === "DELETE") {
        const name = decodeURIComponent(url.slice("/api/computers/".length));
        computers = computers.filter((entry) => entry.name !== name);
        return jsonResponse(null, 204);
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
          runtime:
            body.profile === "browser"
              ? {
                  ...body.runtime,
                  runtimeUser: `computerd-b-${body.name}`,
                }
              : body.runtime,
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

  expect(await screen.findAllByText("starter-host")).toHaveLength(2);
  expect(await screen.findAllByText("docker.service")).toHaveLength(1);
  expect(
    screen.getByText("A computer control plane for homelab and agent workflows."),
  ).toBeInTheDocument();
  expect(await screen.findByText("computerd-starter-host.service")).toBeInTheDocument();

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

test("deletes a selected computer and refreshes the inventory", async () => {
  renderApp("/");

  fireEvent.click(await screen.findByRole("button", { name: /starter-host/i }));
  fireEvent.click(await screen.findByTestId("computer-action-delete"));

  await waitFor(() => {
    expect(screen.queryByRole("button", { name: /starter-host/i })).not.toBeInTheDocument();
  });
  expect(screen.getByRole("button", { name: /research-browser/i })).toBeInTheDocument();
});

test("renders monitor session shell and unavailable websocket state", async () => {
  const playSpy = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockRejectedValue(new DOMException("blocked", "NotAllowedError"));

  renderApp("/computers/research-browser/monitor");

  expect(await screen.findByTestId("novnc-shell")).toBeInTheDocument();
  expect(await screen.findByTestId("browser-audio")).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Enable audio" })).toBeInTheDocument();
  expect(await screen.findByTestId("monitor-state")).toHaveTextContent(
    "video unavailable / audio blocked by autoplay",
  );
  await waitFor(() => {
    expect(document.title).toBe("research-browser - Computerd Browser");
  });
  expect(connectMonitorClient).toHaveBeenCalled();
  playSpy.mockRestore();
});

test("retries blocked monitor audio after clicking enable audio", async () => {
  const playSpy = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"))
    .mockResolvedValueOnce(undefined);

  renderApp("/computers/research-browser/monitor");

  const button = await screen.findByRole("button", { name: "Enable audio" });
  fireEvent.click(button);

  await waitFor(() => {
    expect(screen.getByTestId("monitor-state")).toHaveTextContent(
      "video unavailable / audio connected",
    );
  });

  expect(playSpy).toHaveBeenCalledTimes(2);
  playSpy.mockRestore();
});

test("does not re-block audio after a manual enable click", async () => {
  const playSpy = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"))
    .mockResolvedValueOnce(undefined);

  renderApp("/computers/research-browser/monitor");

  const audio = (await screen.findByTestId("browser-audio")) as HTMLAudioElement;
  fireEvent.click(await screen.findByRole("button", { name: "Enable audio" }));
  fireEvent(audio, new Event("canplay"));

  await waitFor(() => {
    expect(screen.getByTestId("monitor-state")).toHaveTextContent(
      "video unavailable / audio connected",
    );
  });

  expect(playSpy).toHaveBeenCalledTimes(2);
  playSpy.mockRestore();
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
  renderApp("/computers/starter-host/console");

  expect(await screen.findByText("Console shell")).toBeInTheDocument();
  expect(await screen.findByTestId("console-shell")).toBeInTheDocument();
  expect(screen.getByTestId("console-state")).toHaveTextContent("connecting");
  expect(connectConsoleClient).toHaveBeenCalledWith(
    expect.objectContaining({
      computerName: "starter-host",
      onStateChange: expect.any(Function),
    }),
  );
});

test("shows exec shell without console link for exec-only containers", async () => {
  computers.unshift({
    name: "workspace-container",
    unitName: "docker:workspace-container",
    profile: "container",
    state: "running",
    access: {
      logs: true,
    },
    runtime: {
      provider: "docker",
      image: "ubuntu:24.04",
      command: "sleep infinity",
      containerId: "container-123",
      containerName: "workspace-container",
    },
  });

  renderApp("/");

  fireEvent.click(await screen.findByRole("button", { name: /workspace-container/i }));

  expect(await screen.findByTestId("open-exec-link")).toBeInTheDocument();
  expect(screen.queryByTestId("open-console-link")).not.toBeInTheDocument();
});

test("hides lifecycle and surface actions for broken computers", async () => {
  computers.unshift({
    name: "broken-container",
    unitName: "docker:broken-container",
    profile: "container",
    state: "broken",
    access: {
      console: {
        mode: "pty",
        writable: true,
      },
      logs: true,
    },
    runtime: {
      provider: "docker",
      image: "ubuntu:24.04",
      command: "sleep infinity",
      containerId: "missing-container",
      containerName: "broken-container",
    },
  });

  renderApp("/");

  fireEvent.click(await screen.findByRole("button", { name: /broken-container/i }));

  expect(await screen.findByTestId("computer-state")).toHaveTextContent("broken");
  expect(screen.queryByTestId("open-console-link")).not.toBeInTheDocument();
  expect(screen.queryByTestId("open-exec-link")).not.toBeInTheDocument();
  expect(screen.queryByTestId("computer-action-delete")).not.toBeInTheDocument();
  expect(screen.getByTestId("computer-action-start")).toBeDisabled();
  expect(screen.getByTestId("computer-action-stop")).toBeDisabled();
  expect(screen.getByTestId("computer-action-restart")).toBeDisabled();
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
      computer.access ??
      (computer.profile === "host"
        ? {
            console: {
              mode: "pty",
              writable: true,
            },
            logs: true,
          }
        : computer.profile === "container"
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
            }),
    capabilities: {
      canInspect: true,
      canStart: computer.state === "stopped",
      canStop: computer.state === "running",
      canRestart: computer.state === "running",
      consoleAvailable:
        computer.profile === "host" ||
        (computer.profile === "container" &&
          (computer.access?.console as { mode?: string } | undefined)?.mode === "pty"),
      browserAvailable: computer.profile === "browser",
      automationAvailable: computer.profile === "browser" && computer.state === "running",
      screenshotAvailable: computer.profile === "browser" && computer.state === "running",
      audioAvailable: computer.profile === "browser" && computer.state === "running",
    },
  };
}

function createComputerDetail(computer: FakeComputer) {
  const runtime =
    computer.profile === "browser"
      ? {
          browser: "chromium",
          persistentProfile: true,
          runtimeUser:
            (computer.runtime.runtimeUser as string | undefined) ?? `computerd-b-${computer.name}`,
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
          audio: {
            protocol: "pipewire",
            isolation: "host-pipewire-user",
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
