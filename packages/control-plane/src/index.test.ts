import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import type {
  ComputerMetadataStore,
  ComputerRuntimePort,
  PersistedComputer,
  PersistedHostComputer,
  PersistedVmComputer,
  UnitRuntimeState,
} from "./systemd/types";
import {
  BrokenComputerError,
  ComputerConsoleUnavailableError,
  ComputerConflictError,
  ComputerNotFoundError,
  UnsupportedComputerFeatureError,
  createControlPlane,
} from "./index";

test("creates and manages a host computer with persisted metadata", async () => {
  const metadataStore = createMemoryMetadataStore();
  const runtime = createMemoryRuntime("/tmp/computerd-test-terminals");
  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
      COMPUTERD_TERMINAL_RUNTIME_DIR: "/tmp/computerd-test-terminals",
    },
    { metadataStore, runtime },
  );

  const created = await controlPlane.createComputer({
    name: "lab-host",
    profile: "host",
    resources: {
      cpuWeight: 200,
      memoryMaxMiB: 512,
    },
    lifecycle: {
      autostart: true,
    },
    runtime: {
      command: "/usr/bin/bash",
      workingDirectory: "/workspace",
      environment: {
        FOO: "bar",
      },
    },
  });

  expect(created.profile).toBe("host");
  expect(created.state).toBe("stopped");
  expect(created.resources).toMatchObject({
    cpuWeight: 200,
    memoryMaxMiB: 512,
  });

  const started = await controlPlane.startComputer("lab-host");
  expect(started.state).toBe("running");

  const stopped = await controlPlane.stopComputer("lab-host");
  expect(stopped.state).toBe("stopped");

  const restarted = await controlPlane.restartComputer("lab-host");
  expect(restarted.state).toBe("running");

  const detail = await controlPlane.getComputer("lab-host");
  expect(detail.runtime).toMatchObject({
    command: "/usr/bin/bash",
    workingDirectory: "/workspace",
    environment: {
      FOO: "bar",
    },
  });

  const list = await controlPlane.listComputers();
  expect(list).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "lab-host", state: "running" })]),
  );
});

test("rejects vm create input with more than one nic", async () => {
  const controlPlane = createControlPlane({ COMPUTERD_RUNTIME_MODE: "development" });

  await expect(
    controlPlane.createComputer({
      name: "multi-nic-vm",
      profile: "vm",
      runtime: {
        hypervisor: "qemu",
        nics: [
          { name: "primary", ipv4: { type: "dhcp" } },
          { name: "secondary", ipv4: { type: "disabled" } },
        ],
        source: {
          kind: "qcow2",
          imageId: "filesystem-vm:dev-qcow2",
          cloudInit: {
            user: "ubuntu",
          },
        },
      },
    }),
  ).rejects.toBeInstanceOf(UnsupportedComputerFeatureError);
});

test("creates and manages a browser computer with persisted metadata", async () => {
  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
      COMPUTERD_BROWSER_RUNTIME_DIR: "/tmp/computerd-test-browsers",
      COMPUTERD_BROWSER_STATE_DIR: "/tmp/computerd-test-browser-state",
    },
    {
      metadataStore: createMemoryMetadataStore(),
      runtime: createMemoryRuntime("/tmp/computerd-test-terminals"),
    },
  );

  const created = await controlPlane.createComputer({
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

  expect(created.profile).toBe("browser");
  if (created.profile !== "browser") {
    throw new TypeError("Expected browser detail");
  }
  expect(created.runtime.browser).toBe("chromium");
  expect(created.runtime.profileDirectory).toContain("research-browser");
  expect(created.runtime.display.viewport).toEqual({
    width: 1280,
    height: 800,
  });
});

test("creates and manages a qcow2 vm computer with monitor and console support", async () => {
  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
      COMPUTERD_VM_RUNTIME_DIR: "/tmp/computerd-test-vms",
      COMPUTERD_VM_STATE_DIR: "/tmp/computerd-test-vm-state",
    },
    {
      imageProvider: createMemoryImageProvider(),
      metadataStore: createMemoryMetadataStore(),
      runtime: createMemoryRuntime("/tmp/computerd-test-terminals"),
    },
  );

  const created = await controlPlane.createComputer({
    name: "linux-vm",
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
        imageId: "filesystem-vm:dev-qcow2",
        cloudInit: {
          user: "ubuntu",
        },
      },
    },
  });

  expect(created.profile).toBe("vm");
  if (created.profile !== "vm") {
    throw new TypeError("Expected vm detail");
  }
  expect(created.runtime.hypervisor).toBe("qemu");

  await controlPlane.startComputer("linux-vm");
  await expect(controlPlane.createMonitorSession("linux-vm")).resolves.toMatchObject({
    computerName: "linux-vm",
    protocol: "vnc",
  });
  await expect(controlPlane.createConsoleSession("linux-vm")).resolves.toMatchObject({
    computerName: "linux-vm",
    protocol: "ttyd",
  });
});

