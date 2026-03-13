import type { ComputerSnapshot, HostUnitDetail, ImageDetail } from "@computerd/core";
import {
  DevelopmentComputerRuntime,
  ensureDevelopmentConsoleSocket,
} from "./development-computer-runtime";
import { DevelopmentImageProvider } from "./development-image-provider";
import { DEFAULT_HOST_NETWORK_ID, DevelopmentNetworkProvider } from "./networks";
import { DevelopmentComputerMetadataStore } from "./systemd/metadata-store";
import { BaseControlPlane } from "./base-control-plane";
import { createBrowserRuntimeUser, createBrowserRuntimePaths } from "./systemd/browser-runtime";
import { createConsoleRuntimePaths } from "./systemd/console-runtime";
import { createVmRuntimePaths } from "./systemd/vm-runtime";
import {
  createConsoleAttachLease,
  type ConsoleAttachLease,
  type PersistedBrowserComputer,
  type PersistedComputer,
  type PersistedContainerComputer,
  type PersistedHostComputer,
  type PersistedVmComputer,
  type UnitRuntimeState,
} from "./shared";

export class DevelopmentControlPlane extends BaseControlPlane {
  constructor(environment: NodeJS.ProcessEnv = process.env) {
    const now = new Date().toISOString();
    const hostUnits: HostUnitDetail[] = [
      {
        unitName: "docker.service",
        unitType: "service",
        state: "active",
        description: "Docker Engine",
        capabilities: {
          canInspect: true,
        },
        execStart: "/usr/bin/dockerd --host=fd://",
        status: {
          activeState: "active",
          subState: "running",
          loadState: "loaded",
        },
        recentLogs: [],
      },
    ];
    const records = new Map<string, PersistedComputer>();
    const seeded: PersistedHostComputer = {
      name: "starter-host",
      unitName: "computerd-starter-host.service",
      profile: "host",
      description: "Development host computer for local coding and smoke tests.",
      createdAt: now,
      lastActionAt: now,
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
      networkId: DEFAULT_HOST_NETWORK_ID,
      lifecycle: {},
      runtime: {
        command: "/bin/sh -i",
      },
    };
    records.set(seeded.name, seeded);
    const browserSeed: PersistedBrowserComputer = {
      name: "research-browser",
      unitName: "computerd-research-browser.service",
      profile: "browser",
      description: "Development browser computer for noVNC and CDP smoke tests.",
      createdAt: now,
      lastActionAt: now,
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
      networkId: DEFAULT_HOST_NETWORK_ID,
      lifecycle: {},
      runtime: {
        browser: "chromium",
        persistentProfile: true,
        runtimeUser: createBrowserRuntimeUser("research-browser"),
      },
    };
    records.set(browserSeed.name, browserSeed);
    const vmSeed: PersistedVmComputer = {
      name: "linux-vm",
      unitName: "computerd-linux-vm.service",
      profile: "vm",
      description: "Development VM computer for QEMU monitor and serial console smoke tests.",
      createdAt: now,
      lastActionAt: now,
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
      networkId: DEFAULT_HOST_NETWORK_ID,
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
        bridgeName: "br0",
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
    records.set(vmSeed.name, vmSeed);
    const runtimeStates = new Map<string, UnitRuntimeState>([
      [
        seeded.unitName,
        {
          unitName: seeded.unitName,
          description: seeded.description,
          unitType: "service",
          loadState: "loaded",
          activeState: "inactive",
          subState: "dead",
          execStart: seeded.runtime.command,
        },
      ],
      [
        browserSeed.unitName,
        {
          unitName: browserSeed.unitName,
          description: browserSeed.description,
          unitType: "service",
          loadState: "loaded",
          activeState: "inactive",
          subState: "dead",
          execStart: "/usr/bin/bash -lc",
        },
      ],
      [
        vmSeed.unitName,
        {
          unitName: vmSeed.unitName,
          description: vmSeed.description,
          unitType: "service",
          loadState: "loaded",
          activeState: "inactive",
          subState: "dead",
          execStart: "/usr/bin/qemu-system-x86_64",
        },
      ],
    ]);
    const consoleRuntimePaths = createConsoleRuntimePaths({
      runtimeDirectory: "/tmp/computerd-development-terminals",
    });
    const browserRuntimePaths = createBrowserRuntimePaths({
      runtimeRootDirectory: "/tmp/computerd-development-browsers",
      stateRootDirectory: "/tmp/computerd-development-browser-state",
    });
    const vmRuntimePaths = createVmRuntimePaths({
      runtimeRootDirectory: "/tmp/computerd-development-vms",
      stateRootDirectory: "/tmp/computerd-development-vm-state",
    });
    const containerStates = new Map<string, UnitRuntimeState>();
    const vmSnapshots = new Map<string, ComputerSnapshot[]>();
    const images = new Map<string, ImageDetail>([
      [
        "filesystem-vm:dev-qcow2",
        {
          id: "filesystem-vm:dev-qcow2",
          kind: "qcow2",
          provider: "filesystem-vm",
          name: "ubuntu-cloud.qcow2",
          status: "available",
          createdAt: now,
          lastSeenAt: now,
          path: "/images/ubuntu-cloud.qcow2",
          sizeBytes: 601 * 1024 * 1024,
          format: "qcow2",
          sourceType: "managed-import",
        },
      ],
      [
        "filesystem-vm:dev-iso",
        {
          id: "filesystem-vm:dev-iso",
          kind: "iso",
          provider: "filesystem-vm",
          name: "ubuntu.iso",
          status: "available",
          createdAt: now,
          lastSeenAt: now,
          path: "/images/ubuntu.iso",
          sizeBytes: 2 * 1024 * 1024 * 1024,
          format: "iso",
          sourceType: "managed-import",
        },
      ],
      [
        "docker:sha256:ubuntu-24-04",
        {
          id: "docker:sha256:ubuntu-24-04",
          kind: "container",
          provider: "docker",
          name: "ubuntu:24.04",
          status: "available",
          createdAt: now,
          lastSeenAt: now,
          reference: "ubuntu:24.04",
          imageId: "sha256:ubuntu-24-04",
          repoTags: ["ubuntu:24.04"],
          sizeBytes: 123_456_789,
        },
      ],
    ]);
    const networks = new Map<string, import("./networks").PersistedNetworkRecord>([
      [
        DEFAULT_HOST_NETWORK_ID,
        {
          id: DEFAULT_HOST_NETWORK_ID,
          name: "Host network",
          kind: "host" as const,
          cidr: "192.168.250.0/24",
          bridgeName: "br0",
        },
      ],
      [
        "network-dev-isolated",
        {
          id: "network-dev-isolated",
          name: "isolated-dev",
          kind: "isolated" as const,
          cidr: "192.168.251.0/24",
          bridgeName: "br1",
          dockerNetworkName: "computerd-network-dev-isolated",
          createdAt: now,
        },
      ],
    ]);

    const runtime = new DevelopmentComputerRuntime({
      browserRuntimePaths,
      consoleRuntimePaths,
      containerStates,
      hostUnits,
      records,
      runtimeStates,
      vmRuntimePaths,
      vmSnapshots,
    });
    const metadataStore = new DevelopmentComputerMetadataStore(records);
    const imageProvider = new DevelopmentImageProvider(images);
    const networkProvider = new DevelopmentNetworkProvider(networks);

    super({
      environment: {
        ...environment,
        COMPUTERD_BROWSER_RUNTIME_DIR: browserRuntimePaths.runtimeRootDirectory,
        COMPUTERD_BROWSER_STATE_DIR: browserRuntimePaths.stateRootDirectory,
        COMPUTERD_VM_RUNTIME_DIR: vmRuntimePaths.runtimeRootDirectory,
        COMPUTERD_VM_STATE_DIR: vmRuntimePaths.stateRootDirectory,
        COMPUTERD_VM_BRIDGE: "br0",
        COMPUTERD_VM_ISOLATED_BRIDGE: "br1",
        COMPUTERD_TERMINAL_RUNTIME_DIR: consoleRuntimePaths.runtimeDirectory,
      },
      imageProvider,
      networkProvider,
      metadataStore,
      runtime,
      consoleRuntimePaths,
      browserRuntimePaths,
      vmRuntimePaths,
      usesDefaultPersistence: false,
    });
  }

  protected override async beforeCreateConsoleSession(
    record: PersistedHostComputer | PersistedContainerComputer | PersistedVmComputer,
  ) {
    if (record.profile === "host") {
      await ensureDevelopmentConsoleSocket(this.consoleRuntimePaths, record);
      return;
    }
    if (record.profile === "container") {
      await this.requireContainerRunning(record, "console sessions");
    }
  }

  protected override async beforeOpenConsoleAttach(
    record: PersistedHostComputer | PersistedContainerComputer | PersistedVmComputer,
  ) {
    if (record.profile === "host") {
      await ensureDevelopmentConsoleSocket(this.consoleRuntimePaths, record);
      return;
    }
    if (record.profile === "container") {
      await this.requireContainerRunning(record, "console sessions");
    }
  }

  protected override async buildConsoleAttachLease(
    record: PersistedHostComputer | PersistedContainerComputer | PersistedVmComputer,
  ): Promise<ConsoleAttachLease> {
    if (record.profile === "container" || record.profile === "vm") {
      return createConsoleAttachLease(
        record,
        this.consoleRuntimePaths,
        process.env,
        this.activeConsoleAttaches,
      );
    }

    if (process.platform !== "darwin") {
      await ensureDevelopmentConsoleSocket(this.consoleRuntimePaths, record);
      const spec = this.consoleRuntimePaths.specForComputer(record);
      return {
        command: "tmux",
        args: ["-S", spec.socketPath, "attach-session", "-t", spec.sessionName],
        computerName: record.name,
        cwd: record.runtime.workingDirectory,
        env: record.runtime.environment,
        release: () => {
          this.activeConsoleAttaches.delete(record.name);
        },
      };
    }

    return {
      command: "/bin/bash",
      args: ["-i", "-l"],
      computerName: record.name,
      cwd: record.runtime.workingDirectory,
      env: record.runtime.environment,
      release: () => {
        this.activeConsoleAttaches.delete(record.name);
      },
    };
  }
}
