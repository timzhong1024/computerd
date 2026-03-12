import { once } from "node:events";
import { createControlPlane } from "@computerd/control-plane";
import { BrokenComputerError } from "@computerd/control-plane";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp, createTerminalProcess } from "./create-app";

const servers: Array<ReturnType<typeof createApp>> = [];
let infoSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        }),
    ),
  );
  servers.length = 0;
  infoSpy.mockRestore();
  errorSpy.mockRestore();
});

test("createTerminalProcess uses raw pipes when lease disables pty", async () => {
  const terminal = createTerminalProcess({
    command: process.execPath,
    args: [
      "-e",
      [
        "process.stdout.write(String(Boolean(process.stdin.isTTY)))",
        "setTimeout(() => process.exit(0), 10)",
      ].join(";"),
    ],
    computerName: "vm-serial-smoke",
    pty: false,
    release() {},
  });

  let output = "";
  terminal.onData((data) => {
    output += data;
  });

  const exit = new Promise<void>((resolve) => {
    terminal.onExit(() => {
      resolve();
    });
  });

  await exit;
  expect(output).toContain("false");
});

test("serves computer and host unit APIs", async () => {
  const controlPlane = createControlPlane({ COMPUTERD_RUNTIME_MODE: "development" });
  const app = createApp({
    createAutomationSession: controlPlane.createAutomationSession,
    createAudioSession: controlPlane.createAudioSession,
    createConsoleSession: controlPlane.createConsoleSession,
    createExecSession: async (name) =>
      name === "workspace-container"
        ? {
            computerName: name,
            protocol: "ttyd",
            connect: {
              mode: "relative-websocket-path",
              url: `/api/computers/${encodeURIComponent(name)}/exec/ws`,
            },
            authorization: {
              mode: "none",
            },
          }
        : await controlPlane.createExecSession(name),
    openConsoleAttach: controlPlane.openConsoleAttach,
    openExecAttach: async (name) =>
      name === "workspace-container"
        ? {
            command: "docker",
            args: ["exec", "-it", "workspace-container", "/bin/sh"],
            computerName: name,
            release() {},
          }
        : await controlPlane.openExecAttach(name),
    openAutomationAttach: controlPlane.openAutomationAttach,
    openAudioStream: async (name) => ({
      computerName: name,
      command: "/bin/bash",
      args: ["-lc", "printf 'OggS-test-audio'"],
      targetSelector: `computerd.computer.name=${name}`,
      release() {},
    }),
    listComputers: controlPlane.listComputers,
    createMonitorSession: async (name) =>
      name === "research-browser"
        ? {
            computerName: name,
            protocol: "vnc",
            connect: {
              mode: "relative-websocket-path",
              url: `/api/computers/${encodeURIComponent(name)}/monitor/ws`,
            },
            authorization: {
              mode: "none",
            },
          }
        : await controlPlane.createMonitorSession(name),
    openMonitorAttach: controlPlane.openMonitorAttach,
    createScreenshot: controlPlane.createScreenshot,
    getComputer: controlPlane.getComputer,
    createComputer: controlPlane.createComputer,
    deleteComputer: controlPlane.deleteComputer,
    startComputer: controlPlane.startComputer,
    stopComputer: controlPlane.stopComputer,
    restartComputer: controlPlane.restartComputer,
    listHostUnits: controlPlane.listHostUnits,
    getHostUnit: controlPlane.getHostUnit,
    updateBrowserViewport: controlPlane.updateBrowserViewport,
  });

  servers.push(app);
  app.listen(0, "127.0.0.1");
  await once(app, "listening");

  const address = app.address();
  if (address === null || typeof address === "string") {
    throw new TypeError("Expected a TCP server address");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  const createResponse = await fetch(`${baseUrl}/api/computers`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "lab-host",
      profile: "host",
      runtime: {
        command: "/usr/bin/bash",
      },
    }),
  });
  const created = await createResponse.json();

  expect(createResponse.status).toBe(201);
  expect(created).toMatchObject({
    name: "lab-host",
    profile: "host",
  });

  const listResponse = await fetch(`${baseUrl}/api/computers`);
  const list = await listResponse.json();
  expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ name: "lab-host" })]));

  const startResponse = await fetch(`${baseUrl}/api/computers/lab-host/start`, {
    method: "POST",
  });
  expect(startResponse.status).toBe(200);
  await expect(startResponse.json()).resolves.toMatchObject({
    state: "running",
  });

  const createVmResponse = await fetch(`${baseUrl}/api/computers`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "vm-smoke",
      profile: "vm",
      runtime: {
        hypervisor: "qemu",
        nics: [
          {
            name: "primary",
            ipv4: {
              type: "dhcp",
            },
            ipv6: {
              type: "disabled",
            },
          },
        ],
        source: {
          kind: "qcow2",
          baseImagePath: "/images/ubuntu-cloud.qcow2",
          cloudInit: {
            user: "ubuntu",
          },
        },
      },
    }),
  });
  expect(createVmResponse.status).toBe(201);
  await expect(createVmResponse.json()).resolves.toMatchObject({
    name: "vm-smoke",
    profile: "vm",
  });

  await fetch(`${baseUrl}/api/computers/vm-smoke/start`, {
    method: "POST",
  });
  const vmMonitorSessionResponse = await fetch(
    `${baseUrl}/api/computers/vm-smoke/monitor-sessions`,
    {
      method: "POST",
    },
  );
  expect(vmMonitorSessionResponse.status).toBe(200);
  await expect(vmMonitorSessionResponse.json()).resolves.toMatchObject({
    computerName: "vm-smoke",
    protocol: "vnc",
  });

  const vmConsoleSessionResponse = await fetch(
    `${baseUrl}/api/computers/vm-smoke/console-sessions`,
    {
      method: "POST",
    },
  );
  expect(vmConsoleSessionResponse.status).toBe(200);
  await expect(vmConsoleSessionResponse.json()).resolves.toMatchObject({
    computerName: "vm-smoke",
    protocol: "ttyd",
  });

  const execSessionResponse = await fetch(
    `${baseUrl}/api/computers/workspace-container/exec-sessions`,
    {
      method: "POST",
    },
  );
  expect(execSessionResponse.status).toBe(200);
  await expect(execSessionResponse.json()).resolves.toMatchObject({
    computerName: "workspace-container",
    protocol: "ttyd",
    connect: {
      url: "/api/computers/workspace-container/exec/ws",
    },
  });

  const hostUnitsResponse = await fetch(`${baseUrl}/api/host-units`);
  expect(hostUnitsResponse.status).toBe(200);
  await expect(hostUnitsResponse.json()).resolves.toEqual(
    expect.arrayContaining([expect.objectContaining({ unitName: "docker.service" })]),
  );

  const monitorSessionResponse = await fetch(
    `${baseUrl}/api/computers/starter-host/monitor-sessions`,
    {
      method: "POST",
    },
  );
  expect(monitorSessionResponse.status).toBe(409);

  const supportedMonitorSessionResponse = await fetch(
    `${baseUrl}/api/computers/research-browser/monitor-sessions`,
    {
      method: "POST",
    },
  );
  expect(supportedMonitorSessionResponse.status).toBe(200);
  await expect(supportedMonitorSessionResponse.json()).resolves.toMatchObject({
    computerName: "research-browser",
    protocol: "vnc",
    connect: {
      mode: "relative-websocket-path",
      url: "/api/computers/research-browser/monitor/ws",
    },
  });

  const consoleSessionResponse = await fetch(
    `${baseUrl}/api/computers/starter-host/console-sessions`,
    {
      method: "POST",
    },
  );
  expect(consoleSessionResponse.status).toBe(200);
  await expect(consoleSessionResponse.json()).resolves.toMatchObject({
    computerName: "starter-host",
    protocol: "ttyd",
  });

  const audioSessionResponse = await fetch(
    `${baseUrl}/api/computers/research-browser/audio-sessions`,
    {
      method: "POST",
    },
  );
  expect(audioSessionResponse.status).toBe(409);

  const automationSessionResponse = await fetch(
    `${baseUrl}/api/computers/research-browser/automation-sessions`,
    {
      method: "POST",
    },
  );
  expect(automationSessionResponse.status).toBe(409);

  await fetch(`${baseUrl}/api/computers/research-browser/start`, {
    method: "POST",
  });

  const startedAutomationSessionResponse = await fetch(
    `${baseUrl}/api/computers/research-browser/automation-sessions`,
    {
      method: "POST",
    },
  );
  expect(startedAutomationSessionResponse.status).toBe(200);
  await expect(startedAutomationSessionResponse.json()).resolves.toMatchObject({
    computerName: "research-browser",
    protocol: "cdp",
  });

  const startedAudioSessionResponse = await fetch(
    `${baseUrl}/api/computers/research-browser/audio-sessions`,
    {
      method: "POST",
    },
  );
  expect(startedAudioSessionResponse.status).toBe(200);
  await expect(startedAudioSessionResponse.json()).resolves.toMatchObject({
    computerName: "research-browser",
    protocol: "http-audio-stream",
    mimeType: "audio/ogg",
  });

  const audioStreamResponse = await fetch(`${baseUrl}/api/computers/research-browser/audio`);
  expect(audioStreamResponse.status).toBe(200);
  expect(audioStreamResponse.headers.get("content-type")).toBe("audio/ogg");
  await expect(audioStreamResponse.text()).resolves.toContain("OggS");

  const screenshotResponse = await fetch(`${baseUrl}/api/computers/research-browser/screenshots`, {
    method: "POST",
  });
  expect(screenshotResponse.status).toBe(200);
  await expect(screenshotResponse.json()).resolves.toMatchObject({
    computerName: "research-browser",
    format: "png",
  });

  const viewportResponse = await fetch(`${baseUrl}/api/computers/research-browser/viewport`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      width: 1600,
      height: 1000,
    }),
  });
  expect(viewportResponse.status).toBe(200);
  await expect(viewportResponse.json()).resolves.toMatchObject({
    profile: "browser",
    runtime: {
      display: {
        viewport: {
          width: 1600,
          height: 1000,
        },
      },
    },
  });

  const consoleWsResponse = await fetch(`${baseUrl}/api/computers/starter-host/console/ws`);
  expect(consoleWsResponse.status).toBe(426);

  const monitorWsResponse = await fetch(`${baseUrl}/api/computers/research-browser/monitor/ws`);
  expect(monitorWsResponse.status).toBe(426);

  const deleteResponse = await fetch(`${baseUrl}/api/computers/lab-host`, {
    method: "DELETE",
  });
  expect(deleteResponse.status).toBe(204);

  const infoLogs = infoSpy.mock.calls
    .map((call: unknown[]) => call[0])
    .filter((value: unknown): value is string => typeof value === "string")
    .map((value: string) => JSON.parse(value) as Record<string, unknown>);

  expect(infoLogs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "http_request",
        method: "POST",
        path: "/api/computers",
        statusCode: 201,
      }),
      expect.objectContaining({
        type: "http_request",
        method: "GET",
        path: "/api/computers",
        statusCode: 200,
      }),
      expect.objectContaining({
        type: "http_request",
        method: "POST",
        path: "/api/computers/lab-host/start",
        statusCode: 200,
      }),
      expect.objectContaining({
        type: "http_request",
        method: "GET",
        path: "/api/host-units",
        statusCode: 200,
      }),
      expect.objectContaining({
        type: "http_request",
        method: "POST",
        path: "/api/computers/workspace-container/exec-sessions",
        statusCode: 200,
      }),
      expect.objectContaining({
        type: "http_request",
        method: "POST",
        path: "/api/computers/research-browser/monitor-sessions",
        statusCode: 200,
      }),
      expect.objectContaining({
        type: "http_request",
        method: "POST",
        path: "/api/computers/starter-host/console-sessions",
        statusCode: 200,
      }),
      expect.objectContaining({
        type: "http_request",
        method: "POST",
        path: "/api/computers/research-browser/audio-sessions",
        statusCode: 200,
      }),
      expect.objectContaining({
        type: "http_request",
        method: "POST",
        path: "/api/computers/research-browser/automation-sessions",
        statusCode: 200,
      }),
      expect.objectContaining({
        type: "http_request",
        method: "GET",
        path: "/api/computers/research-browser/audio",
        statusCode: 200,
      }),
      expect.objectContaining({
        type: "http_request",
        method: "POST",
        path: "/api/computers/research-browser/screenshots",
        statusCode: 200,
      }),
      expect.objectContaining({
        type: "http_request",
        method: "POST",
        path: "/api/computers/research-browser/viewport",
        statusCode: 200,
      }),
      expect.objectContaining({
        type: "http_request",
        method: "GET",
        path: "/api/computers/starter-host/console/ws",
        statusCode: 426,
      }),
      expect.objectContaining({
        type: "http_request",
        method: "GET",
        path: "/api/computers/research-browser/monitor/ws",
        statusCode: 426,
      }),
      expect.objectContaining({
        type: "http_request",
        method: "DELETE",
        path: "/api/computers/lab-host",
        statusCode: 204,
      }),
    ]),
  );

  const errorLogs = errorSpy.mock.calls
    .map((call: unknown[]) => call[0])
    .filter((value: unknown): value is string => typeof value === "string")
    .map((value: string) => JSON.parse(value) as Record<string, unknown>);

  expect(errorLogs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "http_request_error",
        method: "POST",
        path: "/api/computers/starter-host/monitor-sessions",
      }),
      expect.objectContaining({
        type: "http_request_error",
        method: "POST",
        path: "/api/computers/research-browser/audio-sessions",
      }),
      expect.objectContaining({
        type: "http_request_error",
        method: "POST",
        path: "/api/computers/research-browser/automation-sessions",
      }),
    ]),
  );
});

