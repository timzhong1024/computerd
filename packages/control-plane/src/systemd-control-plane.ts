import Docker from "dockerode";
import { SystemImageProvider, type ImageProvider } from "./images";
import { SystemNetworkProvider, type NetworkProvider } from "./networks";
import { BaseControlPlane } from "./base-control-plane";
import { CompositeComputerRuntime } from "./composite-computer-runtime";
import { DefaultDockerRuntime } from "./docker/runtime";
import { createBrowserRuntimePaths } from "./systemd/browser-runtime";
import { createConsoleRuntimePaths } from "./systemd/console-runtime";
import { FileComputerMetadataStore } from "./systemd/metadata-store";
import { DefaultSystemdRuntime, type SystemdRuntime } from "./systemd/runtime";
import { createVmRuntimePaths } from "./systemd/vm-runtime";
import { ComputerRuntimePort, type ComputerMetadataStore } from "./shared";

export interface SystemdControlPlaneOptions {
  imageProvider?: ImageProvider;
  networkProvider?: NetworkProvider;
  metadataStore?: ComputerMetadataStore;
  runtime?: ComputerRuntimePort;
}

export class SystemdControlPlane extends BaseControlPlane {
  constructor(
    environment: NodeJS.ProcessEnv = process.env,
    options: SystemdControlPlaneOptions = {},
  ) {
    const usesDefaultPersistence =
      options.metadataStore === undefined && options.runtime === undefined;
    const metadataStore =
      options.metadataStore ??
      new FileComputerMetadataStore(
        environment.COMPUTERD_METADATA_DIR ?? "/var/lib/computerd/computers",
      );
    const consoleRuntimePaths = createConsoleRuntimePaths({
      runtimeDirectory: environment.COMPUTERD_TERMINAL_RUNTIME_DIR ?? "/run/computerd/terminals",
    });
    const browserRuntimePaths = createBrowserRuntimePaths({
      runtimeRootDirectory: environment.COMPUTERD_BROWSER_RUNTIME_DIR ?? "/run/computerd/computers",
      stateRootDirectory: environment.COMPUTERD_BROWSER_STATE_DIR ?? "/var/lib/computerd/computers",
    });
    const vmRuntimePaths = createVmRuntimePaths({
      runtimeRootDirectory: environment.COMPUTERD_VM_RUNTIME_DIR ?? "/run/computerd/computers",
      stateRootDirectory: environment.COMPUTERD_VM_STATE_DIR ?? "/var/lib/computerd/computers",
    });
    const runtime =
      options.runtime ??
      createRuntimePort({
        dockerSocketPath: environment.COMPUTERD_DOCKER_SOCKET ?? "/var/run/docker.sock",
        systemdRuntime: new DefaultSystemdRuntime({
          unitFileStoreOptions: {
            directory: environment.COMPUTERD_UNIT_DIR ?? "/etc/systemd/system",
            browserRuntimeDirectory:
              environment.COMPUTERD_BROWSER_RUNTIME_DIR ?? "/run/computerd/computers",
            browserStateDirectory:
              environment.COMPUTERD_BROWSER_STATE_DIR ?? "/var/lib/computerd/computers",
            terminalRuntimeDirectory: consoleRuntimePaths.runtimeDirectory,
            vmRuntimeDirectory: environment.COMPUTERD_VM_RUNTIME_DIR ?? "/run/computerd/computers",
            vmStateDirectory: environment.COMPUTERD_VM_STATE_DIR ?? "/var/lib/computerd/computers",
          },
        }),
      });
    const imageProvider =
      options.imageProvider ??
      new SystemImageProvider({
        configPath: environment.COMPUTERD_IMAGE_CONFIG ?? "/etc/computerd/images.json",
        dockerSocketPath: environment.COMPUTERD_DOCKER_SOCKET ?? "/var/run/docker.sock",
        qemuImgCommand: environment.COMPUTERD_QEMU_IMG ?? "qemu-img",
        vmImageStoreDir: environment.COMPUTERD_VM_IMAGE_STORE ?? "/var/lib/computerd/images/vm",
      });
    const networkProvider =
      options.networkProvider ??
      new SystemNetworkProvider({
        configPath: environment.COMPUTERD_NETWORK_CONFIG ?? "/etc/computerd/networks.json",
        dockerSocketPath: environment.COMPUTERD_DOCKER_SOCKET ?? "/var/run/docker.sock",
        environment,
        runtimeDirectory: environment.COMPUTERD_NETWORK_RUNTIME_DIR ?? "/run/computerd/networks",
      });

    super({
      environment,
      imageProvider,
      networkProvider,
      metadataStore,
      runtime,
      consoleRuntimePaths,
      browserRuntimePaths,
      vmRuntimePaths,
      usesDefaultPersistence,
    });
  }
}

function createRuntimePort({
  dockerSocketPath,
  systemdRuntime,
}: {
  dockerSocketPath: string;
  systemdRuntime: SystemdRuntime;
}): ComputerRuntimePort {
  const dockerRuntime = new DefaultDockerRuntime(new Docker({ socketPath: dockerSocketPath }));

  return new CompositeComputerRuntime(systemdRuntime, dockerRuntime);
}