test("prepares vm runtime before start and restart", async () => {
  const metadataStore = createMemoryMetadataStore();
  const vmRecord = createVmComputerRecord();
  await metadataStore.putComputer(vmRecord);

  const calls: string[] = [];
  const runtime: ComputerRuntimePort = {
    async createContainerComputer() {
      throw new Error("not implemented");
    },
    async createVmComputer() {
      throw new Error("not implemented");
    },
    async listVmSnapshots() {
      return [];
    },
    async createVmSnapshot() {
      throw new Error("not implemented");
    },
    async deleteVmSnapshot() {
      throw new Error("not implemented");
    },
    async restoreVmComputer() {
      throw new Error("not implemented");
    },
    async deleteBrowserRuntimeIdentity() {},
    async deleteContainerComputer() {},
    async deleteVmComputer() {},
    async ensureBrowserRuntimeIdentity() {},
    async prepareBrowserRuntime() {},
    async prepareVmRuntime(computer) {
      calls.push(`prepare:${computer.name}`);
    },
    async createAutomationSession() {
      throw new Error("not implemented");
    },
    async createAudioSession() {
      throw new Error("not implemented");
    },
    async createMonitorSession() {
      throw new Error("not implemented");
    },
    async createPersistentUnit() {
      throw new Error("not implemented");
    },
    async createScreenshot() {
      throw new Error("not implemented");
    },
    async deletePersistentUnit() {
      throw new Error("not implemented");
    },
    async getContainerRuntimeState() {
      return null;
    },
    async getRuntimeState(unitName) {
      return {
        unitName,
        unitType: "service",
        loadState: "loaded",
        activeState: "inactive",
        subState: "dead",
      };
    },
    async getHostUnit() {
      return null;
    },
    async listHostUnits() {
      return [];
    },
    async openAutomationAttach() {
      throw new Error("not implemented");
    },
    async openAudioStream() {
      throw new Error("not implemented");
    },
    async openMonitorAttach() {
      throw new Error("not implemented");
    },
    async restartUnit(unitName) {
      calls.push(`restart:${unitName}`);
      return {
        unitName,
        unitType: "service",
        loadState: "loaded",
        activeState: "active",
        subState: "running",
      };
    },
    async restartContainerComputer() {
      throw new Error("not implemented");
    },
    async startUnit(unitName) {
      calls.push(`start:${unitName}`);
      return {
        unitName,
        unitType: "service",
        loadState: "loaded",
        activeState: "active",
        subState: "running",
      };
    },
    async startContainerComputer() {
      throw new Error("not implemented");
    },
    async stopUnit() {
      throw new Error("not implemented");
    },
    async stopContainerComputer() {
      throw new Error("not implemented");
    },
    async updateBrowserViewport() {},
  };

  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
      COMPUTERD_TERMINAL_RUNTIME_DIR: "/tmp/computerd-test-terminals",
    },
    { metadataStore, runtime },
  );

  await controlPlane.startComputer("linux-vm");
  await controlPlane.restartComputer("linux-vm");

  expect(calls).toEqual([
    "prepare:linux-vm",
    "start:computerd-linux-vm.service",
    "prepare:linux-vm",
    "restart:computerd-linux-vm.service",
  ]);
});

test("vm detail preserves an explicit nic mac address", async () => {
  const controlPlane = createControlPlane({ COMPUTERD_RUNTIME_MODE: "development" });

  const created = await controlPlane.createComputer({
    name: "vm-explicit-mac",
    profile: "vm",
    runtime: {
      hypervisor: "qemu",
      nics: [
        {
          name: "primary",
          macAddress: "52:54:00:aa:bb:cc",
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
        imageId: "filesystem-vm:dev-qcow2",
        cloudInit: {
          user: "ubuntu",
        },
      },
    },
  });

  expect(created.profile).toBe("vm");
  if (created.profile !== "vm") {
    throw new TypeError("Expected vm detail");
  }

  expect(created.runtime.nics[0]?.macAddress).toBe("52:54:00:aa:bb:cc");
});

test("creates, lists, restores, and deletes vm snapshots", async () => {
  const metadataStore = createMemoryMetadataStore();
  const runtime = createMemoryRuntime("/tmp/computerd-test-terminals");
  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
      COMPUTERD_VM_RUNTIME_DIR: "/tmp/computerd-test-vm-runtime",
      COMPUTERD_VM_STATE_DIR: "/tmp/computerd-test-vm-state",
    },
    { imageProvider: createMemoryImageProvider(), metadataStore, runtime },
  );

  await controlPlane.createComputer({
    name: "linux-vm",
    profile: "vm",
    runtime: {
      hypervisor: "qemu",
      nics: [
        {
          name: "primary",
          ipv4: {
            type: "dhcp",
          },
        },
      ],
      source: {
        kind: "qcow2",
        imageId: "filesystem-vm:dev-qcow2",
        cloudInit: {
          user: "ubuntu",
        },
      },
    },
  });

  const snapshot = await controlPlane.createComputerSnapshot("linux-vm", {
    name: "checkpoint-1",
  });
  expect(snapshot.name).toBe("checkpoint-1");

  await expect(controlPlane.listComputerSnapshots("linux-vm")).resolves.toEqual([
    expect.objectContaining({
      name: "checkpoint-1",
      sizeBytes: 1024,
    }),
  ]);

  await expect(
    controlPlane.restoreComputer("linux-vm", {
      target: "snapshot",
      snapshotName: "checkpoint-1",
    }),
  ).resolves.toMatchObject({
    name: "linux-vm",
    profile: "vm",
  });

  await controlPlane.deleteComputerSnapshot("linux-vm", "checkpoint-1");
  await expect(controlPlane.listComputerSnapshots("linux-vm")).resolves.toEqual([]);
});

test("restores vm initial state for qcow2 and iso sources", async () => {
  const metadataStore = createMemoryMetadataStore();
  const runtime = createMemoryRuntime("/tmp/computerd-test-terminals");
  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
    },
    { imageProvider: createMemoryImageProvider(), metadataStore, runtime },
  );

  await controlPlane.createComputer({
    name: "qcow-vm",
    profile: "vm",
    runtime: {
      hypervisor: "qemu",
      nics: [{ name: "primary", ipv4: { type: "dhcp" } }],
      source: {
        kind: "qcow2",
        imageId: "filesystem-vm:dev-qcow2",
        cloudInit: { user: "ubuntu" },
      },
    },
  });
  await controlPlane.createComputer({
    name: "iso-vm",
    profile: "vm",
    runtime: {
      hypervisor: "qemu",
      nics: [{ name: "primary", ipv4: { type: "dhcp" } }],
      source: {
        kind: "iso",
        imageId: "filesystem-vm:dev-iso",
        diskSizeGiB: 64,
      },
    },
  });

  await expect(
    controlPlane.restoreComputer("qcow-vm", {
      target: "initial",
    }),
  ).resolves.toMatchObject({ name: "qcow-vm" });
  await expect(
    controlPlane.restoreComputer("iso-vm", {
      target: "initial",
    }),
  ).resolves.toMatchObject({ name: "iso-vm" });
});