test("returns broken computers and blocks broken actions with conflict responses", async () => {
  const brokenDetail = {
    name: "broken-host",
    unitName: "computerd-broken-host.service",
    profile: "host" as const,
    state: "broken" as const,
    createdAt: "2026-03-09T08:00:00.000Z",
    access: {
      console: {
        mode: "pty" as const,
        writable: true,
      },
      logs: true,
    },
    capabilities: {
      canInspect: true,
      canStart: false,
      canStop: false,
      canRestart: false,
      consoleAvailable: true,
      browserAvailable: false,
      automationAvailable: false,
      screenshotAvailable: false,
      audioAvailable: false,
    },
    resources: {},
    storage: {
      rootMode: "persistent" as const,
    },
    network: {
      mode: "host" as const,
    },
    lifecycle: {},
    status: {
      lastActionAt: "2026-03-09T08:00:00.000Z",
      primaryUnit: "computerd-broken-host.service",
    },
    runtime: {
      command: "/usr/bin/bash",
    },
  };
  const brokenError = new BrokenComputerError(
    "broken-host",
    "Broken computers currently support inspect only.",
  );
  const app = createApp({
    createAutomationSession: async () => {
      throw brokenError;
    },
    createAudioSession: async () => {
      throw brokenError;
    },
    createConsoleSession: async () => {
      throw brokenError;
    },
    createExecSession: async () => {
      throw brokenError;
    },
    openConsoleAttach: async () => {
      throw brokenError;
    },
    openExecAttach: async () => {
      throw brokenError;
    },
    openAutomationAttach: async () => {
      throw brokenError;
    },
    openAudioStream: async () => {
      throw brokenError;
    },
    listComputers: async () => [brokenDetail],
    createMonitorSession: async () => {
      throw brokenError;
    },
    openMonitorAttach: async () => {
      throw brokenError;
    },
    createScreenshot: async () => {
      throw brokenError;
    },
    getComputer: async () => brokenDetail,
    createComputer: async () => brokenDetail,
    deleteComputer: async () => {
      throw brokenError;
    },
    startComputer: async () => {
      throw brokenError;
    },
    stopComputer: async () => {
      throw brokenError;
    },
    restartComputer: async () => {
      throw brokenError;
    },
    listHostUnits: async () => [],
    getHostUnit: async () => {
      throw new Error("not used");
    },
    updateBrowserViewport: async () => {
      throw brokenError;
    },
  });

  servers.push(app);
  app.listen(0, "127.0.0.1");
  await once(app, "listening");

  const address = app.address();
  if (address === null || typeof address === "string") {
    throw new TypeError("Expected a TCP server address");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  const listResponse = await fetch(`${baseUrl}/api/computers`);
  expect(listResponse.status).toBe(200);
  await expect(listResponse.json()).resolves.toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "broken-host", state: "broken" })]),
  );

  const detailResponse = await fetch(`${baseUrl}/api/computers/broken-host`);
  expect(detailResponse.status).toBe(200);
  await expect(detailResponse.json()).resolves.toMatchObject({
    name: "broken-host",
    state: "broken",
  });

  for (const path of [
    "/api/computers/broken-host/start",
    "/api/computers/broken-host/stop",
    "/api/computers/broken-host/restart",
    "/api/computers/broken-host",
    "/api/computers/broken-host/console-sessions",
  ]) {
    const method = path === "/api/computers/broken-host" ? "DELETE" : "POST";
    const response = await fetch(`${baseUrl}${path}`, { method });
    expect(response.status).toBe(409);
  }

  const websocketStubResponse = await fetch(`${baseUrl}/api/computers/broken-host/console/ws`);
  expect(websocketStubResponse.status).toBe(409);
});

