import { join } from "node:path";
import type { CreateVmRuntime, PersistedVmComputer, VmRuntime } from "./types";

export interface VmRuntimePathsOptions {
  stateRootDirectory: string;
  runtimeRootDirectory: string;
}

export const DEFAULT_VM_VIEWPORT = {
  width: 1440,
  height: 900,
} as const;

export function createVmRuntimePaths({
  stateRootDirectory,
  runtimeRootDirectory,
}: VmRuntimePathsOptions) {
  return {
    stateRootDirectory,
    runtimeRootDirectory,
    specForName(name: string) {
      const slug = slugify(name);
      const stateDirectory = join(stateRootDirectory, slug, "vm");
      const runtimeDirectory = join(runtimeRootDirectory, slug, "vm");
      const vncDisplay = stableHash(`${slug}-vnc`) % 100; // TODO

      return {
        slug,
        stateDirectory,
        runtimeDirectory,
        networkMacAddress: stableMacAddress(slug),
        diskImagePath: join(stateDirectory, "disk.qcow2"),
        snapshotsDirectory: join(stateDirectory, "snapshots"),
        snapshotManifestPath: join(stateDirectory, "snapshots", "manifest.json"),
        cloudInitDirectory: join(stateDirectory, "cloud-init"),
        cloudInitUserDataPath: join(stateDirectory, "cloud-init", "user-data"),
        cloudInitMetaDataPath: join(stateDirectory, "cloud-init", "meta-data"),
        cloudInitNetworkConfigPath: join(stateDirectory, "cloud-init", "network-config"),
        cloudInitImagePath: join(stateDirectory, "cloud-init.iso"),
        serialSocketPath: join(runtimeDirectory, "serial.sock"),
        vncDisplay,
        vncPort: 5900 + vncDisplay,
        viewport: DEFAULT_VM_VIEWPORT,
      };
    },
    specForComputer(computer: PersistedVmComputer) {
      return this.specForName(computer.name);
    },
  };
}

export function createVmSnapshotImagePath(
  spec: ReturnType<ReturnType<typeof createVmRuntimePaths>["specForName"]>,
  snapshotId: string,
) {
  return join(spec.snapshotsDirectory, `${snapshotId}.qcow2`);
}

export function toVmRuntimeDetail(
  computer: PersistedVmComputer,
  options: VmRuntimePathsOptions,
): VmRuntime {
  const spec = createVmRuntimePaths(options).specForComputer(computer);

  return {
    ...computer.runtime,
    bridge: computer.runtime.bridgeName,
    nics: computer.runtime.nics.map((nic, index) => ({
      ...nic,
      macAddress: resolveVmNicMacAddress(spec, nic.macAddress, index),
      ipConfigApplied:
        index === 0 &&
        computer.runtime.source.kind === "qcow2" &&
        computer.runtime.source.cloudInit.enabled !== false,
    })),
    diskImagePath: spec.diskImagePath,
    cloudInitImagePath:
      computer.runtime.source.kind === "qcow2" &&
      computer.runtime.source.cloudInit.enabled !== false
        ? spec.cloudInitImagePath
        : undefined,
    serialSocketPath: spec.serialSocketPath,
    vncDisplay: spec.vncDisplay,
    vncPort: spec.vncPort,
    displayViewport: spec.viewport,
  };
}

export function withPersistedVmRuntime(
  runtime: CreateVmRuntime,
  imagePath: string,
  bridgeName: string,
): PersistedVmComputer["runtime"] {
  return {
    ...runtime,
    source: {
      ...runtime.source,
      path: imagePath,
    },
    accelerator: "kvm",
    architecture: "x86_64",
    machine: "q35",
    bridgeName,
  };
}

export function resolveVmNicMacAddress(
  spec: ReturnType<ReturnType<typeof createVmRuntimePaths>["specForName"]>,
  configuredMacAddress: string | undefined,
  nicIndex: number,
) {
  if (configuredMacAddress !== undefined) {
    return configuredMacAddress;
  }

  if (nicIndex === 0) {
    return spec.networkMacAddress;
  }

  return "";
}

function stableHash(value: string) {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }

  return hash;
}

function stableMacAddress(value: string) {
  const hash = stableHash(value);
  const octets = [0x52, 0x54, 0x00, (hash >>> 16) & 0xff, (hash >>> 8) & 0xff, hash & 0xff];

  return octets.map((octet) => octet.toString(16).padStart(2, "0")).join(":");
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
