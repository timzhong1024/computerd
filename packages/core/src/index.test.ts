import { expect, test } from "vitest";
import {
  createComputerCapabilities,
  parseComputerAutomationSession,
  parseComputerAudioSession,
  parseComputerConsoleSession,
  parseComputerDetail,
  parseComputerSnapshots,
  parseComputerSummaries,
  parseComputerExecSession,
  parseComputerMonitorSession,
  parseComputerScreenshot,
  parseCreateComputerInput,
  parseCreateComputerSnapshotInput,
  parseCreateNetworkInput,
  parseHostUnitDetail,
  parseImportVmImageInput,
  parseRunDisplayActionsInput,
  parseRunDisplayActionsResult,
  parseResizeDisplayInput,
  parseRestoreComputerInput,
  parseVmGuestCommandInput,
  parseVmGuestCommandResult,
  parseVmGuestFileReadInput,
  parseVmGuestFileWriteInput,
} from "./index";

function createHostNetworkSummary(attachedComputerCount = 1) {
  return {
    id: "network-host",
    name: "Host network",
    kind: "host" as const,
    cidr: "192.168.250.0/24",
    status: {
      state: "healthy" as const,
      bridgeName: "br0",
    },
    gateway: {
      dhcp: {
        provider: "dnsmasq" as const,
        state: "unsupported" as const,
      },
      dns: {
        provider: "dnsmasq" as const,
        state: "unsupported" as const,
      },
      programmableGateway: {
        provider: null,
        state: "unsupported" as const,
      },
      health: {
        state: "healthy" as const,
        natState: "unsupported" as const,
      },
    },
    attachedComputerCount,
    deletable: false,
  };
}

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

