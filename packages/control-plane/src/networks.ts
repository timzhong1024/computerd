import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import Docker from "dockerode";
import type { CreateNetworkInput, NetworkDetail, NetworkSummary } from "@computerd/core";

const execFileAsync = promisify(execFile);
const DEFAULT_HOST_NETWORK_ID = "network-host";
const DEFAULT_HOST_NETWORK_NAME = "Host network";
const DEFAULT_HOST_BRIDGE = "br0";
const DEFAULT_HOST_BRIDGE_ADDRESS = "192.168.250.1/24";
const DEFAULT_HOST_NETWORK_CIDR = "192.168.250.0/24";
const DEFAULT_GATEWAY_IMAGE = "alpine:3.20";
const LEGACY_ISOLATED_NETWORK_ID = "network-legacy-isolated";
const QEMU_BRIDGE_CONFIG_PATH = "/etc/qemu/bridge.conf";

export class NetworkConflictError extends Error {
  constructor(name: string) {
    super(`Network "${name}" already exists.`);
    this.name = "NetworkConflictError";
  }
}

export class NetworkNotFoundError extends Error {
  constructor(id: string) {
    super(`Network "${id}" was not found.`);
    this.name = "NetworkNotFoundError";
  }
}

export class AttachedNetworkDeleteError extends Error {
  constructor(id: string) {
    super(`Network "${id}" cannot be deleted while computers are still attached.`);
    this.name = "AttachedNetworkDeleteError";
  }
}

interface PersistedNetworkGatewayConfig {
  dhcp: {
    provider: "dnsmasq";
  };
  dns: {
    provider: "dnsmasq" | "smartdns";
  };
  programmableGateway: {
    provider: "tailscale" | "openvpn" | null;
  };
}

interface PersistedNetworkGatewayRuntime {
  image: string;
  containerName: string;
  insideAddress: string;
  hostBridgeAddress: string;
  transitCidr: string;
  transitHostAddress: string;
  transitGatewayAddress: string;
  hostVethName: string;
  gatewayVethName: string;
  routingMark: number;
  routingTable: number;
}

interface PersistedIsolatedNetworkRecord {
  id: string;
  name: string;
  kind: "isolated";
  cidr: string;
  bridgeName: string;
  dockerNetworkName: string;
  createdAt: string;
  gateway: PersistedNetworkGatewayConfig;
  gatewayRuntime: PersistedNetworkGatewayRuntime;
}

export type PersistedNetworkRecord =
  | {
      id: typeof DEFAULT_HOST_NETWORK_ID;
      name: string;
      kind: "host";
      cidr: string;
      bridgeName: string;
      gateway: PersistedNetworkGatewayConfig;
    }
  | PersistedIsolatedNetworkRecord;

export abstract class NetworkProvider {
  abstract ensureConfiguredNetworks(): Promise<void>;
  abstract listNetworkRecords(): Promise<PersistedNetworkRecord[]>;
  abstract getNetworkRecord(id: string): Promise<PersistedNetworkRecord>;
  abstract createIsolatedNetwork(input: CreateNetworkInput): Promise<PersistedNetworkRecord>;
  abstract deleteIsolatedNetwork(id: string): Promise<void>;
  abstract ensureNetworkRuntime(network: PersistedNetworkRecord): Promise<void>;
  abstract toNetworkSummary(
    network: PersistedNetworkRecord,
    attachedComputerCount: number,
  ): Promise<NetworkSummary>;
  abstract toNetworkDetail(
    network: PersistedNetworkRecord,
    attachedComputerCount: number,
  ): Promise<NetworkDetail>;
}

export interface SystemNetworkProviderOptions {
  configPath: string;
  docker?: Docker;
  dockerSocketPath: string;
  environment: NodeJS.ProcessEnv;
  gatewayImage?: string;
  runtimeDirectory: string;
}

export class SystemNetworkProvider extends NetworkProvider {
  private readonly dockerClient: Docker;

  constructor(private readonly options: SystemNetworkProviderOptions) {
    super();
    this.dockerClient = options.docker ?? new Docker({ socketPath: options.dockerSocketPath });
  }

  async ensureConfiguredNetworks() {
    const records = await this.listNetworkRecords();
    for (const record of records) {
      if (record.kind === "isolated") {
        await this.ensureNetworkRuntime(record);
      }
    }
  }

  async listNetworkRecords() {
    const config = await readNetworkConfig(this.options.configPath);
    return [
      hostNetworkRecord(this.options.environment),
      ...legacyIsolatedNetworkRecords(this.options.environment, this.options.gatewayImage),
      ...config.networks.map((record) =>
        withNormalizedGatewayRuntime(record, this.options.environment, this.options.gatewayImage),
      ),
    ];
  }

  async getNetworkRecord(id: string) {
    const records = await this.listNetworkRecords();
    const record = records.find((entry) => entry.id === id);
    if (!record) {
      throw new NetworkNotFoundError(id);
    }
    return record;
  }

  async createIsolatedNetwork(input: CreateNetworkInput) {
    const config = await readNetworkConfig(this.options.configPath);
    if (config.networks.some((entry) => entry.name === input.name)) {
      throw new NetworkConflictError(input.name);
    }

    const cidr = normalizeIpv4Cidr(input.cidr);
    const id = `network-${slugify(input.name)}-${randomUUID().slice(0, 8)}`;
    const bridgeName = `ctd${stableHashHex(id).slice(0, 8)}`;
    const record = createIsolatedNetworkRecord(
      {
        id,
        name: input.name,
        cidr,
        bridgeName,
        dockerNetworkName: `computerd-${id}`,
        createdAt: new Date().toISOString(),
        gateway: createPersistedGatewayConfig(input),
      },
      this.options.environment,
      this.options.gatewayImage,
    );
    config.networks.push(record);
    await writeNetworkConfig(this.options.configPath, config);
    try {
      await this.ensureNetworkRuntime(record);
      return record;
    } catch (error) {
      await stopDnsmasq(record, this.options.runtimeDirectory).catch(() => undefined);
      await deleteGatewayHostRuntime(record, this.options.environment).catch(() => undefined);
      await deleteGatewayContainer(this.dockerClient, record).catch(() => undefined);
      await deleteDockerNetwork(this.dockerClient, record.dockerNetworkName).catch(() => undefined);
      config.networks = config.networks.filter((entry) => entry.id !== record.id);
      await writeNetworkConfig(this.options.configPath, config);
      throw error;
    }
  }

