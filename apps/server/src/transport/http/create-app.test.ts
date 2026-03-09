import { once } from "node:events";
import { createControlPlane } from "@computerd/control-plane";
import { afterEach, expect, test } from "vitest";
import { createApp } from "./create-app";

const servers: Array<ReturnType<typeof createApp>> = [];

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
});

test("serves computer and host unit APIs", async () => {
  const controlPlane = createControlPlane({ COMPUTERD_RUNTIME_MODE: "development" });
  const app = createApp({
    createConsoleSession: controlPlane.createConsoleSession,
    openConsoleAttach: controlPlane.openConsoleAttach,
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
              mode: "ticket",
              ticket: "stub-ticket",
            },
          }
        : await controlPlane.createMonitorSession(name),
    getComputer: controlPlane.getComputer,
    createComputer: controlPlane.createComputer,
    deleteComputer: controlPlane.deleteComputer,
    startComputer: controlPlane.startComputer,
    stopComputer: controlPlane.stopComputer,
    restartComputer: controlPlane.restartComputer,
    listHostUnits: controlPlane.listHostUnits,
    getHostUnit: controlPlane.getHostUnit,
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

  const consoleWsResponse = await fetch(`${baseUrl}/api/computers/starter-terminal/console/ws`);
  expect(consoleWsResponse.status).toBe(426);

  const monitorWsResponse = await fetch(`${baseUrl}/api/computers/research-browser/monitor/ws`);
  expect(monitorWsResponse.status).toBe(501);

  const deleteResponse = await fetch(`${baseUrl}/api/computers/lab-terminal`, {
    method: "DELETE",
  });
  expect(deleteResponse.status).toBe(204);
});
