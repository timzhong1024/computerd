import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  createCloudInitNetworkConfig,
  createCloudInitUserData,
  createSystemdRuntime,
} from "./runtime";

const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  delete process.env.QEMU_IMG_LOG_PATH;
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
        imageId: "filesystem-vm:test",
        path: "/var/lib/images/test.qcow2",
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

test("vm snapshot operations use qemu-img and managed snapshot paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "computerd-systemd-runtime-"));
  directories.push(root);

  const qemuImgCommand = await createFakeQemuImg(root);
  const logPath = join(root, "qemu-img.log");
  process.env.QEMU_IMG_LOG_PATH = logPath;

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
    qemuImgCommand,
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

  const baseImagePath = join(root, "images", "base.qcow2");
  await mkdir(join(root, "images"), { recursive: true });
  await writeFile(baseImagePath, "base-image");

  const computer = {
    name: "vm-snapshot-test",
    unitName: "computerd-vm-snapshot-test.service",
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
        imageId: "filesystem-vm:base",
        path: baseImagePath,
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

  await mkdir(join(root, "vm-state", "vm-snapshot-test", "vm"), { recursive: true });
  await writeFile(join(root, "vm-state", "vm-snapshot-test", "vm", "disk.qcow2"), "current-disk");

  const snapshot = await runtime.createVmSnapshot(computer, {
    name: "checkpoint-1",
  });
  expect(snapshot.name).toBe("checkpoint-1");

  const snapshots = await runtime.listVmSnapshots(computer);
  expect(snapshots).toEqual([
    expect.objectContaining({
      name: "checkpoint-1",
    }),
  ]);

  const snapshotManifest = await readFile(
    join(root, "vm-state", "vm-snapshot-test", "vm", "snapshots", "manifest.json"),
    "utf8",
  );
  expect(snapshotManifest).toContain('"name": "checkpoint-1"');

  await runtime.restoreVmComputer(computer, {
    target: "snapshot",
    snapshotName: "checkpoint-1",
  });
  await runtime.restoreVmComputer(computer, {
    target: "initial",
  });
  await runtime.deleteVmSnapshot(computer, "checkpoint-1");

  const log = await readFile(logPath, "utf8");
  expect(log).toContain(`create -f qcow2 -F qcow2 -b ${baseImagePath}`);
  expect(log).toContain("convert -O qcow2");
  expect(log).toContain(join(root, "vm-state", "vm-snapshot-test", "vm", "snapshots"));
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

test("cloud-init user-data uses explicit user with plain text password semantics", () => {
  const userData = createCloudInitUserData("ubuntu", {
    user: "ubuntu",
    password: "114514",
    sshAuthorizedKeys: ["ssh-ed25519 AAAATEST"],
  });

  expect(userData).toContain("users:");
  expect(userData).toContain("  - name: ubuntu");
  expect(userData).toContain("ssh_pwauth: true");
  expect(userData).toContain("    lock_passwd: false");
  expect(userData).toContain("    plain_text_passwd: 114514");
  expect(userData).toContain("    ssh_authorized_keys:");
  expect(userData).not.toContain("  - default");
  expect(userData).not.toContain("    passwd:");
  expect(userData).not.toContain("chpasswd:");
});

async function createFakeQemuImg(root: string) {
  const scriptPath = join(root, "fake-qemu-img");
  await writeFile(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -eu",
      'printf "%s\\n" "$*" >> "${QEMU_IMG_LOG_PATH}"',
      'command="$1"',
      'if [ "$command" = "create" ]; then',
      '  target="${@: -1}"',
      '  mkdir -p "$(dirname "$target")"',
      '  if [ "$2" = "-f" ] && [ "$4" = "-F" ]; then',
      '    base="$7"',
      '    cp "$base" "$target"',
      "  else",
      '    : > "$target"',
      "  fi",
      'elif [ "$command" = "convert" ]; then',
      '  source_path="$4"',
      '  target="${@: -1}"',
      '  mkdir -p "$(dirname "$target")"',
      '  cp "$source_path" "$target"',
      "else",
      '  echo "unsupported qemu-img command" >&2',
      "  exit 1",
      "fi",
    ].join("\n"),
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}