  async deleteIsolatedNetwork(id: string) {
    if (id === LEGACY_ISOLATED_NETWORK_ID) {
      throw new NetworkNotFoundError(id);
    }
    const config = await readNetworkConfig(this.options.configPath);
    const record = config.networks.find((entry) => entry.id === id);
    if (!record) {
      throw new NetworkNotFoundError(id);
    }

    const normalized = withNormalizedGatewayRuntime(
      record,
      this.options.environment,
      this.options.gatewayImage,
    );
    await deleteGatewayHostRuntime(normalized, this.options.environment);
    await deleteGatewayContainer(this.dockerClient, normalized);
    await stopDnsmasq(normalized, this.options.runtimeDirectory);
    await deleteDockerNetwork(this.dockerClient, normalized.dockerNetworkName);
    config.networks = config.networks.filter((entry) => entry.id !== id);
    await writeNetworkConfig(this.options.configPath, config);
  }

  async ensureNetworkRuntime(network: PersistedNetworkRecord) {
    if (network.kind !== "isolated") {
      return;
    }

    await mkdir(this.options.runtimeDirectory, { recursive: true });
    await ensureDockerBridgeNetwork(
      this.dockerClient,
      network,
      network.gatewayRuntime.hostBridgeAddress,
    );
    await ensureQemuBridgeAllowed(network.bridgeName);
    await ensureGatewayContainer(this.dockerClient, network);
    await ensureGatewayTransitLink(this.dockerClient, network);
    const uplinkInterface = await resolveHostUplinkInterface(this.options.environment);
    await ensureGatewayHostRuntime(network, uplinkInterface);
    await startDnsmasq(
      network,
      network.gatewayRuntime.insideAddress,
      this.options.runtimeDirectory,
    );
  }

  async toNetworkSummary(network: PersistedNetworkRecord, attachedComputerCount: number) {
    const inspected = await inspectNetworkStatus(
      this.dockerClient,
      network,
      this.options.environment,
      this.options.runtimeDirectory,
    );
    return {
      id: network.id,
      name: network.name,
      kind: network.kind,
      cidr: network.cidr,
      status: {
        state: inspected.state,
        bridgeName: inspected.bridgeName,
      },
      gateway: inspected.gateway,
      attachedComputerCount,
      deletable: network.kind !== "host" && attachedComputerCount === 0,
    };
  }

  async toNetworkDetail(network: PersistedNetworkRecord, attachedComputerCount: number) {
    return await this.toNetworkSummary(network, attachedComputerCount);
  }
}

export class DevelopmentNetworkProvider extends NetworkProvider {
  constructor(private readonly records: Map<string, PersistedNetworkRecord>) {
    super();
  }

  async ensureConfiguredNetworks() {}

  async listNetworkRecords() {
    const host = this.records.get(DEFAULT_HOST_NETWORK_ID) ?? {
      id: DEFAULT_HOST_NETWORK_ID,
      name: DEFAULT_HOST_NETWORK_NAME,
      kind: "host" as const,
      cidr: DEFAULT_HOST_NETWORK_CIDR,
      bridgeName: DEFAULT_HOST_BRIDGE,
      gateway: defaultGatewayConfig(),
    };
    return [host, ...[...this.records.values()].filter((record) => record.id !== host.id)];
  }

  async getNetworkRecord(id: string) {
    const record = (await this.listNetworkRecords()).find((entry) => entry.id === id);
    if (!record) {
      throw new NetworkNotFoundError(id);
    }
    return record;
  }

  async createIsolatedNetwork(input: CreateNetworkInput) {
    const cidr = normalizeIpv4Cidr(input.cidr);
    const id = `network-${slugify(input.name)}-${randomUUID().slice(0, 8)}`;
    const bridgeName = `ctd${stableHashHex(id).slice(0, 8)}`;
    const record = createIsolatedNetworkRecord(
      {
        id,
        name: input.name,
        cidr,
        bridgeName,
        dockerNetworkName: `computerd-${id}`,
        createdAt: new Date().toISOString(),
        gateway: createPersistedGatewayConfig(input),
      },
      process.env,
      undefined,
    );
    this.records.set(id, record);
    return record;
  }

  async deleteIsolatedNetwork(id: string) {
    if (!this.records.has(id)) {
      throw new NetworkNotFoundError(id);
    }
    this.records.delete(id);
  }

  async ensureNetworkRuntime() {}

  async toNetworkSummary(network: PersistedNetworkRecord, attachedComputerCount: number) {
    return {
      id: network.id,
      name: network.name,
      kind: network.kind,
      cidr: network.cidr,
      status: {
        state: "healthy",
        bridgeName: network.bridgeName,
      },
      gateway: createGatewayDetail(network, {
        overallState: "healthy",
        dhcpState: network.kind === "host" ? "unsupported" : "healthy",
        dnsState:
          network.kind === "host" ? "unsupported" : dnsStateForProvider(network, true, true),
        natState: network.kind === "host" ? "unsupported" : "healthy",
        programmableGatewayState:
          network.kind === "host"
            ? "unsupported"
            : programmableGatewayStateForProvider(network, true, true),
      }),
      attachedComputerCount,
      deletable: network.kind !== "host" && attachedComputerCount === 0,
    } satisfies NetworkSummary;
  }

  async toNetworkDetail(network: PersistedNetworkRecord, attachedComputerCount: number) {
    return await this.toNetworkSummary(network, attachedComputerCount);
  }
}

