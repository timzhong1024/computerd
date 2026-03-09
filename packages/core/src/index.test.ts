import { expect, test } from "vitest";
import {
  createComputerCapabilities,
  parseComputerConsoleSession,
  parseComputerDetail,
  parseComputerMonitorSession,
  parseCreateComputerInput,
  parseHostUnitDetail,
} from "./index";

test("parses terminal computer creation input", () => {
  const input = parseCreateComputerInput({
    name: "lab-terminal",
    profile: "terminal",
    runtime: {
      execStart: "/usr/bin/bash",
      workingDirectory: "/workspace",
    },
  });

  expect(input).toMatchObject({
    name: "lab-terminal",
    profile: "terminal",
    runtime: {
      execStart: "/usr/bin/bash",
    },
  });
});

test("parses browser computer details", () => {
  const detail = parseComputerDetail({
    name: "research-browser",
    unitName: "computerd-research-browser.service",
    profile: "browser",
    state: "running",
    createdAt: "2026-03-09T08:00:00.000Z",
    access: {
      display: {
        mode: "virtual-display",
      },
      logs: true,
    },
    capabilities: createComputerCapabilities("browser", "running"),
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
      primaryUnit: "computerd-research-browser.service",
    },
    runtime: {
      browser: "chromium",
      persistentProfile: true,
      startUrl: "https://example.com",
    },
  });

  expect(detail.profile).toBe("browser");
  if (detail.profile !== "browser") {
    throw new TypeError("Expected browser computer detail");
  }

  expect(detail.runtime.browser).toBe("chromium");
});

test("parses computer monitor sessions", () => {
  const session = parseComputerMonitorSession({
    computerName: "research-browser",
    protocol: "vnc",
    connect: {
      mode: "relative-websocket-path",
      url: "/api/computers/research-browser/monitor/ws",
    },
    authorization: {
      mode: "ticket",
      ticket: "stub-ticket",
    },
    viewport: {
      width: 1440,
      height: 900,
    },
  });

  expect(session.protocol).toBe("vnc");
  expect(session.authorization).toEqual({
    mode: "ticket",
    ticket: "stub-ticket",
  });
});

test("parses computer console sessions", () => {
  const session = parseComputerConsoleSession({
    computerName: "starter-terminal",
    protocol: "ttyd",
    connect: {
      mode: "relative-websocket-path",
      url: "/api/computers/starter-terminal/console/ws",
    },
    authorization: {
      mode: "none",
    },
  });

  expect(session.protocol).toBe("ttyd");
  expect(session.authorization.mode).toBe("none");
});

test("rejects invalid session payloads", () => {
  expect(() =>
    parseComputerMonitorSession({
      computerName: "research-browser",
      protocol: "spice",
      connect: {
        mode: "relative-websocket-path",
        url: "/api/computers/research-browser/monitor/ws",
      },
      authorization: {
        mode: "ticket",
        ticket: "stub-ticket",
      },
    }),
  ).toThrow(/vnc/i);

  expect(() =>
    parseComputerConsoleSession({
      computerName: "starter-terminal",
      protocol: "ttyd",
      connect: {
        mode: "tcp",
        url: "/api/computers/starter-terminal/console/ws",
      },
      authorization: {
        mode: "none",
      },
    }),
  ).toThrow(/websocket-url|relative-websocket-path/i);
});

test("parses host unit detail payloads", () => {
  const detail = parseHostUnitDetail({
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
  });

  expect(detail.execStart).toContain("dockerd");
});

test("derives computer capabilities from profile and state", () => {
  expect(createComputerCapabilities("terminal", "stopped")).toEqual({
    canInspect: true,
    canStart: true,
    canStop: false,
    canRestart: false,
    consoleAvailable: true,
    browserAvailable: false,
  });
});