test("rejects vm snapshot mutations while running", async () => {
  const metadataStore = createMemoryMetadataStore();
  const runtime = createMemoryRuntime("/tmp/computerd-test-terminals");
  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
    },
    { imageProvider: createMemoryImageProvider(), metadataStore, runtime },
  );

  await controlPlane.createComputer({
    name: "linux-vm",
    profile: "vm",
    runtime: {
      hypervisor: "qemu",
      nics: [{ name: "primary", ipv4: { type: "dhcp" } }],
      source: {
        kind: "qcow2",
        imageId: "filesystem-vm:dev-qcow2",
        cloudInit: { user: "ubuntu" },
      },
    },
  });
  await controlPlane.startComputer("linux-vm");

  await expect(
    controlPlane.createComputerSnapshot("linux-vm", {
      name: "checkpoint-1",
    }),
  ).rejects.toThrow(/must be stopped/i);
  await expect(
    controlPlane.restoreComputer("linux-vm", {
      target: "initial",
    }),
  ).rejects.toThrow(/must be stopped/i);
  await expect(controlPlane.deleteComputerSnapshot("linux-vm", "checkpoint-1")).rejects.toThrow(
    /must be stopped/i,
  );
});

test("rejects duplicate and missing vm snapshots", async () => {
  const metadataStore = createMemoryMetadataStore();
  const runtime = createMemoryRuntime("/tmp/computerd-test-terminals");
  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
    },
    { imageProvider: createMemoryImageProvider(), metadataStore, runtime },
  );

  await controlPlane.createComputer({
    name: "linux-vm",
    profile: "vm",
    runtime: {
      hypervisor: "qemu",
      nics: [{ name: "primary", ipv4: { type: "dhcp" } }],
      source: {
        kind: "qcow2",
        imageId: "filesystem-vm:dev-qcow2",
        cloudInit: { user: "ubuntu" },
      },
    },
  });

  await controlPlane.createComputerSnapshot("linux-vm", {
    name: "checkpoint-1",
  });

  await expect(
    controlPlane.createComputerSnapshot("linux-vm", {
      name: "checkpoint-1",
    }),
  ).rejects.toMatchObject({
    name: "ComputerSnapshotConflictError",
  });
  await expect(
    controlPlane.restoreComputer("linux-vm", {
      target: "snapshot",
      snapshotName: "missing",
    }),
  ).rejects.toMatchObject({
    name: "ComputerSnapshotNotFoundError",
  });
  await expect(controlPlane.deleteComputerSnapshot("linux-vm", "missing")).rejects.toMatchObject({
    name: "ComputerSnapshotNotFoundError",
  });
});

test("updates browser viewport and persists it across detail reads", async () => {
  const metadataStore = createMemoryMetadataStore();
  const runtime = createMemoryRuntime("/tmp/computerd-test-terminals");
  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
      COMPUTERD_BROWSER_RUNTIME_DIR: "/tmp/computerd-test-browsers",
      COMPUTERD_BROWSER_STATE_DIR: "/tmp/computerd-test-browser-state",
    },
    { metadataStore, runtime },
  );

  await controlPlane.createComputer({
    name: "research-browser",
    profile: "browser",
    runtime: {
      browser: "chromium",
      persistentProfile: true,
    },
  });

  const updated = await controlPlane.updateBrowserViewport("research-browser", {
    width: 1600,
    height: 1000,
  });

  expect(updated.profile).toBe("browser");
  if (updated.profile !== "browser") {
    throw new TypeError("Expected browser detail");
  }

  expect(updated.runtime.display.viewport).toEqual({
    width: 1600,
    height: 1000,
  });

  const detail = await controlPlane.getComputer("research-browser");
  expect(detail.profile).toBe("browser");
  if (detail.profile !== "browser") {
    throw new TypeError("Expected browser detail");
  }

  expect(detail.runtime.display.viewport).toEqual({
    width: 1600,
    height: 1000,
  });
});

test("deletes a running computer by stopping runtime and removing metadata", async () => {
  const metadataStore = createMemoryMetadataStore();
  const runtime = createMemoryRuntime("/tmp/computerd-test-terminals");
  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
      COMPUTERD_TERMINAL_RUNTIME_DIR: "/tmp/computerd-test-terminals",
    },
    { metadataStore, runtime },
  );

  await controlPlane.createComputer({
    name: "lab-host",
    profile: "host",
    runtime: {
      command: "/usr/bin/bash",
    },
  });
  await controlPlane.startComputer("lab-host");

  await controlPlane.deleteComputer("lab-host");

  await expect(controlPlane.getComputer("lab-host")).rejects.toBeInstanceOf(ComputerNotFoundError);
});

test("returns lightweight host inspect objects", async () => {
  const controlPlane = createControlPlane({ COMPUTERD_RUNTIME_MODE: "development" });

  const hostUnits = await controlPlane.listHostUnits();
  const docker = await controlPlane.getHostUnit("docker.service");

  expect(hostUnits).toEqual(
    expect.arrayContaining([expect.objectContaining({ unitName: "docker.service" })]),
  );
  expect(docker.execStart).toContain("dockerd");
});

test("development console sessions attach to a local bash shell without requiring running state", async () => {
  const controlPlane = createControlPlane({ COMPUTERD_RUNTIME_MODE: "development" });

  await expect(controlPlane.createConsoleSession("starter-host")).resolves.toMatchObject({
    computerName: "starter-host",
    protocol: "ttyd",
  });

  const lease = await controlPlane.openConsoleAttach("starter-host");
  expect(lease).toMatchObject({
    command: "/bin/bash",
    args: ["-i", "-l"],
    computerName: "starter-host",
  });
  lease.release();
});

test("development container console and exec sessions require a running container", async () => {
  const controlPlane = createControlPlane({ COMPUTERD_RUNTIME_MODE: "development" });

  await controlPlane.createComputer({
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
  });

  await expect(controlPlane.createConsoleSession("workspace-container")).rejects.toBeInstanceOf(
    UnsupportedComputerFeatureError,
  );
  await expect(controlPlane.createExecSession("workspace-container")).rejects.toBeInstanceOf(
    UnsupportedComputerFeatureError,
  );
  await expect(controlPlane.openConsoleAttach("workspace-container")).rejects.toBeInstanceOf(
    UnsupportedComputerFeatureError,
  );
  await expect(controlPlane.openExecAttach("workspace-container")).rejects.toBeInstanceOf(
    UnsupportedComputerFeatureError,
  );

  await controlPlane.startComputer("workspace-container");

  await expect(controlPlane.createConsoleSession("workspace-container")).resolves.toMatchObject({
    computerName: "workspace-container",
    protocol: "ttyd",
  });
  await expect(controlPlane.createExecSession("workspace-container")).resolves.toMatchObject({
    computerName: "workspace-container",
    protocol: "ttyd",
  });

  const consoleLease = await controlPlane.openConsoleAttach("workspace-container");
  expect(consoleLease).toMatchObject({
    command: "docker",
    args: ["attach", "development-workspace-container"],
    computerName: "workspace-container",
  });
  consoleLease.release();

  const execLease = await controlPlane.openExecAttach("workspace-container");
  expect(execLease).toMatchObject({
    command: "docker",
    args: ["exec", "-it", "development-workspace-container", "/bin/sh"],
    computerName: "workspace-container",
  });
  execLease.release();
});