function createIsolatedNetworkRecord(
  input: Omit<PersistedIsolatedNetworkRecord, "kind" | "gatewayRuntime">,
  environment: NodeJS.ProcessEnv,
  gatewayImage: string | undefined,
): PersistedIsolatedNetworkRecord {
  return {
    ...input,
    kind: "isolated",
    gatewayRuntime: createPersistedGatewayRuntime(
      {
        id: input.id,
        cidr: input.cidr,
        bridgeName: input.bridgeName,
      },
      environment,
      gatewayImage,
    ),
  };
}

async function inspectNetworkStatus(
  docker: Docker,
  network: PersistedNetworkRecord,
  environment: NodeJS.ProcessEnv,
  runtimeDirectory: string,
) {
  if (network.kind === "host") {
    const bridgeExists = hasLink(network.bridgeName);
    return {
      state: bridgeExists ? "healthy" : "broken",
      bridgeName: network.bridgeName,
      gateway: createGatewayDetail(network, {
        overallState: bridgeExists ? "healthy" : "broken",
        dhcpState: "unsupported",
        dnsState: "unsupported",
        natState: "unsupported",
        programmableGatewayState: "unsupported",
      }),
    } as const;
  }

  const bridgeExists = hasLink(network.bridgeName);
  const dockerExists = await hasDockerNetwork(docker, network.dockerNetworkName);
  const gatewayContainerHealthy = await hasHealthyGatewayContainer(docker, network);
  const transitHealthy = hasLink(network.gatewayRuntime.hostVethName);
  const dnsmasqHealthy = await hasHealthyDnsmasq(network, runtimeDirectory);
  const egressHealthy =
    transitHealthy &&
    gatewayContainerHealthy &&
    (await resolveHostUplinkInterface(environment)
      .then((uplink) => hasLink(uplink))
      .catch(() => false));
  const dhcpState = dnsmasqHealthy ? "healthy" : bridgeExists ? "degraded" : "broken";
  const dnsState = dnsStateForProvider(network, dnsmasqHealthy, bridgeExists);
  const natState =
    bridgeExists && dockerExists && egressHealthy
      ? "healthy"
      : bridgeExists && (dockerExists || egressHealthy)
        ? "degraded"
        : "broken";
  const programmableGatewayState = programmableGatewayStateForProvider(
    network,
    bridgeExists,
    gatewayContainerHealthy,
  );
  const overallState = reduceGatewayOverallState([
    dhcpState,
    dnsState,
    natState,
    programmableGatewayState,
  ]);
  return {
    state: overallState,
    bridgeName: network.bridgeName,
    gateway: createGatewayDetail(network, {
      overallState,
      dhcpState,
      dnsState,
      natState,
      programmableGatewayState,
    }),
  } as const;
}

function hostNetworkRecord(environment: NodeJS.ProcessEnv): PersistedNetworkRecord {
  return {
    id: DEFAULT_HOST_NETWORK_ID,
    name: DEFAULT_HOST_NETWORK_NAME,
    kind: "host",
    cidr: hostNetworkCidr(environment),
    bridgeName: environment.COMPUTERD_VM_BRIDGE ?? DEFAULT_HOST_BRIDGE,
    gateway: defaultGatewayConfig(),
  };
}

async function readNetworkConfig(configPath: string) {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as { networks?: Array<Partial<PersistedIsolatedNetworkRecord>> };
    return {
      networks: Array.isArray(parsed.networks)
        ? parsed.networks.flatMap((entry) => {
            if (
              typeof entry?.id !== "string" ||
              typeof entry.name !== "string" ||
              entry.kind !== "isolated" ||
              typeof entry.cidr !== "string" ||
              typeof entry.bridgeName !== "string" ||
              typeof entry.dockerNetworkName !== "string"
            ) {
              return [];
            }
            return [
              {
                id: entry.id,
                name: entry.name,
                kind: "isolated" as const,
                cidr: entry.cidr,
                bridgeName: entry.bridgeName,
                dockerNetworkName: entry.dockerNetworkName,
                createdAt:
                  typeof entry.createdAt === "string" ? entry.createdAt : new Date(0).toISOString(),
                gateway: normalizeGatewayConfig(entry.gateway),
                gatewayRuntime: entry.gatewayRuntime as PersistedNetworkGatewayRuntime,
              },
            ];
          })
        : [],
    };
  } catch {
    return { networks: [] as PersistedIsolatedNetworkRecord[] };
  }
}