test("parses network creation input with dns and programmable gateway providers", () => {
  const input = parseCreateNetworkInput({
    name: "isolated-secure",
    cidr: "192.168.252.0/24",
    gateway: {
      dns: {
        provider: "smartdns",
      },
      programmableGateway: {
        provider: "tailscale",
      },
    },
  });

  expect(input).toMatchObject({
    name: "isolated-secure",
    cidr: "192.168.252.0/24",
    gateway: {
      dns: {
        provider: "smartdns",
      },
      programmableGateway: {
        provider: "tailscale",
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

test("rejects invalid network create cidr input", () => {
  expect(() =>
    parseCreateNetworkInput({
      name: "bad-network",
      cidr: "abc",
    }),
  ).toThrow(/ipv4 cidr/i);

  expect(() =>
    parseCreateNetworkInput({
      name: "bad-network",
      cidr: "10.0.0.1/99",
    }),
  ).toThrow(/ipv4 cidr/i);
});

test("parses qcow2 vm computer creation input", () => {
  const input = parseCreateComputerInput({
    name: "linux-vm",
    profile: "vm",
    runtime: {
      hypervisor: "qemu",
      nics: [
        {
          name: "primary",
          ipv4: {
            type: "static",
            address: "192.168.250.10",
            prefixLength: 24,
          },
          ipv6: {
            type: "disabled",
          },
        },
      ],
      source: {
        kind: "qcow2",
        imageId: "filesystem-vm:ubuntu-cloud",
        cloudInit: {
          user: "ubuntu",
        },
      },
    },
  });

  expect(input).toMatchObject({
    profile: "vm",
    runtime: {
      nics: [
        {
          name: "primary",
          ipv4: {
            type: "static",
            address: "192.168.250.10",
            prefixLength: 24,
          },
        },
      ],
      source: {
        kind: "qcow2",
      },
    },
  });
});

test("parses qcow2 vm creation input with cloud-init explicitly disabled", () => {
  const input = parseCreateComputerInput({
    name: "linux-vm",
    profile: "vm",
    runtime: {
      hypervisor: "qemu",
      nics: [
        {
          name: "primary",
          ipv4: {
            type: "disabled",
          },
        },
      ],
      source: {
        kind: "qcow2",
        imageId: "filesystem-vm:ubuntu-cloud",
        cloudInit: {
          enabled: false,
        },
      },
    },
  });

  expect(input).toMatchObject({
    profile: "vm",
    runtime: {
      source: {
        kind: "qcow2",
        cloudInit: {
          enabled: false,
        },
      },
    },
  });
});

test("parses vm computer details", () => {
  const detail = parseComputerDetail({
    name: "linux-vm",
    unitName: "computerd-linux-vm.service",
    profile: "vm",
    state: "running",
    createdAt: "2026-03-09T08:00:00.000Z",
    access: {
      console: {
        mode: "pty",
        writable: true,
      },
      display: {
        mode: "vnc",
      },
      logs: true,
    },
    capabilities: createComputerCapabilities("vm", "running", {
      console: {
        mode: "pty",
        writable: true,
      },
      display: {
        mode: "vnc",
      },
    }),
    resources: {},
    storage: {
      rootMode: "persistent",
    },
    network: createHostNetworkSummary(),
    lifecycle: {},
    status: {
      lastActionAt: "2026-03-09T08:00:00.000Z",
      primaryUnit: "computerd-linux-vm.service",
    },
    runtime: {
      hypervisor: "qemu",
      accelerator: "kvm",
      architecture: "x86_64",
      machine: "q35",
      bridge: "br0",
      nics: [
        {
          name: "primary",
          macAddress: "52:54:00:12:34:56",
          ipConfigApplied: false,
          ipv4: {
            type: "static",
            address: "192.168.250.10",
            prefixLength: 24,
          },
          ipv6: {
            type: "disabled",
          },
        },
      ],
      source: {
        kind: "iso",
        imageId: "filesystem-vm:ubuntu-iso",
        path: "/images/ubuntu.iso",
        diskSizeGiB: 32,
      },
      diskImagePath: "/var/lib/computerd/computers/linux-vm/vm/disk.qcow2",
      serialSocketPath: "/run/computerd/computers/linux-vm/vm/serial.sock",
      vncDisplay: 14,
      vncPort: 5914,
      displayViewport: {
        width: 1440,
        height: 900,
      },
    },
  });

  expect(detail.profile).toBe("vm");
  if (detail.profile !== "vm") {
    throw new TypeError("Expected vm computer detail");
  }

  expect(detail.runtime.vncPort).toBe(5914);
  expect(detail.runtime.bridge).toBe("br0");
  expect(detail.runtime.nics[0]?.macAddress).toBe("52:54:00:12:34:56");
});

test("parses computer snapshots", () => {
  const snapshots = parseComputerSnapshots([
    {
      name: "checkpoint-1",
      createdAt: "2026-03-10T08:00:00.000Z",
      sizeBytes: 1024,
    },
  ]);

  expect(snapshots).toEqual([
    {
      name: "checkpoint-1",
      createdAt: "2026-03-10T08:00:00.000Z",
      sizeBytes: 1024,
    },
  ]);
});

test("parses vm image import input from file path", () => {
  expect(
    parseImportVmImageInput({
      source: {
        type: "file",
        path: "/images/ubuntu-cloud.qcow2",
      },
    }),
  ).toMatchObject({
    source: {
      type: "file",
      path: "/images/ubuntu-cloud.qcow2",
    },
  });
});

test("parses vm image import input from http url", () => {
  expect(
    parseImportVmImageInput({
      source: {
        type: "url",
        url: "https://example.com/ubuntu-cloud.qcow2",
      },
    }),
  ).toMatchObject({
    source: {
      type: "url",
      url: "https://example.com/ubuntu-cloud.qcow2",
    },
  });
});

test("parses create computer snapshot input", () => {
  const input = parseCreateComputerSnapshotInput({
    name: "checkpoint-1",
  });

  expect(input).toEqual({
    name: "checkpoint-1",
  });
});

test("parses restore computer input", () => {
  expect(
    parseRestoreComputerInput({
      target: "initial",
    }),
  ).toEqual({
    target: "initial",
  });

  expect(
    parseRestoreComputerInput({
      target: "snapshot",
      snapshotName: "checkpoint-1",
    }),
  ).toEqual({
    target: "snapshot",
    snapshotName: "checkpoint-1",
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
    network: createHostNetworkSummary(),
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
    network: createHostNetworkSummary(),
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
      network: createHostNetworkSummary(),
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
    network: createHostNetworkSummary(),
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

  expect(
    parseComputerScreenshot({
      computerName: "linux-vm",
      format: "jpeg",
      mimeType: "image/jpeg",
      capturedAt: "2026-03-09T08:00:00.000Z",
      width: 1440,
      height: 900,
      dataBase64: "c2NyZWVuc2hvdA==",
    }),
  ).toMatchObject({
    format: "jpeg",
    mimeType: "image/jpeg",
  });
});

test("parses display action execution input", () => {
  expect(
    parseRunDisplayActionsInput({
      computerName: "research-browser",
      ops: [
        {
          type: "mouse.move",
          x: 320,
          y: 240,
        },
        {
          type: "mouse.down",
          button: "left",
        },
        {
          type: "wait",
          ms: 150,
        },
        {
          type: "text.insert",
          text: "hello",
        },
      ],
    }),
  ).toMatchObject({
    computerName: "research-browser",
    observe: {
      screenshot: true,
    },
  });
});

test("rejects invalid display action execution input", () => {
  expect(() =>
    parseRunDisplayActionsInput({
      computerName: "research-browser",
      ops: [
        {
          type: "mouse.down",
          button: "primary",
        },
      ],
    }),
  ).toThrow(/left|middle|right/i);

  expect(() =>
    parseRunDisplayActionsInput({
      computerName: "research-browser",
      ops: [
        {
          type: "key.press",
          key: "",
        },
      ],
    }),
  ).toThrow(/>=1 characters/i);

  expect(() =>
    parseRunDisplayActionsInput({
      computerName: "research-browser",
      ops: [
        {
          type: "wait",
          ms: -1,
        },
      ],
    }),
  ).toThrow(/>=0/i);
});

test("parses display action execution results", () => {
  expect(
    parseRunDisplayActionsResult({
      computerName: "research-browser",
      completedOpCount: 3,
      viewport: {
        width: 1440,
        height: 900,
      },
      screenshot: {
        computerName: "research-browser",
        format: "png",
        mimeType: "image/png",
        capturedAt: "2026-03-17T08:00:00.000Z",
        width: 1440,
        height: 900,
        dataBase64: "c2NyZWVuc2hvdA==",
      },
      capturedAt: "2026-03-17T08:00:01.000Z",
    }),
  ).toMatchObject({
    completedOpCount: 3,
    viewport: {
      width: 1440,
      height: 900,
    },
  });
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

test("parses display resize input", () => {
  expect(
    parseResizeDisplayInput({
      width: 1600,
      height: 1000,
    }),
  ).toEqual({
    width: 1600,
    height: 1000,
  });
});

test("parses VM guest command input and result", () => {
  expect(
    parseVmGuestCommandInput({
      command: "echo ready",
      timeoutMs: 1_000,
    }),
  ).toEqual({
    command: "echo ready",
    shell: true,
    timeoutMs: 1_000,
    captureOutput: true,
  });

  expect(
    parseVmGuestCommandResult({
      exitCode: 0,
      stdout: "ready\n",
      stderr: "",
      timedOut: false,
      completedAt: "2026-03-17T08:00:00.000Z",
    }),
  ).toMatchObject({
    exitCode: 0,
    stdout: "ready\n",
  });
});

test("parses VM guest file read and write inputs", () => {
  expect(
    parseVmGuestFileReadInput({
      path: "/tmp/test.txt",
      maxBytes: 1024,
    }),
  ).toEqual({
    path: "/tmp/test.txt",
    maxBytes: 1024,
  });

  expect(
    parseVmGuestFileWriteInput({
      path: "/tmp/test.txt",
      dataBase64: Buffer.from("hello").toString("base64"),
    }),
  ).toEqual({
    path: "/tmp/test.txt",
    dataBase64: Buffer.from("hello").toString("base64"),
    createParents: false,
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
    createComputerCapabilities("vm", "running", {
      display: {
        mode: "vnc",
      },
      console: {
        mode: "pty",
        writable: true,
      },
    }),
  ).toMatchObject({
    consoleAvailable: true,
    browserAvailable: false,
    screenshotAvailable: true,
    audioAvailable: false,
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
