import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import Docker from "dockerode";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { CreateNetworkInput, NetworkDetail, NetworkSummary } from "@computerd/core";

const execFileAsync = promisify(execFile);
const DEFAULT_HOST_NETWORK_ID = "network-host";
const DEFAULT_HOST_NETWORK_NAME = "Host network";
const DEFAULT_HOST_BRIDGE = "br0";
const DEFAULT_HOST_BRIDGE_ADDRESS = "192.168.250.1/24";
const DEFAULT_HOST_NETWORK_CIDR = "192.168.250.0/24";
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

interface PersistedIsolatedNetworkRecord {
  id: string;
  name: string;
  kind: "isolated";
  cidr: string;
  bridgeName: string;
  dockerNetworkName: string;
  createdAt: string;
  gateway: PersistedNetworkGatewayConfig;
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
      ...legacyIsolatedNetworkRecords(this.options.environment),
      ...config.networks,
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
    const bridgeName = `ctd${stableHash(id).slice(0, 8)}`;
    const record: PersistedIsolatedNetworkRecord = {
      id,
      name: input.name,
      kind: "isolated",
      cidr,
      bridgeName,
      dockerNetworkName: `computerd-${id}`,
      createdAt: new Date().toISOString(),
      gateway: createPersistedGatewayConfig(input),
    };
    config.networks.push(record);
    await writeNetworkConfig(this.options.configPath, config);
    try {
      await this.ensureNetworkRuntime(record);
      return record;
    } catch (error) {
      await stopDnsmasq(record, this.options.runtimeDirectory).catch(() => undefined);
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

    await stopDnsmasq(record, this.options.runtimeDirectory);
    await deleteDockerNetwork(this.dockerClient, record.dockerNetworkName);
    config.networks = config.networks.filter((entry) => entry.id !== id);
    await writeNetworkConfig(this.options.configPath, config);
  }

  async ensureNetworkRuntime(network: PersistedNetworkRecord) {
    if (network.kind !== "isolated") {
      return;
    }

    const gateway = cidrGateway(network.cidr);
    await mkdir(this.options.runtimeDirectory, { recursive: true });
    await ensureDockerBridgeNetwork(this.dockerClient, network, gateway);
    await ensureQemuBridgeAllowed(network.bridgeName);
    await startDnsmasq(network, gateway, this.options.runtimeDirectory);
  }

  async toNetworkSummary(network: PersistedNetworkRecord, attachedComputerCount: number) {
    const inspected = await inspectNetworkStatus(
      this.dockerClient,
      network,
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
    const id = `network-${slugify(input.name)}-${randomUUID().slice(0, 8)}`;
    const record: PersistedIsolatedNetworkRecord = {
      id,
      name: input.name,
      kind: "isolated",
      cidr: normalizeIpv4Cidr(input.cidr),
      bridgeName: `ctd${stableHash(id).slice(0, 8)}`,
      dockerNetworkName: `computerd-${id}`,
      createdAt: new Date().toISOString(),
      gateway: createPersistedGatewayConfig(input),
    };
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
        programmableGatewayState: programmableGatewayStateForProvider(network, true),
      }),
      attachedComputerCount,
      deletable: network.kind !== "host" && attachedComputerCount === 0,
    } satisfies NetworkSummary;
  }

  async toNetworkDetail(network: PersistedNetworkRecord, attachedComputerCount: number) {
    return await this.toNetworkSummary(network, attachedComputerCount);
  }
}