async function writeNetworkConfig(
  configPath: string,
  config: { networks: PersistedIsolatedNetworkRecord[] },
) {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        networks: [...config.networks].sort((left, right) => left.name.localeCompare(right.name)),
      },
      null,
      2,
    )}\n`,
  );
}

async function ensureDockerBridgeNetwork(
  docker: Docker,
  network: PersistedIsolatedNetworkRecord,
  gateway: string,
) {
  if (await hasDockerNetwork(docker, network.dockerNetworkName)) {
    return;
  }

  await docker.createNetwork({
    Name: network.dockerNetworkName,
    Driver: "bridge",
    CheckDuplicate: true,
    IPAM: {
      Config: [
        {
          Subnet: network.cidr,
          Gateway: gateway,
        },
      ],
    },
    Options: {
      "com.docker.network.bridge.name": network.bridgeName,
      "com.docker.network.enable_icc": "true",
      "com.docker.network.enable_ip_masquerade": "false",
    },
  });
}

async function deleteDockerNetwork(docker: Docker, networkName: string) {
  const networks = (await (docker as any).listNetworks({
    filters: {
      name: [networkName],
    },
  })) as Array<{ Id?: string; Name?: string }>;
  if (networks[0]?.Id) {
    await docker.getNetwork(networks[0].Id).remove();
  }
}

async function hasDockerNetwork(docker: Docker, networkName: string) {
  const networks = (await (docker as any).listNetworks({
    filters: {
      name: [networkName],
    },
  })) as Array<{ Id?: string; Name?: string }>;
  return networks.some((entry) => entry.Name === networkName);
}

async function ensureGatewayContainer(docker: Docker, network: PersistedIsolatedNetworkRecord) {
  const existing = await findContainerByName(docker, network.gatewayRuntime.containerName);
  const container =
    existing ??
    (await createContainerWithAutoPull(docker, network.gatewayRuntime.image, {
      name: network.gatewayRuntime.containerName,
      Image: network.gatewayRuntime.image,
      Cmd: ["/bin/sh", "-lc", "trap exit TERM INT; while :; do sleep 3600; done"],
      Labels: {
        "computerd.managed": "true",
        "computerd.network.gateway": "true",
        "computerd.network.id": network.id,
      },
      HostConfig: {
        CapAdd: ["NET_ADMIN", "NET_RAW", "NET_BIND_SERVICE"],
        Sysctls: {
          "net.ipv4.ip_forward": "1",
        },
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [network.dockerNetworkName]: {
            IPAMConfig: {
              IPv4Address: network.gatewayRuntime.insideAddress,
            },
          },
        },
      },
    }));

  try {
    await container.start();
  } catch (error: unknown) {
    if (!looksLikeAlreadyStartedError(error)) {
      throw error;
    }
  }
}

async function deleteGatewayContainer(docker: Docker, network: PersistedIsolatedNetworkRecord) {
  const container = await findContainerByName(docker, network.gatewayRuntime.containerName);
  if (!container) {
    return;
  }
  await container.remove({ force: true, v: true });
}

async function hasHealthyGatewayContainer(docker: Docker, network: PersistedIsolatedNetworkRecord) {
  const container = await findContainerByName(docker, network.gatewayRuntime.containerName);
  if (!container) {
    return false;
  }
  const inspection = await container.inspect();
  return inspection.State?.Running === true;
}

async function findContainerByName(docker: Docker, containerName: string) {
  const containers = (await (docker as any).listContainers({
    all: true,
    filters: {
      name: [containerName],
    },
  })) as Array<{ Id?: string; Names?: string[] }>;
  const match = containers.find((entry) =>
    entry.Names?.some((name) => name === `/${containerName}` || name === containerName),
  );
  return match?.Id ? docker.getContainer(match.Id) : null;
}

async function createContainerWithAutoPull(
  docker: Docker,
  image: string,
  options: Parameters<Docker["createContainer"]>[0],
) {
  try {
    return await docker.createContainer(options);
  } catch (error: unknown) {
    if (!isMissingImageError(error)) {
      throw error;
    }

    const stream = await docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (progressError: Error | null) => {
        if (progressError) {
          reject(progressError);
          return;
        }
        resolve();
      });
    });
    return await docker.createContainer(options);
  }
}

async function ensureGatewayTransitLink(docker: Docker, network: PersistedIsolatedNetworkRecord) {
  const container = await findContainerByName(docker, network.gatewayRuntime.containerName);
  if (!container) {
    throw new Error(`Gateway container "${network.gatewayRuntime.containerName}" was not found.`);
  }
  const inspection = await container.inspect();
  const pid = inspection.State?.Pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Gateway container "${network.gatewayRuntime.containerName}" is not running.`);
  }

  execCommand("/usr/sbin/ip", ["link", "del", network.gatewayRuntime.hostVethName], true);
  execCommand("/usr/sbin/ip", [
    "link",
    "add",
    network.gatewayRuntime.hostVethName,
    "type",
    "veth",
    "peer",
    "name",
    network.gatewayRuntime.gatewayVethName,
  ]);
  execCommand("/usr/sbin/ip", [
    "addr",
    "replace",
    `${network.gatewayRuntime.transitHostAddress}/30`,
    "dev",
    network.gatewayRuntime.hostVethName,
  ]);
  execCommand("/usr/sbin/ip", ["link", "set", network.gatewayRuntime.hostVethName, "up"]);
  execCommand("/usr/sbin/ip", [
    "link",
    "set",
    network.gatewayRuntime.gatewayVethName,
    "netns",
    `${pid}`,
  ]);
  execCommand("/usr/bin/nsenter", [
    "-t",
    `${pid}`,
    "-n",
    "/usr/sbin/ip",
    "link",
    "set",
    "lo",
    "up",
  ]);
  execCommand("/usr/bin/nsenter", [
    "-t",
    `${pid}`,
    "-n",
    "/usr/sbin/ip",
    "addr",
    "replace",
    `${network.gatewayRuntime.transitGatewayAddress}/30`,
    "dev",
    network.gatewayRuntime.gatewayVethName,
  ]);
  execCommand("/usr/bin/nsenter", [
    "-t",
    `${pid}`,
    "-n",
    "/usr/sbin/ip",
    "link",
    "set",
    network.gatewayRuntime.gatewayVethName,
    "up",
  ]);
  execCommand("/usr/bin/nsenter", [
    "-t",
    `${pid}`,
    "-n",
    "/usr/sbin/ip",
    "route",
    "replace",
    "default",
    "via",
    network.gatewayRuntime.transitHostAddress,
    "dev",
    network.gatewayRuntime.gatewayVethName,
  ]);
  ensureGatewayNamespaceRuntime(network, pid);
}

function ensureGatewayNamespaceRuntime(network: PersistedIsolatedNetworkRecord, pid: number) {
  ensureNamespacedIptablesRule(
    pid,
    ["-C", "FORWARD", "-i", "eth0", "-o", network.gatewayRuntime.gatewayVethName, "-j", "ACCEPT"],
    ["-A", "FORWARD", "-i", "eth0", "-o", network.gatewayRuntime.gatewayVethName, "-j", "ACCEPT"],
  );
  ensureNamespacedIptablesRule(
    pid,
    [
      "-C",
      "FORWARD",
      "-i",
      network.gatewayRuntime.gatewayVethName,
      "-o",
      "eth0",
      "-m",
      "conntrack",
      "--ctstate",
      "RELATED,ESTABLISHED",
      "-j",
      "ACCEPT",
    ],
    [
      "-A",
      "FORWARD",
      "-i",
      network.gatewayRuntime.gatewayVethName,
      "-o",
      "eth0",
      "-m",
      "conntrack",
      "--ctstate",
      "RELATED,ESTABLISHED",
      "-j",
      "ACCEPT",
    ],
  );
  ensureNamespacedIptablesRule(
    pid,
    [
      "-t",
      "nat",
      "-C",
      "POSTROUTING",
      "-s",
      network.cidr,
      "-o",
      network.gatewayRuntime.gatewayVethName,
      "-j",
      "MASQUERADE",
    ],
    [
      "-t",
      "nat",
      "-A",
      "POSTROUTING",
      "-s",
      network.cidr,
      "-o",
      network.gatewayRuntime.gatewayVethName,
      "-j",
      "MASQUERADE",
    ],
  );
}

