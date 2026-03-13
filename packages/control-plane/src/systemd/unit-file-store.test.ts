import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { FileUnitStore } from "./unit-file-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

test("renders browser exec start without invalid background separators", async () => {
  const root = await mkdtemp(join(tmpdir(), "computerd-unit-store-"));
  directories.push(root);
  const store = new FileUnitStore({
    directory: join(root, "units"),
    browserRuntimeDirectory: join(root, "run"),
    browserStateDirectory: join(root, "state"),
    terminalRuntimeDirectory: join(root, "terminals"),
    vmRuntimeDirectory: join(root, "run"),
    vmStateDirectory: join(root, "state"),
    vmHostBridge: "br0",
  });

  await store.writeUnitFile({
    name: "browser-smoke",
    unitName: "computerd-browser-smoke.service",
    profile: "browser",
    createdAt: "2026-03-09T00:00:00.000Z",
    lastActionAt: "2026-03-09T00:00:00.000Z",
    runtime: {
      browser: "chromium",
      persistentProfile: true,
      runtimeUser: "computerd-b-browser-smoke",
      viewport: {
        width: 1600,
        height: 1000,
      },
    },
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
  });

  const unitFile = await readFile(join(root, "units", "computerd-browser-smoke.service"), "utf8");
  expect(unitFile).not.toContain("&;");
  expect(unitFile).toContain("User=computerd-b-browser-smoke");
  expect(unitFile).toContain("TimeoutStopSec=10s");
  expect(unitFile).toContain("RuntimeDirectoryMode=0700");
  expect(unitFile).toContain('Environment="COMPUTERD_BROWSER_VIEWPORT=1600x1000"');
  expect(unitFile).toContain('Environment="PULSE_SERVER=unix:');
  expect(unitFile).toContain('Environment="PULSE_SINK=auto_null"');
  expect(unitFile).toContain('Environment="PIPEWIRE_ALSA=');
  expect(unitFile).toContain('application.name = \\"computerd-browser\\"');
  expect(unitFile).not.toContain("pulseaudio --daemonize");
  expect(unitFile).toContain("dbus-run-session -- /usr/bin/bash -lc");
  expect(unitFile).toContain("/run/browser-smoke/pipewire.log");
  expect(unitFile).toContain("/run/browser-smoke/chromium.log");
  expect(unitFile).toContain("[ -S ");
  expect(unitFile).not.toContain("/tmp/computerd-pipewire.log");
  expect(unitFile).not.toContain("/tmp/computerd-chromium.log");
  expect(unitFile).toContain("XVFB_PID=$$!");
  expect(unitFile).toContain("wait $$CHROMIUM_PID");
  expect(unitFile).toContain(
    "kill $$X11VNC_PID $$CHROMIUM_PID $$PIPEWIRE_PULSE_PID $$WIREPLUMBER_PID $$PIPEWIRE_PID $$XVFB_PID",
  );
  expect(unitFile).toContain("ExecStopPost=/usr/bin/bash -lc");
  expect(unitFile).toContain("pkill -u 'computerd-b-browser-smoke' -x pipewire");
  expect(unitFile).toContain("rm -rf ");
  expect(unitFile).toContain("--window-size=1600,1000");
});

test("does not mount cloud-init media for qcow2 vms with cloud-init disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "computerd-unit-store-"));
  directories.push(root);
  const store = new FileUnitStore({
    directory: join(root, "units"),
    browserRuntimeDirectory: join(root, "run"),
    browserStateDirectory: join(root, "state"),
    terminalRuntimeDirectory: join(root, "terminals"),
    vmRuntimeDirectory: join(root, "run"),
    vmStateDirectory: join(root, "state"),
    vmHostBridge: "br0",
  });

  await store.writeUnitFile({
    name: "vm-no-cloud-init",
    unitName: "computerd-vm-no-cloud-init.service",
    profile: "vm",
    createdAt: "2026-03-12T00:00:00.000Z",
    lastActionAt: "2026-03-12T00:00:00.000Z",
    runtime: {
      hypervisor: "qemu",
      accelerator: "kvm",
      architecture: "x86_64",
      machine: "q35",
      source: {
        kind: "qcow2",
        imageId: "filesystem-vm:test",
        path: "/var/lib/images/test.qcow2",
        cloudInit: {
          enabled: false,
        },
      },
      nics: [
        {
          name: "primary",
          ipv4: {
            type: "static",
            address: "192.168.250.20",
            prefixLength: 24,
          },
          ipv6: {
            type: "disabled",
          },
        },
      ],
    },
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
  });

  const unitFile = await readFile(
    join(root, "units", "computerd-vm-no-cloud-init.service"),
    "utf8",
  );

  expect(unitFile).toContain("qemu-system-x86_64");
  expect(unitFile).toContain("disk.qcow2',if=virtio,format=qcow2");
  expect(unitFile).not.toContain("cloud-init.iso");
});

test("uses explicit vm nic mac address in qemu args", async () => {
  const root = await mkdtemp(join(tmpdir(), "computerd-unit-store-"));
  directories.push(root);
  const store = new FileUnitStore({
    directory: join(root, "units"),
    browserRuntimeDirectory: join(root, "run"),
    browserStateDirectory: join(root, "state"),
    terminalRuntimeDirectory: join(root, "terminals"),
    vmRuntimeDirectory: join(root, "run"),
    vmStateDirectory: join(root, "state"),
    vmHostBridge: "br0",
  });

  await store.writeUnitFile({
    name: "vm-explicit-mac",
    unitName: "computerd-vm-explicit-mac.service",
    profile: "vm",
    createdAt: "2026-03-12T00:00:00.000Z",
    lastActionAt: "2026-03-12T00:00:00.000Z",
    runtime: {
      hypervisor: "qemu",
      accelerator: "kvm",
      architecture: "x86_64",
      machine: "q35",
      source: {
        kind: "qcow2",
        imageId: "filesystem-vm:test",
        path: "/var/lib/images/test.qcow2",
        cloudInit: {
          enabled: true,
          user: "ubuntu",
        },
      },
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
    },
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
  });

  const unitFile = await readFile(join(root, "units", "computerd-vm-explicit-mac.service"), "utf8");

  expect(unitFile).toContain("mac=52:54:00:aa:bb:cc");
});