async function inspectNetworkStatus(
  docker: Docker,
  network: PersistedNetworkRecord,
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
        programmableGatewayState: programmableGatewayStateForProvider(network, bridgeExists),
      }),
    } as const;
  }

  const bridgeExists = hasLink(network.bridgeName);
  const dockerExists = await hasDockerNetwork(docker, network.dockerNetworkName);
  const dnsmasqHealthy = await hasHealthyDnsmasq(network, runtimeDirectory);
  const dhcpState = dnsmasqHealthy ? "healthy" : bridgeExists ? "degraded" : "broken";
  const dnsState = dnsStateForProvider(network, dnsmasqHealthy, bridgeExists);
  const natState = dockerExists ? "healthy" : bridgeExists ? "degraded" : "broken";
  const programmableGatewayState = programmableGatewayStateForProvider(network, bridgeExists);
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
    const parsed = JSON.parse(raw) as { networks?: PersistedIsolatedNetworkRecord[] };
    return {
      networks: Array.isArray(parsed.networks)
        ? parsed.networks.filter((entry): entry is PersistedIsolatedNetworkRecord => {
            if (
              typeof entry?.id === "string" &&
              typeof entry?.name === "string" &&
              entry?.kind === "isolated" &&
              typeof entry?.cidr === "string" &&
              typeof entry?.bridgeName === "string" &&
              typeof entry?.dockerNetworkName === "string"
            ) {
              entry.gateway = normalizeGatewayConfig(entry.gateway);
              return true;
            }
            return false;
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
      "com.docker.network.enable_ip_masquerade": "true",
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
    "--dhcp-option=option:router," + gateway,
    "--dhcp-option=option:dns-server,1.1.1.1,8.8.8.8",
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

function cidrGateway(cidr: string) {
  const { networkAddress } = parseCidr(cidr);
  return intToIpv4(networkAddress + 1);
}

function dhcpRange(cidr: string) {
  const { networkAddress, broadcastAddress } = parseCidr(cidr);
  const start = Math.min(networkAddress + 10, broadcastAddress - 2);
  const end = Math.min(networkAddress + 200, broadcastAddress - 1);
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

function stableHash(value: string) {
  return Array.from(value)
    .reduce((hash, character) => ((hash * 33) ^ character.charCodeAt(0)) >>> 0, 5381)
    .toString(16);
}

export { DEFAULT_HOST_NETWORK_ID };

function legacyIsolatedNetworkRecords(environment: NodeJS.ProcessEnv): PersistedNetworkRecord[] {
  const bridgeName = environment.COMPUTERD_VM_ISOLATED_BRIDGE;
  if (!bridgeName) {
    return [];
  }
  return [
    {
      id: LEGACY_ISOLATED_NETWORK_ID,
      name: "Legacy isolated network",
      kind: "isolated",
      cidr: normalizeIpv4Cidr(
        environment.COMPUTERD_VM_ISOLATED_BRIDGE_ADDRESS ?? "192.168.251.0/24",
      ),
      bridgeName,
      dockerNetworkName: "computerd-legacy-isolated",
      createdAt: new Date(0).toISOString(),
      gateway: defaultGatewayConfig(),
    },
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
  const defaults = defaultGatewayConfig();
  if (!value || typeof value !== "object") {
    return defaults;
  }

  const candidate = value as {
    dhcp?: { provider?: unknown };
    dns?: { provider?: unknown };
    programmableGateway?: { provider?: unknown };
  };

  return {
    dhcp: {
      provider: candidate.dhcp?.provider === "dnsmasq" ? "dnsmasq" : "dnsmasq",
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
  dnsmasqHealthy: boolean,
  bridgeExists: boolean,
): "healthy" | "degraded" | "broken" | "unsupported" {
  if (network.kind === "host") {
    return "unsupported";
  }
  if (network.gateway.dns.provider === "dnsmasq") {
    return dnsmasqHealthy ? "healthy" : bridgeExists ? "degraded" : "broken";
  }
  return bridgeExists ? "unsupported" : "broken";
}

function programmableGatewayStateForProvider(
  network: PersistedNetworkRecord,
  bridgeExists: boolean,
): "healthy" | "degraded" | "broken" | "unsupported" {
  if (network.gateway.programmableGateway.provider === null) {
    return "unsupported";
  }
  return bridgeExists ? "unsupported" : "broken";
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