async function ensureGatewayHostRuntime(
  network: PersistedIsolatedNetworkRecord,
  uplinkInterface: string,
) {
  execCommand("/usr/sbin/sysctl", ["-w", "net.ipv4.ip_forward=1"]);
  ensureIpRule(network.gatewayRuntime.routingMark, network.gatewayRuntime.routingTable);
  execCommand("/usr/sbin/ip", [
    "route",
    "replace",
    "table",
    `${network.gatewayRuntime.routingTable}`,
    network.cidr,
    "dev",
    network.bridgeName,
  ]);
  execCommand("/usr/sbin/ip", [
    "route",
    "replace",
    "table",
    `${network.gatewayRuntime.routingTable}`,
    "default",
    "via",
    network.gatewayRuntime.insideAddress,
    "dev",
    network.bridgeName,
  ]);
  ensureIptablesRule(
    [
      "-t",
      "mangle",
      "-C",
      "PREROUTING",
      "-i",
      network.bridgeName,
      "-s",
      network.cidr,
      "-j",
      "MARK",
      "--set-mark",
      `${network.gatewayRuntime.routingMark}`,
    ],
    [
      "-t",
      "mangle",
      "-A",
      "PREROUTING",
      "-i",
      network.bridgeName,
      "-s",
      network.cidr,
      "-j",
      "MARK",
      "--set-mark",
      `${network.gatewayRuntime.routingMark}`,
    ],
  );
  ensureIptablesRule(
    [
      "-C",
      "FORWARD",
      "-i",
      network.gatewayRuntime.hostVethName,
      "-o",
      uplinkInterface,
      "-j",
      "ACCEPT",
    ],
    [
      "-A",
      "FORWARD",
      "-i",
      network.gatewayRuntime.hostVethName,
      "-o",
      uplinkInterface,
      "-j",
      "ACCEPT",
    ],
  );
  ensureIptablesRule(
    [
      "-C",
      "FORWARD",
      "-i",
      uplinkInterface,
      "-o",
      network.gatewayRuntime.hostVethName,
      "-m",
      "conntrack",
      "--ctstate",
      "RELATED,ESTABLISHED",
      "-j",
      "ACCEPT",
    ],
    [
      "-A",
      "FORWARD",
      "-i",
      uplinkInterface,
      "-o",
      network.gatewayRuntime.hostVethName,
      "-m",
      "conntrack",
      "--ctstate",
      "RELATED,ESTABLISHED",
      "-j",
      "ACCEPT",
    ],
  );
  ensureIptablesRule(
    ["-C", "FORWARD", "-i", network.bridgeName, "-o", uplinkInterface, "-j", "REJECT"],
    ["-A", "FORWARD", "-i", network.bridgeName, "-o", uplinkInterface, "-j", "REJECT"],
  );
  ensureIptablesRule(
    [
      "-t",
      "nat",
      "-C",
      "POSTROUTING",
      "-s",
      network.gatewayRuntime.transitCidr,
      "-o",
      uplinkInterface,
      "-j",
      "MASQUERADE",
    ],
    [
      "-t",
      "nat",
      "-A",
      "POSTROUTING",
      "-s",
      network.gatewayRuntime.transitCidr,
      "-o",
      uplinkInterface,
      "-j",
      "MASQUERADE",
    ],
  );
}

async function deleteGatewayHostRuntime(
  network: PersistedIsolatedNetworkRecord,
  environment: NodeJS.ProcessEnv,
) {
  execCommand("/usr/sbin/ip", ["link", "del", network.gatewayRuntime.hostVethName], true);
  deleteIpRule(network.gatewayRuntime.routingMark, network.gatewayRuntime.routingTable);
  execCommand(
    "/usr/sbin/ip",
    ["route", "flush", "table", `${network.gatewayRuntime.routingTable}`],
    true,
  );
  execCommand(
    "/usr/sbin/iptables",
    [
      "-t",
      "mangle",
      "-D",
      "PREROUTING",
      "-i",
      network.bridgeName,
      "-s",
      network.cidr,
      "-j",
      "MARK",
      "--set-mark",
      `${network.gatewayRuntime.routingMark}`,
    ],
    true,
  );

  const uplinkInterface = await resolveHostUplinkInterface(environment).catch(() => null);
  if (!uplinkInterface) {
    return;
  }
  execCommand(
    "/usr/sbin/iptables",
    [
      "-D",
      "FORWARD",
      "-i",
      network.gatewayRuntime.hostVethName,
      "-o",
      uplinkInterface,
      "-j",
      "ACCEPT",
    ],
    true,
  );
  execCommand(
    "/usr/sbin/iptables",
    [
      "-D",
      "FORWARD",
      "-i",
      uplinkInterface,
      "-o",
      network.gatewayRuntime.hostVethName,
      "-m",
      "conntrack",
      "--ctstate",
      "RELATED,ESTABLISHED",
      "-j",
      "ACCEPT",
    ],
    true,
  );
  execCommand(
    "/usr/sbin/iptables",
    ["-D", "FORWARD", "-i", network.bridgeName, "-o", uplinkInterface, "-j", "REJECT"],
    true,
  );
  execCommand(
    "/usr/sbin/iptables",
    [
      "-t",
      "nat",
      "-D",
      "POSTROUTING",
      "-s",
      network.gatewayRuntime.transitCidr,
      "-o",
      uplinkInterface,
      "-j",
      "MASQUERADE",
    ],
    true,
  );
}