test("development containers without console access still allow exec sessions", async () => {
  const controlPlane = createControlPlane({ COMPUTERD_RUNTIME_MODE: "development" });

  await controlPlane.createComputer({
    name: "exec-only-container",
    profile: "container",
    access: {
      logs: true,
    },
    runtime: {
      provider: "docker",
      image: "ubuntu:24.04",
      command: "sleep infinity",
    },
  });

  await expect(controlPlane.createConsoleSession("exec-only-container")).rejects.toBeInstanceOf(
    UnsupportedComputerFeatureError,
  );
  await expect(controlPlane.openConsoleAttach("exec-only-container")).rejects.toBeInstanceOf(
    UnsupportedComputerFeatureError,
  );
  await expect(controlPlane.createExecSession("exec-only-container")).rejects.toBeInstanceOf(
    UnsupportedComputerFeatureError,
  );
  await expect(controlPlane.openExecAttach("exec-only-container")).rejects.toBeInstanceOf(
    UnsupportedComputerFeatureError,
  );

  await controlPlane.startComputer("exec-only-container");

  await expect(controlPlane.createConsoleSession("exec-only-container")).rejects.toBeInstanceOf(
    UnsupportedComputerFeatureError,
  );
  await expect(controlPlane.openConsoleAttach("exec-only-container")).rejects.toBeInstanceOf(
    UnsupportedComputerFeatureError,
  );
  await expect(controlPlane.createExecSession("exec-only-container")).resolves.toMatchObject({
    computerName: "exec-only-container",
    protocol: "ttyd",
  });

  const execLease = await controlPlane.openExecAttach("exec-only-container");
  expect(execLease).toMatchObject({
    command: "docker",
    args: ["exec", "-it", "development-exec-only-container", "/bin/sh"],
    computerName: "exec-only-container",
  });
  execLease.release();
});

test("vm console attach uses node to bridge the serial socket", async () => {
  const controlPlane = createControlPlane({ COMPUTERD_RUNTIME_MODE: "development" });

  await expect(controlPlane.createConsoleSession("linux-vm")).resolves.toMatchObject({
    computerName: "linux-vm",
    protocol: "ttyd",
  });

  const lease = await controlPlane.openConsoleAttach("linux-vm");
  expect(lease).toMatchObject({
    command: process.execPath,
    computerName: "linux-vm",
  });
  expect(lease.args).toEqual(
    expect.arrayContaining([
      "-e",
      expect.stringContaining("node:net"),
      expect.stringContaining("/run/computerd/computers/linux-vm/vm/serial.sock"),
    ]),
  );
  expect(lease.pty).toBe(false);
  lease.release();
});

test("rejects exec sessions for non-container computers", async () => {
  const metadataStore = createMemoryMetadataStore();
  const runtime = createMemoryRuntime("/tmp/computerd-test-terminals");
  await metadataStore.putComputer(createHostComputerRecord());
  await metadataStore.putComputer(createBrowserComputerRecord());
  await runtime.createPersistentUnit(createHostComputerRecord());
  await runtime.createPersistentUnit(createBrowserComputerRecord());
  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
    },
    { metadataStore, runtime },
  );

  await expect(controlPlane.createExecSession("starter-host")).rejects.toBeInstanceOf(
    UnsupportedComputerFeatureError,
  );
  await expect(controlPlane.openExecAttach("starter-host")).rejects.toBeInstanceOf(
    UnsupportedComputerFeatureError,
  );
  await expect(controlPlane.createExecSession("research-browser")).rejects.toBeInstanceOf(
    UnsupportedComputerFeatureError,
  );
  await expect(controlPlane.openExecAttach("research-browser")).rejects.toBeInstanceOf(
    UnsupportedComputerFeatureError,
  );
});

test("rejects duplicate names and unknown computers", async () => {
  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
    },
    {
      metadataStore: createMemoryMetadataStore(),
      runtime: createMemoryRuntime("/tmp/computerd-test-terminals"),
    },
  );
  await controlPlane.createComputer({
    name: "lab-host",
    profile: "host",
    runtime: {
      command: "/usr/bin/bash",
    },
  });

  await expect(
    controlPlane.createComputer({
      name: "lab-host",
      profile: "host",
      runtime: {
        command: "/usr/bin/bash",
      },
    }),
  ).rejects.toBeInstanceOf(ComputerConflictError);

  await expect(controlPlane.getComputer("missing")).rejects.toBeInstanceOf(ComputerNotFoundError);
});

test("reports broken state for host, browser, and container computers whose runtime entity is missing", async () => {
  const metadataStore = createMemoryMetadataStore();
  await metadataStore.putComputer(createHostComputerRecord());
  await metadataStore.putComputer(createBrowserComputerRecord());
  await metadataStore.putComputer(createContainerComputerRecord());
  await metadataStore.putComputer(createVmComputerRecord());
  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
      COMPUTERD_TERMINAL_RUNTIME_DIR: "/tmp/computerd-test-terminals",
    },
    { metadataStore, runtime: createMemoryRuntime("/tmp/computerd-test-terminals") },
  );

  await expect(controlPlane.getComputer("starter-host")).resolves.toMatchObject({
    profile: "host",
    state: "broken",
  });
  await expect(controlPlane.getComputer("research-browser")).resolves.toMatchObject({
    profile: "browser",
    state: "broken",
  });
  await expect(controlPlane.getComputer("workspace-container")).resolves.toMatchObject({
    profile: "container",
    state: "broken",
  });
  await expect(controlPlane.getComputer("linux-vm")).resolves.toMatchObject({
    profile: "vm",
    state: "broken",
  });

  await expect(controlPlane.listComputers()).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "starter-host", state: "broken" }),
      expect.objectContaining({ name: "research-browser", state: "broken" }),
      expect.objectContaining({ name: "workspace-container", state: "broken" }),
      expect.objectContaining({ name: "linux-vm", state: "broken" }),
    ]),
  );
});

