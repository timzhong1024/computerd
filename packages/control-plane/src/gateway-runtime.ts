import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface GatewayRuntimeConfig {
  version: number;
  network: {
    id: string;
  };
  lan: {
    interface: string;
    cidr: string;
    gatewayAddress: string;
  };
  wan: {
    interface: string;
    transitCidr: string;
    address: string;
    nextHop: string;
  };
  dhcp: {
    provider: "dnsmasq";
    range: {
      start: string;
      end: string;
    };
    router: string;
    dnsServers: string[];
  };
  dns: {
    provider: "dnsmasq" | "smartdns";
  };
  programmableGateway: {
    provider: "tailscale" | "openvpn" | null;
  };
}

export interface GatewayRuntimeArtifacts {
  directory: string;
  configPath: string;
  healthPath: string;
}

export async function ensureGatewayRuntimeArtifacts(
  runtimeDirectory: string,
  networkId: string,
  config: GatewayRuntimeConfig,
) {
  const directory = join(runtimeDirectory, networkId);
  const configPath = join(directory, "gateway.json");
  const healthPath = join(directory, "health.json");
  await mkdir(directory, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return {
    directory,
    configPath,
    healthPath,
  } satisfies GatewayRuntimeArtifacts;
}
