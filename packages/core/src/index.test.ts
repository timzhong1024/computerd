import { expect, test } from "vitest";
import {
  createComputerCapabilities,
  parseComputerAutomationSession,
  parseComputerAudioSession,
  parseComputerConsoleSession,
  parseComputerDetail,
  parseComputerSummaries,
  parseComputerExecSession,
  parseComputerMonitorSession,
  parseComputerScreenshot,
  parseCreateComputerInput,
  parseHostUnitDetail,
  parseUpdateBrowserViewportInput,
} from "./index";

test("parses host computer creation input", () => {
  const input = parseCreateComputerInput({
    name: "lab-host",
    profile: "host",
    runtime: {
      command: "/usr/bin/bash",
      workingDirectory: "/workspace",
    },
  });

  expect(input).toMatchObject({
    name: "lab-host",
    profile: "host",
    runtime: {
      command: "/usr/bin/bash",
    },
  });
});

test("parses browser computer creation input with viewport", () => {
  const input = parseCreateComputerInput({
    name: "research-browser",
    profile: "browser",
    runtime: {
      browser: "chromium",
      persistentProfile: true,
      viewport: {
        width: 1280,
        height: 800,
      },
    },
  });

  expect(input).toMatchObject({
    profile: "browser",
    runtime: {
      viewport: {
        width: 1280,
        height: 800,
      },
    },
  });
});

test("parses container computer creation input", () => {
  const input = parseCreateComputerInput({
    name: "workspace-container",
    profile: "container",
    runtime: {
      provider: "docker",
      image: "ubuntu:24.04",
      command: "sleep infinity",
    },
  });

  expect(input).toMatchObject({
    profile: "container",
    runtime: {
      provider: "docker",
      image: "ubuntu:24.04",
      command: "sleep infinity",
    },
  });
});

test("parses container computer details", () => {
  const detail = parseComputerDetail({
    name: "workspace-container",
    unitName: "docker:workspace-container",
    profile: "container",
    state: "running",
    createdAt: "2026-03-09T08:00:00.000Z",
    access: {
      console: {
        mode: "pty",
        writable: true,
      },
      logs: true,
    },
    capabilities: createComputerCapabilities("container", "running", {
      console: {
        mode: "pty",
        writable: true,
      },
    }),
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
      primaryUnit: "docker:workspace-container",
    },
    runtime: {
      provider: "docker",
      image: "ubuntu:24.04",
      command: "sleep infinity",
      containerId: "abc123",
      containerName: "computerd-workspace-container",
    },
  });

  expect(detail.profile).toBe("container");
  if (detail.profile !== "container") {
    throw new TypeError("Expected container computer detail");
  }

  expect(detail.runtime.provider).toBe("docker");
  expect(detail.runtime.containerId).toBe("abc123");
});

test("parses broken computer details", () => {
  const detail = parseComputerDetail({
    name: "orphaned-host",
    unitName: "computerd-orphaned-host.service",
    profile: "host",
    state: "broken",
    createdAt: "2026-03-09T08:00:00.000Z",
    access: {
      console: {
        mode: "pty",
        writable: true,
      },
      logs: true,
    },
    capabilities: createComputerCapabilities("host", "broken", {
      console: {
        mode: "pty",
        writable: true,
      },
    }),
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
      primaryUnit: "computerd-orphaned-host.service",
    },
    runtime: {
      command: "/usr/bin/bash",
    },
  });

  expect(detail.state).toBe("broken");
  expect(detail.capabilities.canInspect).toBe(true);
  expect(detail.capabilities.canStart).toBe(false);
});

test("parses broken computer summaries", () => {
  const summaries = parseComputerSummaries([
    {
      name: "orphaned-browser",
      unitName: "computerd-orphaned-browser.service",
      profile: "browser",
      state: "broken",
      createdAt: "2026-03-09T08:00:00.000Z",
      access: {
        display: {
          mode: "virtual-display",
        },
        logs: true,
      },
      capabilities: createComputerCapabilities("browser", "broken"),
    },
  ]);

  expect(summaries[0]?.state).toBe("broken");
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
  });

  expect(detail.profile).toBe("browser");
  if (detail.profile !== "browser") {
    throw new TypeError("Expected browser computer detail");
  }

  expect(detail.runtime.browser).toBe("chromium");
  expect(detail.runtime.runtimeUser).toBe("computerd-b-research-browser");
  expect(detail.runtime.profileDirectory).toContain("research-browser");
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
      mode: "none",
    },
    viewport: {
      width: 1440,
      height: 900,
    },
  });

  expect(session.protocol).toBe("vnc");
  expect(session.authorization.mode).toBe("none");
});