test("rejects lifecycle, delete, and session actions for broken computers", async () => {
  const metadataStore = createMemoryMetadataStore();
  await metadataStore.putComputer(createHostComputerRecord());
  await metadataStore.putComputer(createBrowserComputerRecord());
  await metadataStore.putComputer(createContainerComputerRecord());
  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
      COMPUTERD_TERMINAL_RUNTIME_DIR: "/tmp/computerd-test-terminals",
    },
    { metadataStore, runtime: createMemoryRuntime("/tmp/computerd-test-terminals") },
  );

  await expect(controlPlane.startComputer("starter-host")).rejects.toBeInstanceOf(
    BrokenComputerError,
  );
  await expect(controlPlane.stopComputer("research-browser")).rejects.toBeInstanceOf(
    BrokenComputerError,
  );
  await expect(controlPlane.restartComputer("workspace-container")).rejects.toBeInstanceOf(
    BrokenComputerError,
  );
  await expect(controlPlane.deleteComputer("workspace-container")).rejects.toBeInstanceOf(
    BrokenComputerError,
  );

  await expect(controlPlane.createConsoleSession("starter-host")).rejects.toBeInstanceOf(
    BrokenComputerError,
  );
  await expect(controlPlane.openConsoleAttach("starter-host")).rejects.toBeInstanceOf(
    BrokenComputerError,
  );
  await expect(controlPlane.createMonitorSession("research-browser")).rejects.toBeInstanceOf(
    BrokenComputerError,
  );
  await expect(controlPlane.createAudioSession("research-browser")).rejects.toBeInstanceOf(
    BrokenComputerError,
  );
  await expect(controlPlane.createAutomationSession("research-browser")).rejects.toBeInstanceOf(
    BrokenComputerError,
  );
  await expect(controlPlane.createScreenshot("research-browser")).rejects.toBeInstanceOf(
    BrokenComputerError,
  );
  await expect(controlPlane.createExecSession("workspace-container")).rejects.toBeInstanceOf(
    BrokenComputerError,
  );
  await expect(controlPlane.openExecAttach("workspace-container")).rejects.toBeInstanceOf(
    BrokenComputerError,
  );
});

test("creates browser automation, monitor, screenshot, and console sessions from seeded capabilities", async () => {
  const metadataStore = createMemoryMetadataStore();
  const runtime = createMemoryRuntime("/tmp/computerd-test-terminals");
  await metadataStore.putComputer(createBrowserComputerRecord());
  const terminalRecord = createHostComputerRecord();
  await metadataStore.putComputer(terminalRecord);
  await runtime.createPersistentUnit(createBrowserComputerRecord());
  await runtime.createPersistentUnit(terminalRecord);

  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
      COMPUTERD_TERMINAL_RUNTIME_DIR: "/tmp/computerd-test-terminals",
    },
    { metadataStore, runtime },
  );

  await controlPlane.startComputer("research-browser");
  const monitorSession = await controlPlane.createMonitorSession("research-browser");
  const audioSession = await controlPlane.createAudioSession("research-browser");
  const automationSession = await controlPlane.createAutomationSession("research-browser");
  const screenshot = await controlPlane.createScreenshot("research-browser");
  await controlPlane.startComputer("starter-host");
  await ensureSocket("/tmp/computerd-test-terminals", "starter-host");
  const consoleSession = await controlPlane.createConsoleSession("starter-host");

  expect(monitorSession).toMatchObject({
    computerName: "research-browser",
    protocol: "vnc",
    connect: {
      mode: "relative-websocket-path",
      url: "/api/computers/research-browser/monitor/ws",
    },
  });
  expect(automationSession).toMatchObject({
    computerName: "research-browser",
    protocol: "cdp",
    connect: {
      mode: "relative-websocket-path",
      url: "/api/computers/research-browser/automation/ws",
    },
  });
  expect(audioSession).toMatchObject({
    computerName: "research-browser",
    protocol: "http-audio-stream",
    connect: {
      mode: "relative-websocket-path",
      url: "/api/computers/research-browser/audio",
    },
    mimeType: "audio/ogg",
  });
  expect(screenshot).toMatchObject({
    computerName: "research-browser",
    format: "png",
    mimeType: "image/png",
  });
  expect(consoleSession).toMatchObject({
    computerName: "starter-host",
    protocol: "ttyd",
    connect: {
      mode: "relative-websocket-path",
      url: "/api/computers/starter-host/console/ws",
    },
  });
});

