import { expect, test } from "vitest";
import { createControlPlane, ComputerConflictError, ComputerNotFoundError } from "./index";

test("creates and manages a terminal computer", async () => {
  const controlPlane = createControlPlane();
  const created = await controlPlane.createComputer({
    name: "lab-terminal",
    profile: "terminal",
    runtime: {
      execStart: "/usr/bin/bash",
    },
  });

  expect(created.profile).toBe("terminal");
  expect(created.state).toBe("stopped");

  const started = await controlPlane.startComputer("lab-terminal");
  expect(started.state).toBe("running");

  const stopped = await controlPlane.stopComputer("lab-terminal");
  expect(stopped.state).toBe("stopped");
});

test("preserves browser computers as computer objects", async () => {
  const controlPlane = createControlPlane();
  await controlPlane.createComputer({
    name: "research-browser",
    profile: "browser",
    runtime: {
      browser: "chromium",
      persistentProfile: true,
      startUrl: "https://example.com",
    },
  });

  const list = await controlPlane.listComputers();
  expect(list).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "research-browser", profile: "browser" }),
    ]),
  );
});

test("returns lightweight host inspect objects", async () => {
  const controlPlane = createControlPlane();

  const hostUnits = await controlPlane.listHostUnits();
  const docker = await controlPlane.getHostUnit("docker.service");

  expect(hostUnits).toEqual(
    expect.arrayContaining([expect.objectContaining({ unitName: "docker.service" })]),
  );
  expect(docker.execStart).toContain("dockerd");
});

test("rejects duplicate names and unknown computers", async () => {
  const controlPlane = createControlPlane();
  await controlPlane.createComputer({
    name: "lab-terminal",
    profile: "terminal",
    runtime: {
      execStart: "/usr/bin/bash",
    },
  });

  await expect(
    controlPlane.createComputer({
      name: "lab-terminal",
      profile: "terminal",
      runtime: {
        execStart: "/usr/bin/bash",
      },
    }),
  ).rejects.toBeInstanceOf(ComputerConflictError);

  await expect(controlPlane.getComputer("missing")).rejects.toBeInstanceOf(ComputerNotFoundError);
});