test("parses computer automation sessions", () => {
  const session = parseComputerAutomationSession({
    computerName: "research-browser",
    protocol: "cdp",
    connect: {
      mode: "relative-websocket-path",
      url: "/api/computers/research-browser/automation/ws",
    },
    authorization: {
      mode: "none",
    },
  });

  expect(session.protocol).toBe("cdp");
  expect(session.authorization.mode).toBe("none");
});

test("parses computer audio sessions", () => {
  const session = parseComputerAudioSession({
    computerName: "research-browser",
    protocol: "http-audio-stream",
    connect: {
      mode: "relative-websocket-path",
      url: "/api/computers/research-browser/audio",
    },
    authorization: {
      mode: "none",
    },
    mimeType: "audio/ogg",
  });

  expect(session.protocol).toBe("http-audio-stream");
  expect(session.mimeType).toBe("audio/ogg");
});

test("parses computer screenshots", () => {
  const screenshot = parseComputerScreenshot({
    computerName: "research-browser",
    format: "png",
    mimeType: "image/png",
    capturedAt: "2026-03-09T08:00:00.000Z",
    width: 1440,
    height: 900,
    dataBase64: "c2NyZWVuc2hvdA==",
  });

  expect(screenshot.mimeType).toBe("image/png");
  expect(screenshot.dataBase64).toBe("c2NyZWVuc2hvdA==");
});

test("parses computer console sessions", () => {
  const session = parseComputerConsoleSession({
    computerName: "starter-host",
    protocol: "ttyd",
    connect: {
      mode: "relative-websocket-path",
      url: "/api/computers/starter-host/console/ws",
    },
    authorization: {
      mode: "none",
    },
  });

  expect(session.protocol).toBe("ttyd");
  expect(session.authorization.mode).toBe("none");
});

test("parses computer exec sessions", () => {
  const session = parseComputerExecSession({
    computerName: "workspace-container",
    protocol: "ttyd",
    connect: {
      mode: "relative-websocket-path",
      url: "/api/computers/workspace-container/exec/ws",
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
      computerName: "starter-host",
      protocol: "ttyd",
      connect: {
        mode: "tcp",
        url: "/api/computers/starter-host/console/ws",
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

test("parses browser viewport updates", () => {
  expect(
    parseUpdateBrowserViewportInput({
      width: 1600,
      height: 1000,
    }),
  ).toEqual({
    width: 1600,
    height: 1000,
  });
});

test("derives computer capabilities from profile and state", () => {
  expect(
    createComputerCapabilities("host", "stopped", {
      console: {
        mode: "pty",
        writable: true,
      },
    }),
  ).toEqual({
    canInspect: true,
    canStart: true,
    canStop: false,
    canRestart: false,
    consoleAvailable: true,
    browserAvailable: false,
    automationAvailable: false,
    screenshotAvailable: false,
    audioAvailable: false,
  });

  expect(createComputerCapabilities("browser", "running")).toEqual({
    canInspect: true,
    canStart: false,
    canStop: true,
    canRestart: true,
    consoleAvailable: false,
    browserAvailable: true,
    automationAvailable: true,
    screenshotAvailable: true,
    audioAvailable: true,
  });

  expect(
    createComputerCapabilities("container", "running", {
      console: {
        mode: "pty",
        writable: true,
      },
    }),
  ).toMatchObject({
    consoleAvailable: true,
    browserAvailable: false,
  });

  expect(
    createComputerCapabilities("host", "broken", {
      console: {
        mode: "pty",
        writable: true,
      },
    }),
  ).toEqual({
    canInspect: true,
    canStart: false,
    canStop: false,
    canRestart: false,
    consoleAvailable: true,
    browserAvailable: false,
    automationAvailable: false,
    screenshotAvailable: false,
    audioAvailable: false,
  });
});