test("waits for host console runtime readiness during start", async () => {
  const metadataStore = createMemoryMetadataStore();
  const terminalRecord = createHostComputerRecord();
  await metadataStore.putComputer(terminalRecord);
  const runtimeDirectory = "/tmp/computerd-delayed-terminals";
  await cleanupSocket(runtimeDirectory, terminalRecord.name);

  const runtime: ComputerRuntimePort = {
    async createContainerComputer() {
      throw new Error("not implemented");
    },
    async createVmComputer() {
      throw new Error("not implemented");
    },
    async listVmSnapshots() {
      return [];
    },
    async createVmSnapshot() {
      throw new Error("not implemented");
    },
    async deleteVmSnapshot() {
      throw new Error("not implemented");
    },
    async restoreVmComputer() {
      throw new Error("not implemented");
    },
    async deleteBrowserRuntimeIdentity() {},
    async deleteContainerComputer() {},
    async deleteVmComputer() {},
    async ensureBrowserRuntimeIdentity() {},
    async prepareBrowserRuntime() {},
    async prepareVmRuntime() {},
    async createAutomationSession(computer) {
      return {
        computerName: computer.name,
        protocol: "cdp",
        connect: {
          mode: "relative-websocket-path",
          url: `/api/computers/${encodeURIComponent(computer.name)}/automation/ws`,
        },
        authorization: {
          mode: "none",
        },
      };
    },
    async createAudioSession(computer) {
      return {
        computerName: computer.name,
        protocol: "http-audio-stream",
        connect: {
          mode: "relative-websocket-path",
          url: `/api/computers/${encodeURIComponent(computer.name)}/audio`,
        },
        authorization: {
          mode: "none",
        },
        mimeType: "audio/ogg",
      };
    },
    async createMonitorSession(computer) {
      return {
        computerName: computer.name,
        protocol: "vnc",
        connect: {
          mode: "relative-websocket-path",
          url: `/api/computers/${encodeURIComponent(computer.name)}/monitor/ws`,
        },
        authorization: {
          mode: "none",
        },
      };
    },
    async createPersistentUnit(computer) {
      return {
        unitName: computer.unitName,
        description: computer.description,
        unitType: "service",
        loadState: "loaded",
        activeState: "inactive",
        subState: "dead",
        execStart: computer.profile === "host" ? computer.runtime.command : "/usr/bin/bash -lc",
      };
    },
    async createScreenshot(computer) {
      return {
        computerName: computer.name,
        format: "png",
        mimeType: "image/png",
        capturedAt: new Date().toISOString(),
        width: 1440,
        height: 900,
        dataBase64: Buffer.from("screenshot").toString("base64"),
      };
    },
    async deletePersistentUnit() {},
    async getContainerRuntimeState() {
      return null;
    },
    async getRuntimeState() {
      return runtimeState;
    },
    async getHostUnit() {
      return null;
    },
    async listHostUnits() {
      return [];
    },
    async openAutomationAttach(computer) {
      return {
        computerName: computer.name,
        url: "ws://127.0.0.1:9222/devtools/browser/test",
        release() {},
      };
    },
    async openAudioStream(computer) {
      return {
        computerName: computer.name,
        command: "ffmpeg",
        args: ["-f", "ogg", "pipe:1"],
        targetSelector: `computerd.computer.name=${computer.name}`,
        release() {},
      };
    },
    async openMonitorAttach(computer) {
      return {
        computerName: computer.name,
        host: "127.0.0.1",
        port: 5900,
        release() {},
      };
    },
    async restartUnit() {
      return runtimeState;
    },
    async restartContainerComputer() {
      return runtimeState;
    },
    async startUnit() {
      setTimeout(() => {
        void ensureSocket(runtimeDirectory, terminalRecord.name);
      }, 150);

      return runtimeState;
    },
    async startContainerComputer() {
      return runtimeState;
    },
    async stopUnit() {
      return runtimeState;
    },
    async stopContainerComputer() {
      return runtimeState;
    },
    async updateBrowserViewport() {},
  };
  const runtimeState: UnitRuntimeState = {
    unitName: terminalRecord.unitName,
    description: terminalRecord.description,
    unitType: "service",
    loadState: "loaded",
    activeState: "active",
    subState: "running",
    execStart: terminalRecord.runtime.command,
  };

  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
      COMPUTERD_TERMINAL_RUNTIME_DIR: runtimeDirectory,
    },
    { metadataStore, runtime },
  );

  const started = await controlPlane.startComputer("starter-host");

  expect(started.state).toBe("running");
  await expect(controlPlane.createConsoleSession("starter-host")).resolves.toMatchObject({
    computerName: "starter-host",
  });
});

test("rejects sessions for unsupported capabilities", async () => {
  const metadataStore = createMemoryMetadataStore();
  const hostRecord = createHostComputerRecord();
  await metadataStore.putComputer(hostRecord);
  const runtime = createMemoryRuntime("/tmp/computerd-test-terminals");
  await runtime.createPersistentUnit(hostRecord);
  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
    },
    { metadataStore, runtime },
  );

  await expect(controlPlane.createMonitorSession("starter-host")).rejects.toBeInstanceOf(Error);
  await expect(controlPlane.createAudioSession("starter-host")).rejects.toBeInstanceOf(Error);
  await expect(controlPlane.createConsoleSession("starter-host")).rejects.toBeInstanceOf(
    ComputerConsoleUnavailableError,
  );
});

test("acquires and releases a single active console attach", async () => {
  const metadataStore = createMemoryMetadataStore();
  const runtime = createMemoryRuntime("/tmp/computerd-test-terminals");
  const terminalRecord = createHostComputerRecord();
  await metadataStore.putComputer(terminalRecord);
  await runtime.createPersistentUnit(terminalRecord);
  const controlPlane = createControlPlane(
    {
      COMPUTERD_METADATA_DIR: "/tmp/computerd-test-metadata",
      COMPUTERD_UNIT_DIR: "/tmp/computerd-test-units",
      COMPUTERD_TERMINAL_RUNTIME_DIR: "/tmp/computerd-test-terminals",
    },
    { metadataStore, runtime },
  );
  await controlPlane.startComputer("starter-host");

  const lease = await controlPlane.openConsoleAttach("starter-host");
  expect(lease.command).toBe("tmux");
  await expect(controlPlane.openConsoleAttach("starter-host")).rejects.toBeInstanceOf(
    ComputerConsoleUnavailableError,
  );
  lease.release();

  await expect(controlPlane.openConsoleAttach("starter-host")).resolves.toMatchObject({
    computerName: "starter-host",
  });
});

function createMemoryMetadataStore(): ComputerMetadataStore {
  const records = new Map<string, PersistedComputer>();

  return {
    async deleteComputer(name) {
      records.delete(name);
    },
    async getComputer(name) {
      return records.get(name) ?? null;
    },
    async listComputers() {
      return [...records.values()];
    },
    async putComputer(computer) {
      records.set(computer.name, structuredClone(computer));
    },
  };
}

