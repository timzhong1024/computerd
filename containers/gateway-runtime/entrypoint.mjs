import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const CONFIG_PATH = "/etc/computerd/gateway.json";
const HEALTH_PATH = "/var/run/computerd-gateway/health.json";
const READY_PATH = "/var/run/computerd-gateway/ready";

function writeHealth(state) {
  writeFileSync(HEALTH_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "pipe", encoding: "utf8", ...options });
  if (result.status !== 0) {
    const error = result.stderr || result.stdout || `Command failed: ${command}`;
    throw new Error(error.trim());
  }
  return result.stdout.trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForInterface(name) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = spawnSync("sh", ["-lc", `ip link show dev ${name}`], { stdio: "ignore" });
    if (result.status === 0) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for interface ${name}`);
}

async function main() {
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const provider = config.programmableGateway?.provider ?? null;
  writeHealth({
    state: "starting",
    dhcpState: "broken",
    dnsState: "broken",
    natState: "broken",
    programmableGatewayState: provider === null ? "unsupported" : "degraded",
  });

  await waitForInterface(config.lan.interface);
  await waitForInterface(config.wan.interface);

  run("ip", ["link", "set", "lo", "up"]);
  run("ip", ["addr", "replace", `${config.wan.address}/30`, "dev", config.wan.interface]);
  run("ip", ["link", "set", config.wan.interface, "up"]);
  run("ip", [
    "route",
    "replace",
    "default",
    "via",
    config.wan.nextHop,
    "dev",
    config.wan.interface,
  ]);

  run("iptables", ["-P", "FORWARD", "DROP"]);
  run("sh", [
    "-lc",
    `iptables -C FORWARD -i ${config.lan.interface} -o ${config.wan.interface} -j ACCEPT || iptables -A FORWARD -i ${config.lan.interface} -o ${config.wan.interface} -j ACCEPT`,
  ]);
  run("sh", [
    "-lc",
    `iptables -C FORWARD -i ${config.wan.interface} -o ${config.lan.interface} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT || iptables -A FORWARD -i ${config.wan.interface} -o ${config.lan.interface} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`,
  ]);
  run("sh", [
    "-lc",
    `iptables -t nat -C POSTROUTING -s ${config.lan.cidr} -o ${config.wan.interface} -j MASQUERADE || iptables -t nat -A POSTROUTING -s ${config.lan.cidr} -o ${config.wan.interface} -j MASQUERADE`,
  ]);

  writeFileSync(READY_PATH, "");
  writeHealth({
    state: provider === null ? "healthy" : "degraded",
    dhcpState: "healthy",
    dnsState: config.dns.provider === "dnsmasq" ? "healthy" : "unsupported",
    natState: "healthy",
    programmableGatewayState: provider === null ? "unsupported" : "degraded",
  });

  const dnsmasq = spawn(
    "dnsmasq",
    [
      "--keep-in-foreground",
      "--log-facility=-",
      `--interface=${config.lan.interface}`,
      "--bind-interfaces",
      "--except-interface=lo",
      `--dhcp-range=${config.dhcp.range.start},${config.dhcp.range.end},12h`,
      `--dhcp-option=option:router,${config.dhcp.router}`,
      `--dhcp-option=option:dns-server,${config.dhcp.dnsServers.join(",")}`,
    ],
    {
      stdio: "inherit",
    },
  );

  dnsmasq.on("exit", (code) => {
    if (code === 0) {
      process.exit(0);
      return;
    }
    writeHealth({
      state: "broken",
      dhcpState: "broken",
      dnsState: "broken",
      natState: "broken",
      programmableGatewayState: provider === null ? "unsupported" : "broken",
      error: `dnsmasq exited with status ${code}`,
    });
    process.exit(code ?? 1);
  });
}

main().catch((error) => {
  writeHealth({
    state: "broken",
    dhcpState: "broken",
    dnsState: "broken",
    natState: "broken",
    programmableGatewayState: "broken",
    error: String(error && error.message ? error.message : error),
  });
  process.stderr.write(`${String(error && error.stack ? error.stack : error)}\n`);
  process.exit(1);
});