async function startDnsmasq(
  network: PersistedIsolatedNetworkRecord,
  gateway: string,
  runtimeDirectory: string,
) {
  const spec = dnsmasqSpec(network, runtimeDirectory);
  const healthy = await hasHealthyDnsmasq(network, runtimeDirectory);
  if (healthy) {
    return;
  }
  const range = dhcpRange(network.cidr);
  await mkdir(spec.directory, { recursive: true });
  await rm(spec.pidFile, { force: true }).catch(() => undefined);
  await execFileAsync("dnsmasq", [
    "--conf-file=",
    `--interface=${network.bridgeName}`,
    "--bind-interfaces",
    "--except-interface=lo",
    `--dhcp-range=${range.start},${range.end},12h`,
    `--dhcp-option=option:router,${gateway}`,
    `--dhcp-option=option:dns-server,${network.gatewayRuntime.hostBridgeAddress}`,
    `--pid-file=${spec.pidFile}`,
    `--dhcp-leasefile=${spec.leaseFile}`,
  ]);
}

async function stopDnsmasq(network: PersistedIsolatedNetworkRecord, runtimeDirectory: string) {
  const spec = dnsmasqSpec(network, runtimeDirectory);
  try {
    const pid = Number.parseInt((await readFile(spec.pidFile, "utf8")).trim(), 10);
    if (Number.isFinite(pid)) {
      process.kill(pid, "SIGTERM");
    }
  } catch {}
  await rm(spec.directory, { recursive: true, force: true });
}

