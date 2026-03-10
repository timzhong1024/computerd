import { once } from "node:events";
import { createControlPlane } from "@computerd/control-plane";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "./create-app";

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

test("serves computer and host unit APIs", async () => {
  const controlPlane = createControlPlane({ COMPUTERD_RUNTIME_MODE: "development" });
  const app = createApp({
    createAutomationSession: controlPlane.createAutomationSession,
    createConsoleSession: controlPlane.createConsoleSession,
    openConsoleAttach: controlPlane.openConsoleAttach,
    openAutomationAttach: controlPlane.openAutomationAttach,
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
      name: "lab-terminal",
      profile: "terminal",
      runtime: {
        execStart: "/usr/bin/bash",
      },
    }),
  });
  const created = await createResponse.json();

  expect(createResponse.status).toBe(201);
  expect(created).toMatchObject({
    name: "lab-terminal",
    profile: "terminal",
  });

  const listResponse = await fetch(`${baseUrl}/api/computers`);
  const list = await listResponse.json();
  expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ name: "lab-terminal" })]));

  const startResponse = await fetch(`${baseUrl}/api/computers/lab-terminal/start`, {
    method: "POST",
  });
  expect(startResponse.status).toBe(200);
  await expect(startResponse.json()).resolves.toMatchObject({
    state: "running",
  });

  const hostUnitsResponse = await fetch(`${baseUrl}/api/host-units`);
  expect(hostUnitsResponse.status).toBe(200);
  await expect(hostUnitsResponse.json()).resolves.toEqual(
    expect.arrayContaining([expect.objectContaining({ unitName: "docker.service" })]),
  );

  const monitorSessionResponse = await fetch(
    `${baseUrl}/api/computers/starter-terminal/monitor-sessions`,
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
    `${baseUrl}/api/computers/starter-terminal/console-sessions`,
    {
      method: "POST",
    },
  );
  expect(consoleSessionResponse.status).toBe(200);
  await expect(consoleSessionResponse.json()).resolves.toMatchObject({
    computerName: "starter-terminal",
    protocol: "ttyd",
  });

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

  const consoleWsResponse = await fetch(`${baseUrl}/api/computers/starter-terminal/console/ws`);
  expect(consoleWsResponse.status).toBe(426);

  const monitorWsResponse = await fetch(`${baseUrl}/api/computers/research-browser/monitor/ws`);
  expect(monitorWsResponse.status).toBe(426);

  const deleteResponse = await fetch(`${baseUrl}/api/computers/lab-terminal`, {
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
        path: "/api/computers/lab-terminal/start",
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
        path: "/api/computers/research-browser/monitor-sessions",
        statusCode: 200,
      }),
      expect.objectContaining({
        type: "http_request",
        method: "POST",
        path: "/api/computers/starter-terminal/console-sessions",
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
        path: "/api/computers/starter-terminal/console/ws",
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
        path: "/api/computers/lab-terminal",
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
        path: "/api/computers/starter-terminal/monitor-sessions",
      }),
      expect.objectContaining({
        type: "http_request_error",
        method: "POST",
        path: "/api/computers/research-browser/automation-sessions",
      }),
    ]),
  );
});
