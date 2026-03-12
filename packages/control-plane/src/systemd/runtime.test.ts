import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createCloudInitNetworkConfig, createSystemdRuntime } from "./runtime";

const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("deleteVmComputer removes persisted vm state and runtime directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "computerd-systemd-runtime-"));
  directories.push(root);

  const runtime = createSystemdRuntime({
    dbusClient: {
      deletePersistentUnit: async () => {},
      getHostUnit: async () => null,
      getRuntimeState: async () => null,
      listHostUnits: async () => [],
      reloadDaemon: async () => {},
      restartUnit: async () => {
        throw new Error("not used");
      },
      setUnitEnabled: async () => {},
      startUnit: async () => {
        throw new Error("not used");
      },
      stopUnit: async () => {
        throw new Error("not used");
      },
    },
    unitFileStore: {
      deleteUnitFile: async () => {},
      getUnitFileContents: async () => null,
      writeUnitFile: async () => "",
    },
    unitFileStoreOptions: {
      directory: join(root, "units"),
      browserRuntimeDirectory: join(root, "browser-run"),
      browserStateDirectory: join(root, "browser-state"),
      terminalRuntimeDirectory: join(root, "terminal-run"),
      vmRuntimeDirectory: join(root, "vm-run"),
      vmStateDirectory: join(root, "vm-state"),
      vmHostBridge: "br0",
    },
  });

  const computer = {
    name: "vm-cleanup-test",
    unitName: "computerd-vm-cleanup-test.service",
    profile: "vm" as const,
    createdAt: "2026-03-12T00:00:00.000Z",
    lastActionAt: "2026-03-12T00:00:00.000Z",
    runtime: {
      hypervisor: "qemu" as const,
      accelerator: "kvm" as const,
      architecture: "x86_64" as const,
      machine: "q35" as const,
      source: {
        kind: "qcow2" as const,
        baseImagePath: "/var/lib/images/test.qcow2",
        cloudInit: {
          user: "ubuntu",
        },
      },
      nics: [
        {
          name: "primary",
          ipv4: {
            type: "dhcp" as const,
          },
        },
      ],
    },
    access: {
      console: {
        mode: "pty" as const,
        writable: true,
      },
      display: {
        mode: "vnc" as const,
      },
      logs: true,
    },
    resources: {},
    storage: {
      rootMode: "persistent" as const,
    },
    network: {
      mode: "host" as const,
    },
    lifecycle: {},
  };

  const stateDirectory = join(root, "vm-state", "vm-cleanup-test", "vm");
  const runtimeDirectory = join(root, "vm-run", "vm-cleanup-test", "vm");
  await mkdir(stateDirectory, { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true });

  await runtime.deleteVmComputer(computer);

  await expect(stat(stateDirectory)).rejects.toThrow();
  await expect(stat(runtimeDirectory)).rejects.toThrow();
});

test("disabled nic network-config is marked optional", () => {
  const networkConfig = createCloudInitNetworkConfig(
    {
      ipv4: {
        type: "disabled",
      },
      ipv6: {
        type: "disabled",
      },
    },
    "52:54:00:aa:bb:cc",
  );

  expect(networkConfig).toContain("optional: true");
  expect(networkConfig).toContain("dhcp4: false");
  expect(networkConfig).toContain("dhcp6: false");
});