async function hasHealthyDnsmasq(
  network: PersistedIsolatedNetworkRecord,
  runtimeDirectory: string,
) {
  const spec = dnsmasqSpec(network, runtimeDirectory);
  try {
    const pid = Number.parseInt((await readFile(spec.pidFile, "utf8")).trim(), 10);
    if (!Number.isFinite(pid)) {
      return false;
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function dnsmasqSpec(network: PersistedIsolatedNetworkRecord, runtimeDirectory: string) {
  const directory = join(runtimeDirectory, network.id);
  return {
    directory,
    pidFile: join(directory, "dnsmasq.pid"),
    leaseFile: join(directory, "dnsmasq.leases"),
  };
}

function hasLink(name: string) {
  try {
    execFileSync("/usr/sbin/ip", ["link", "show", "dev", name], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function ensureQemuBridgeAllowed(bridge: string) {
  let current = "";
  try {
    current = await readFile(QEMU_BRIDGE_CONFIG_PATH, "utf8");
  } catch {}
  const lines = current
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const expected = `allow ${bridge}`;
  if (lines.includes(expected)) {
    return;
  }
  lines.push(expected);
  await mkdir(dirname(QEMU_BRIDGE_CONFIG_PATH), { recursive: true });
  await writeFile(QEMU_BRIDGE_CONFIG_PATH, `${lines.join("\n")}\n`);
}

function normalizeIpv4Cidr(value: string) {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(value.trim());
  if (!match) {
    throw new Error(`Expected an IPv4 CIDR, received "${value}".`);
  }
  const prefixLength = Number.parseInt(match[2]!, 10);
  if (prefixLength < 16 || prefixLength > 29) {
    throw new Error(`Only IPv4 CIDRs with prefix length between /16 and /29 are supported.`);
  }
  const base = ipv4ToInt(match[1]!);
  const mask = prefixToMask(prefixLength);
  return `${intToIpv4(base & mask)}/${prefixLength}`;
}

function hostNetworkCidr(environment: NodeJS.ProcessEnv) {
  const configured = environment.COMPUTERD_HOST_NETWORK_CIDR;
  if (configured && configured.length > 0) {
    return normalizeIpv4Cidr(configured);
  }
  const bridgeAddress = environment.COMPUTERD_VM_BRIDGE_ADDRESS ?? DEFAULT_HOST_BRIDGE_ADDRESS;
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(bridgeAddress);
  if (!match) {
    return DEFAULT_HOST_NETWORK_CIDR;
  }
  const prefixLength = Number.parseInt(match[2]!, 10);
  const base = ipv4ToInt(match[1]!);
  const mask = prefixToMask(prefixLength);
  return `${intToIpv4(base & mask)}/${prefixLength}`;
}

function withNormalizedGatewayRuntime(
  record: PersistedIsolatedNetworkRecord,
  environment: NodeJS.ProcessEnv,
  gatewayImage: string | undefined,
): PersistedIsolatedNetworkRecord {
  return {
    ...record,
    gatewayRuntime: normalizeGatewayRuntime(record, environment, gatewayImage),
  };
}

function createPersistedGatewayRuntime(
  network: { id: string; cidr: string; bridgeName: string },
  environment: NodeJS.ProcessEnv,
  gatewayImage: string | undefined,
): PersistedNetworkGatewayRuntime {
  const { networkAddress, broadcastAddress } = parseCidr(network.cidr);
  const insideAddress = intToIpv4(networkAddress + 1);
  const hostBridgeAddress = intToIpv4(broadcastAddress - 1);
  const transitSeed = stableHashNumber(`${network.id}:transit`);
  const transitBase = ipv4ToInt(
    `100.${64 + ((transitSeed >>> 16) & 0x3f)}.${(transitSeed >>> 8) & 0xff}.0`,
  );
  return {
    image: gatewayImage ?? environment.COMPUTERD_NETWORK_GATEWAY_IMAGE ?? DEFAULT_GATEWAY_IMAGE,
    containerName: `computerd-gateway-${network.id}`,
    insideAddress,
    hostBridgeAddress,
    transitCidr: `${intToIpv4(transitBase)}/30`,
    transitHostAddress: intToIpv4(transitBase + 1),
    transitGatewayAddress: intToIpv4(transitBase + 2),
    hostVethName: `ctgw${stableHashHex(`${network.id}:host`).slice(0, 8)}`,
    gatewayVethName: `gw${stableHashHex(`${network.id}:peer`).slice(0, 8)}`,
    routingMark: 0x1000 + (stableHashNumber(`${network.id}:mark`) % 0x0fff),
    routingTable: 20_000 + (stableHashNumber(`${network.id}:table`) % 10_000),
  };
}

function normalizeGatewayRuntime(
  network: PersistedIsolatedNetworkRecord,
  environment: NodeJS.ProcessEnv,
  gatewayImage: string | undefined,
): PersistedNetworkGatewayRuntime {
  const defaults = createPersistedGatewayRuntime(network, environment, gatewayImage);
  const candidate = network.gatewayRuntime as Partial<PersistedNetworkGatewayRuntime> | undefined;
  return {
    image:
      typeof candidate?.image === "string" && candidate.image.length > 0
        ? candidate.image
        : defaults.image,
    containerName:
      typeof candidate?.containerName === "string" && candidate.containerName.length > 0
        ? candidate.containerName
        : defaults.containerName,
    insideAddress:
      typeof candidate?.insideAddress === "string" && candidate.insideAddress.length > 0
        ? candidate.insideAddress
        : defaults.insideAddress,
    hostBridgeAddress:
      typeof candidate?.hostBridgeAddress === "string" && candidate.hostBridgeAddress.length > 0
        ? candidate.hostBridgeAddress
        : defaults.hostBridgeAddress,
    transitCidr:
      typeof candidate?.transitCidr === "string" && candidate.transitCidr.length > 0
        ? candidate.transitCidr
        : defaults.transitCidr,
    transitHostAddress:
      typeof candidate?.transitHostAddress === "string" && candidate.transitHostAddress.length > 0
        ? candidate.transitHostAddress
        : defaults.transitHostAddress,
    transitGatewayAddress:
      typeof candidate?.transitGatewayAddress === "string" &&
      candidate.transitGatewayAddress.length > 0
        ? candidate.transitGatewayAddress
        : defaults.transitGatewayAddress,
    hostVethName:
      typeof candidate?.hostVethName === "string" && candidate.hostVethName.length > 0
        ? candidate.hostVethName
        : defaults.hostVethName,
    gatewayVethName:
      typeof candidate?.gatewayVethName === "string" && candidate.gatewayVethName.length > 0
        ? candidate.gatewayVethName
        : defaults.gatewayVethName,
    routingMark:
      typeof candidate?.routingMark === "number" && Number.isInteger(candidate.routingMark)
        ? candidate.routingMark
        : defaults.routingMark,
    routingTable:
      typeof candidate?.routingTable === "number" && Number.isInteger(candidate.routingTable)
        ? candidate.routingTable
        : defaults.routingTable,
  };
}

function dhcpRange(cidr: string) {
  const { networkAddress, broadcastAddress } = parseCidr(cidr);
  const start = Math.min(networkAddress + 10, broadcastAddress - 10);
  const end = Math.min(networkAddress + 200, broadcastAddress - 2);
  if (start >= end) {
    throw new Error(`CIDR "${cidr}" is too small to allocate a DHCP range.`);
  }
  return {
    start: intToIpv4(start),
    end: intToIpv4(end),
  };
}

function parseCidr(cidr: string) {
  const [address, prefix] = cidr.split("/");
  const prefixLength = Number.parseInt(prefix ?? "", 10);
  const mask = prefixToMask(prefixLength);
  const networkAddress = ipv4ToInt(address ?? "") & mask;
  const broadcastAddress = networkAddress | (~mask >>> 0);
  return {
    prefixLength,
    networkAddress,
    broadcastAddress,
  };
}

function prefixToMask(prefixLength: number) {
  return prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
}

function ipv4ToInt(address: string) {
  const octets = address.split(".").map((octet) => Number.parseInt(octet, 10));
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    throw new Error(`Expected a valid IPv4 address, received "${address}".`);
  }
  return (
    (((octets[0] ?? 0) << 24) |
      ((octets[1] ?? 0) << 16) |
      ((octets[2] ?? 0) << 8) |
      (octets[3] ?? 0)) >>>
    0
  );
}

function intToIpv4(value: number) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(
    ".",
  );
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stableHashNumber(value: string) {
  return Array.from(value).reduce(
    (hash, character) => ((hash * 33) ^ character.charCodeAt(0)) >>> 0,
    5381,
  );
}

function stableHashHex(value: string) {
  return stableHashNumber(value).toString(16);
}

export { DEFAULT_HOST_NETWORK_ID };

function legacyIsolatedNetworkRecords(
  environment: NodeJS.ProcessEnv,
  gatewayImage: string | undefined,
): PersistedNetworkRecord[] {
  const bridgeName = environment.COMPUTERD_VM_ISOLATED_BRIDGE;
  if (!bridgeName) {
    return [];
  }
  return [
    createIsolatedNetworkRecord(
      {
        id: LEGACY_ISOLATED_NETWORK_ID,
        name: "Legacy isolated network",
        cidr: normalizeIpv4Cidr(
          environment.COMPUTERD_VM_ISOLATED_BRIDGE_ADDRESS ?? "192.168.251.0/24",
        ),
        bridgeName,
        dockerNetworkName: "computerd-legacy-isolated",
        createdAt: new Date(0).toISOString(),
        gateway: defaultGatewayConfig(),
      },
      environment,
      gatewayImage,
    ),
  ];
}

function defaultGatewayConfig(): PersistedNetworkGatewayConfig {
  return {
    dhcp: {
      provider: "dnsmasq",
    },
    dns: {
      provider: "dnsmasq",
    },
    programmableGateway: {
      provider: null,
    },
  };
}

function createPersistedGatewayConfig(input: CreateNetworkInput): PersistedNetworkGatewayConfig {
  return {
    dhcp: {
      provider: "dnsmasq",
    },
    dns: {
      provider: input.gateway?.dns?.provider ?? "dnsmasq",
    },
    programmableGateway: {
      provider: input.gateway?.programmableGateway?.provider ?? null,
    },
  };
}

function normalizeGatewayConfig(value: unknown): PersistedNetworkGatewayConfig {
  if (!value || typeof value !== "object") {
    return defaultGatewayConfig();
  }

  const candidate = value as {
    dhcp?: { provider?: unknown };
    dns?: { provider?: unknown };
    programmableGateway?: { provider?: unknown };
  };

  return {
    dhcp: {
      provider: "dnsmasq",
    },
    dns: {
      provider: candidate.dns?.provider === "smartdns" ? "smartdns" : "dnsmasq",
    },
    programmableGateway: {
      provider:
        candidate.programmableGateway?.provider === "tailscale" ||
        candidate.programmableGateway?.provider === "openvpn"
          ? candidate.programmableGateway.provider
          : null,
    },
  };
}

function dnsStateForProvider(
  network: PersistedNetworkRecord,
  dnsHealthy: boolean,
  bridgeExists: boolean,
): "healthy" | "degraded" | "broken" | "unsupported" {
  if (network.kind === "host") {
    return "unsupported";
  }
  if (network.gateway.dns.provider === "dnsmasq") {
    return dnsHealthy ? "healthy" : bridgeExists ? "degraded" : "broken";
  }
  return bridgeExists ? "unsupported" : "broken";
}

function programmableGatewayStateForProvider(
  network: PersistedNetworkRecord,
  bridgeExists: boolean,
  gatewayRuntimeHealthy: boolean,
): "healthy" | "degraded" | "broken" | "unsupported" {
  if (network.kind === "host") {
    return "unsupported";
  }
  if (network.gateway.programmableGateway.provider === null) {
    return "unsupported";
  }
  if (!bridgeExists) {
    return "broken";
  }
  return gatewayRuntimeHealthy ? "degraded" : "broken";
}

function reduceGatewayOverallState(
  states: Array<"healthy" | "degraded" | "broken" | "unsupported">,
): "healthy" | "degraded" | "broken" {
  const supportedStates = states.filter((state) => state !== "unsupported");
  if (supportedStates.length === 0) {
    return "healthy";
  }
  if (supportedStates.every((state) => state === "healthy")) {
    return "healthy";
  }
  if (supportedStates.every((state) => state === "broken")) {
    return "broken";
  }
  return "degraded";
}

function createGatewayDetail(
  network: PersistedNetworkRecord,
  states: {
    overallState: "healthy" | "degraded" | "broken";
    dhcpState: "healthy" | "degraded" | "broken" | "unsupported";
    dnsState: "healthy" | "degraded" | "broken" | "unsupported";
    natState: "healthy" | "degraded" | "broken" | "unsupported";
    programmableGatewayState: "healthy" | "degraded" | "broken" | "unsupported";
  },
) {
  return {
    dhcp: {
      provider: network.gateway.dhcp.provider,
      state: states.dhcpState,
    },
    dns: {
      provider: network.gateway.dns.provider,
      state: states.dnsState,
    },
    programmableGateway: {
      provider: network.gateway.programmableGateway.provider,
      state: states.programmableGatewayState,
    },
    health: {
      state: states.overallState,
      natState: states.natState,
    },
  };
}

async function resolveHostUplinkInterface(environment: NodeJS.ProcessEnv) {
  if (environment.COMPUTERD_NETWORK_UPLINK_INTERFACE) {
    return environment.COMPUTERD_NETWORK_UPLINK_INTERFACE;
  }
  const { stdout } = await execFileAsync("/usr/sbin/ip", ["route", "show", "default"]);
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("default "));
  const match = / dev ([^ ]+)/.exec(line ?? "");
  if (!match?.[1]) {
    throw new Error("Could not resolve a host uplink interface for network egress.");
  }
  return match[1];
}

function ensureIpRule(mark: number, table: number) {
  const current = execCommand("/usr/sbin/ip", ["rule", "show"], false, true);
  const expected = `fwmark 0x${mark.toString(16)} lookup ${table}`;
  if (current.includes(expected)) {
    return;
  }
  execCommand("/usr/sbin/ip", ["rule", "add", "fwmark", `${mark}`, "table", `${table}`]);
}

function deleteIpRule(mark: number, table: number) {
  execCommand("/usr/sbin/ip", ["rule", "del", "fwmark", `${mark}`, "table", `${table}`], true);
}

function ensureIptablesRule(checkArgs: string[], addArgs: string[]) {
  try {
    execFileSync("/usr/sbin/iptables", checkArgs, {
      stdio: "ignore",
    });
  } catch {
    execCommand("/usr/sbin/iptables", addArgs);
  }
}

function ensureNamespacedIptablesRule(pid: number, checkArgs: string[], addArgs: string[]) {
  try {
    execFileSync("/usr/bin/nsenter", ["-t", `${pid}`, "-n", "/usr/sbin/iptables", ...checkArgs], {
      stdio: "ignore",
    });
  } catch {
    execCommand("/usr/bin/nsenter", ["-t", `${pid}`, "-n", "/usr/sbin/iptables", ...addArgs]);
  }
}

function execCommand(command: string, args: string[], allowFailure = false, captureStdout = false) {
  try {
    const stdout = execFileSync(command, args, {
      stdio: captureStdout ? ["ignore", "pipe", "ignore"] : "ignore",
      encoding: captureStdout ? "utf8" : undefined,
    });
    return typeof stdout === "string" ? stdout : "";
  } catch (error) {
    if (allowFailure) {
      return "";
    }
    throw error;
  }
}

function isMissingImageError(error: unknown) {
  return (
    error instanceof Error &&
    (/no such image/i.test(error.message) ||
      /not found: manifest unknown/i.test(error.message) ||
      /pull access denied/i.test(error.message))
  );
}

function looksLikeAlreadyStartedError(error: unknown) {
  return error instanceof Error && /container .* is already running/i.test(error.message);
}
