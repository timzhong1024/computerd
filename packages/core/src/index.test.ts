import { expect, test } from "vitest";
import {
  createComputerCapabilities,
  parseComputerDetail,
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