test("serves container session APIs across stopped and running states", async () => {
  const controlPlane = createControlPlane({ COMPUTERD_RUNTIME_MODE: "development" });
  const app = createApp({
    createAutomationSession: controlPlane.createAutomationSession,
    createAudioSession: controlPlane.createAudioSession,
    createConsoleSession: controlPlane.createConsoleSession,
    createExecSession: controlPlane.createExecSession,
    openConsoleAttach: controlPlane.openConsoleAttach,
    openExecAttach: controlPlane.openExecAttach,
    openAutomationAttach: controlPlane.openAutomationAttach,
    openAudioStream: controlPlane.openAudioStream,
    listComputers: controlPlane.listComputers,
    createMonitorSession: controlPlane.createMonitorSession,
    openMonitorAttach: controlPlane.openMonitorAttach,
    createScreenshot: controlPlane.createScreenshot,
    getComputer: controlPlane.getComputer,
    createComputer: controlPlane.createComputer,
    deleteComputer: controlPlane.deleteComputer,
    startComputer: controlPlane.startComputer,
    stopComputer: controlPlane.stopComputer,
    restartComputer: controlPlane.restartComputer,
    listHostUnits: controlPlane.listHostUnits,
    getHostUnit: controlPlane.getHostUnit,
    updateBrowserViewport: controlPlane.updateBrowserViewport,
  });

  servers.push(app);
  app.listen(0, "127.0.0.1");
  await once(app, "listening");

  const address = app.address();
  if (address === null || typeof address === "string") {
    throw new TypeError("Expected a TCP server address");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  const createResponse = await fetch(`${baseUrl}/api/computers`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "workspace-container",
      profile: "container",
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
      },
    }),
  });

  expect(createResponse.status).toBe(201);
  await expect(createResponse.json()).resolves.toMatchObject({
    name: "workspace-container",
    profile: "container",
    unitName: "docker:workspace-container",
    runtime: {
      provider: "docker",
      image: "ubuntu:24.04",
    },
  });

  const stoppedConsoleResponse = await fetch(
    `${baseUrl}/api/computers/workspace-container/console-sessions`,
    {
      method: "POST",
    },
  );
  expect(stoppedConsoleResponse.status).toBe(409);
  await expect(stoppedConsoleResponse.json()).resolves.toMatchObject({
    error: 'Computer "workspace-container" must be running before opening console sessions.',
  });

  const stoppedExecResponse = await fetch(
    `${baseUrl}/api/computers/workspace-container/exec-sessions`,
    {
      method: "POST",
    },
  );
  expect(stoppedExecResponse.status).toBe(409);
  await expect(stoppedExecResponse.json()).resolves.toMatchObject({
    error: 'Computer "workspace-container" must be running before opening exec sessions.',
  });

  const startResponse = await fetch(`${baseUrl}/api/computers/workspace-container/start`, {
    method: "POST",
  });
  expect(startResponse.status).toBe(200);
  await expect(startResponse.json()).resolves.toMatchObject({
    state: "running",
  });

  const consoleSessionResponse = await fetch(
    `${baseUrl}/api/computers/workspace-container/console-sessions`,
    {
      method: "POST",
    },
  );
  expect(consoleSessionResponse.status).toBe(200);
  await expect(consoleSessionResponse.json()).resolves.toMatchObject({
    computerName: "workspace-container",
    protocol: "ttyd",
    connect: {
      url: "/api/computers/workspace-container/console/ws",
    },
  });

  const execSessionResponse = await fetch(
    `${baseUrl}/api/computers/workspace-container/exec-sessions`,
    {
      method: "POST",
    },
  );
  expect(execSessionResponse.status).toBe(200);
  await expect(execSessionResponse.json()).resolves.toMatchObject({
    computerName: "workspace-container",
    protocol: "ttyd",
    connect: {
      url: "/api/computers/workspace-container/exec/ws",
    },
  });

  const execWsResponse = await fetch(`${baseUrl}/api/computers/workspace-container/exec/ws`);
  expect(execWsResponse.status).toBe(426);

  const stopResponse = await fetch(`${baseUrl}/api/computers/workspace-container/stop`, {
    method: "POST",
  });
  expect(stopResponse.status).toBe(200);
  await expect(stopResponse.json()).resolves.toMatchObject({
    state: "stopped",
  });

  const deleteResponse = await fetch(`${baseUrl}/api/computers/workspace-container`, {
    method: "DELETE",
  });
  expect(deleteResponse.status).toBe(204);
});