function createMemoryImageProvider() {
  return {
    async deleteContainerImage() {},
    async getImage(id: string) {
      if (id.startsWith("filesystem-vm:")) {
        return {
          id,
          provider: "filesystem-vm" as const,
          kind: id.endsWith("iso") ? ("iso" as const) : ("qcow2" as const),
          name: id,
          status: "available" as const,
          path: id.endsWith("iso") ? "/images/dev.iso" : "/images/dev.qcow2",
          sizeBytes: 1024,
          sourceType: "explicit-file" as const,
        };
      }

      return {
        id,
        provider: "docker" as const,
        kind: "container" as const,
        imageId: id.replace(/^docker:/, ""),
        name: id,
        reference: "ubuntu:24.04",
        repoTags: ["ubuntu:24.04"],
        sizeBytes: 1024,
        status: "available" as const,
      };
    },
    async listImages() {
      return [];
    },
    async pullContainerImage(reference: string) {
      return {
        id: `docker:${reference}`,
        provider: "docker" as const,
        kind: "container" as const,
        imageId: reference,
        name: reference,
        reference,
        repoTags: [reference],
        sizeBytes: 1024,
        status: "available" as const,
      };
    },
    async requireVmImage(id: string, kind: "qcow2" | "iso") {
      return {
        id,
        provider: "filesystem-vm" as const,
        kind,
        name: id,
        status: "available" as const,
        path: kind === "iso" ? "/images/dev.iso" : "/images/dev.qcow2",
        sizeBytes: 1024,
        sourceType: "explicit-file" as const,
      };
    },
  };
}

function createBrowserComputerRecord(): PersistedComputer {
  return {
    name: "research-browser",
    unitName: "computerd-research-browser.service",
    profile: "browser",
    description: "Seeded browser computer",
    createdAt: "2026-03-09T08:00:00.000Z",
    lastActionAt: "2026-03-09T08:00:00.000Z",
    access: {
      display: {
        mode: "virtual-display",
      },
      logs: true,
    },
    resources: {},
    storage: {
      rootMode: "persistent",
    },
    network: {
      mode: "host",
    },
    lifecycle: {},
    runtime: {
      browser: "chromium",
      persistentProfile: true,
      runtimeUser: "computerd-b-research-browser",
    },
  };
}

function createHostComputerRecord(): PersistedHostComputer {
  return {
    name: "starter-host",
    unitName: "computerd-starter-host.service",
    profile: "host",
    description: "Seeded host computer",
    createdAt: "2026-03-09T08:00:00.000Z",
    lastActionAt: "2026-03-09T08:00:00.000Z",
    access: {
      console: {
        mode: "pty",
        writable: true,
      },
      logs: true,
    },
    resources: {},
    storage: {
      rootMode: "persistent",
    },
    network: {
      mode: "host",
    },
    lifecycle: {},
    runtime: {
      command: "/usr/bin/bash",
    },
  };
}

function createContainerComputerRecord(): PersistedComputer {
  return {
    name: "workspace-container",
    unitName: "docker:workspace-container",
    profile: "container",
    description: "Seeded container computer",
    createdAt: "2026-03-09T08:00:00.000Z",
    lastActionAt: "2026-03-09T08:00:00.000Z",
    access: {
      console: {
        mode: "pty",
        writable: true,
      },
      logs: true,
    },
    resources: {},
    storage: {
      rootMode: "persistent",
    },
    network: {
      mode: "host",
    },
    lifecycle: {},
    runtime: {
      provider: "docker",
      image: "ubuntu:24.04",
      command: "/bin/sh -i",
      containerId: "container-workspace-container",
      containerName: "workspace-container",
    },
  };
}

function createVmComputerRecord(): PersistedVmComputer {
  return {
    name: "linux-vm",
    unitName: "computerd-linux-vm.service",
    profile: "vm",
    description: "Seeded VM computer",
    createdAt: "2026-03-09T08:00:00.000Z",
    lastActionAt: "2026-03-09T08:00:00.000Z",
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
    resources: {},
    storage: {
      rootMode: "persistent",
    },
    network: {
      mode: "host",
    },
    lifecycle: {},
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
      accelerator: "kvm",
      architecture: "x86_64",
      machine: "q35",
      source: {
        kind: "qcow2",
        imageId: "filesystem-vm:dev-qcow2",
        path: "/images/ubuntu-cloud.qcow2",
        cloudInit: {
          user: "ubuntu",
        },
      },
    },
  };
}

function createMemoryRuntime(runtimeDirectory: string): ComputerRuntimePort {
  const states = new Map<string, UnitRuntimeState>();
  const browserViewports = new Map<string, { width: number; height: number }>();
  const vmSnapshots = new Map<
    string,
    Array<{ name: string; createdAt: string; sizeBytes: number }>
  >();

  return {
    async createContainerComputer(input, unitName) {
      return {
        ...input.runtime,
        containerId: `container-${unitName}`,
        containerName: unitName,
      };
    },
    async createVmComputer(input, imagePath) {
      return {
        ...input.runtime,
        source: {
          ...input.runtime.source,
          path: imagePath,
        },
        accelerator: "kvm",
        architecture: "x86_64",
        machine: "q35",
      };
    },
    async deleteBrowserRuntimeIdentity() {},
    async deleteContainerComputer(computer) {
      states.delete(computer.unitName);
    },
    async deleteVmComputer(computer) {
      states.delete(computer.unitName);
      vmSnapshots.delete(computer.name);
      await rm(join(runtimeDirectory, computer.name), { recursive: true, force: true });
    },
    async ensureBrowserRuntimeIdentity() {},
    async prepareBrowserRuntime() {},
    async prepareVmRuntime() {},
    async createAutomationSession(computer) {
      return {
        computerName: computer.name,
        protocol: "cdp",
        connect: {
          mode: "relative-websocket-path",
          url: `/api/computers/${encodeURIComponent(computer.name)}/automation/ws`,
        },
        authorization: {
          mode: "none",
        },
      };
    },
    async createAudioSession(computer) {
      return {
        computerName: computer.name,
        protocol: "http-audio-stream",
        connect: {
          mode: "relative-websocket-path",
          url: `/api/computers/${encodeURIComponent(computer.name)}/audio`,
        },
        authorization: {
          mode: "none",
        },
        mimeType: "audio/ogg",
      };
    },
    async createMonitorSession(computer) {
      return {
        computerName: computer.name,
        protocol: "vnc",
        connect: {
          mode: "relative-websocket-path",
          url: `/api/computers/${encodeURIComponent(computer.name)}/monitor/ws`,
        },
        authorization: {
          mode: "none",
        },
        viewport: {
          width:
            browserViewports.get(computer.unitName)?.width ??
            (computer.profile === "browser" ? (computer.runtime.viewport?.width ?? 1440) : 1440),
          height:
            browserViewports.get(computer.unitName)?.height ??
            (computer.profile === "browser" ? (computer.runtime.viewport?.height ?? 900) : 900),
        },
      };
    },
    async createPersistentUnit(computer) {
      if (computer.profile === "browser") {
        browserViewports.set(
          computer.unitName,
          computer.runtime.viewport ?? { width: 1440, height: 900 },
        );
      } else if (computer.profile === "vm") {
        browserViewports.set(computer.unitName, { width: 1440, height: 900 });
      }

      const state: UnitRuntimeState = {
        unitName: computer.unitName,
        description: computer.description,
        unitType: "service",
        loadState: "loaded",
        activeState: "inactive",
        subState: "dead",
        execStart:
          computer.profile === "host"
            ? computer.runtime.command
            : computer.profile === "vm"
              ? "/usr/bin/qemu-system-x86_64"
              : "/usr/bin/bash -lc",
        workingDirectory:
          computer.profile === "host" ? computer.runtime.workingDirectory : runtimeDirectory,
        environment: computer.profile === "host" ? computer.runtime.environment : undefined,
        cpuWeight: computer.resources.cpuWeight,
        memoryMaxMiB: computer.resources.memoryMaxMiB,
      };
      states.set(computer.unitName, state);
      return state;
    },
    async createScreenshot(computer) {
      const viewport = browserViewports.get(computer.unitName) ?? { width: 1440, height: 900 };
      return {
        computerName: computer.name,
        format: "png",
        mimeType: "image/png",
        capturedAt: new Date().toISOString(),
        width: viewport.width,
        height: viewport.height,
        dataBase64: Buffer.from(`screenshot:${computer.name}`).toString("base64"),
      };
    },
    async listVmSnapshots(computer) {
      return vmSnapshots.get(computer.name) ?? [];
    },
    async createVmSnapshot(computer, input) {
      const snapshots = vmSnapshots.get(computer.name) ?? [];
      if (snapshots.some((snapshot) => snapshot.name === input.name)) {
        throw new Error(`Snapshot "${input.name}" already exists for computer "${computer.name}".`);
      }

      const snapshot = {
        name: input.name,
        createdAt: new Date().toISOString(),
        sizeBytes: 1024,
      };
      vmSnapshots.set(computer.name, [snapshot, ...snapshots]);
      return snapshot;
    },
    async deleteVmSnapshot(computer, snapshotName) {
      const snapshots = vmSnapshots.get(computer.name) ?? [];
      if (!snapshots.some((snapshot) => snapshot.name === snapshotName)) {
        throw new Error(
          `Snapshot "${snapshotName}" was not found for computer "${computer.name}".`,
        );
      }

      vmSnapshots.set(
        computer.name,
        snapshots.filter((snapshot) => snapshot.name !== snapshotName),
      );
    },
    async deletePersistentUnit(unitName) {
      await cleanupSocket(runtimeDirectory, unitNameToComputerName(unitName));
      states.delete(unitName);
    },
    async getContainerRuntimeState(computer) {
      return states.get(computer.unitName) ?? null;
    },
    async getRuntimeState(unitName) {
      return states.get(unitName) ?? null;
    },
    async getHostUnit() {
      return null;
    },
    async listHostUnits() {
      return [];
    },
    async openAutomationAttach(computer) {
      return {
        computerName: computer.name,
        url: `ws://127.0.0.1:9222/devtools/browser/${computer.name}`,
        release() {},
      };
    },
    async openAudioStream(computer) {
      return {
        computerName: computer.name,
        command: "ffmpeg",
        args: ["-f", "ogg", "pipe:1"],
        targetSelector: `computerd.computer.name=${computer.name}`,
        release() {},
      };
    },
    async openMonitorAttach(computer) {
      return {
        computerName: computer.name,
        host: "127.0.0.1",
        port: 5900,
        release() {},
      };
    },
    async restartUnit(unitName) {
      const state = requireState(states, unitName);
      if (state.execStart !== "/usr/bin/bash -lc") {
        await ensureSocket(runtimeDirectory, unitNameToComputerName(unitName));
      }
      state.activeState = "active";
      state.subState = "running";
      return state;
    },
    async restartContainerComputer(computer) {
      const state = requireState(states, computer.unitName);
      state.activeState = "active";
      state.subState = "running";
      return state;
    },
    async startUnit(unitName) {
      const state = requireState(states, unitName);
      if (state.execStart !== "/usr/bin/bash -lc") {
        await ensureSocket(runtimeDirectory, unitNameToComputerName(unitName));
      }
      state.activeState = "active";
      state.subState = "running";
      return state;
    },
    async startContainerComputer(computer) {
      const state = requireState(states, computer.unitName);
      state.activeState = "active";
      state.subState = "running";
      return state;
    },
    async stopUnit(unitName) {
      const state = requireState(states, unitName);
      await cleanupSocket(runtimeDirectory, unitNameToComputerName(unitName));
      state.activeState = "inactive";
      state.subState = "dead";
      return state;
    },
    async stopContainerComputer(computer) {
      const state = requireState(states, computer.unitName);
      state.activeState = "inactive";
      state.subState = "dead";
      return state;
    },
    async restoreVmComputer(computer, input) {
      if (input.target === "initial") {
        return;
      }

      const snapshots = vmSnapshots.get(computer.name) ?? [];
      if (!snapshots.some((snapshot) => snapshot.name === input.snapshotName)) {
        throw new Error(
          `Snapshot "${input.snapshotName}" was not found for computer "${computer.name}".`,
        );
      }
    },
    async updateBrowserViewport(computer, viewport) {
      browserViewports.set(computer.unitName, viewport);
    },
  };
}

function requireState(states: Map<string, UnitRuntimeState>, unitName: string) {
  const state = states.get(unitName);
  if (!state) {
    throw new ComputerNotFoundError(unitName);
  }

  return state;
}

async function ensureSocket(runtimeDirectory: string, computerName: string) {
  const directory = join(runtimeDirectory, computerName);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "tmux.sock"), "");
}

async function cleanupSocket(runtimeDirectory: string, computerName: string) {
  await rm(join(runtimeDirectory, computerName), { recursive: true, force: true });
}

function unitNameToComputerName(unitName: string) {
  return unitName.replace(/^computerd-/, "").replace(/\.service$/, "");
}
