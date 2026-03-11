import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const DEFAULT_VM_BRIDGE = "br0";
const DEFAULT_VM_BRIDGE_ADDRESS = "192.168.250.1/24";
const QEMU_BRIDGE_CONFIG_DIRECTORY = "/etc/qemu";
const QEMU_BRIDGE_CONFIG_PATH = "/etc/qemu/bridge.conf";

type ExecIpFileSync = (
  file: string,
  args: readonly string[],
  options?: {
    encoding: "utf8";
    stdio: "pipe" | ["ignore", "pipe", "pipe"];
  },
) => string;

type ReadUtf8FileSync = (path: string, encoding: "utf8") => string;
type WriteUtf8FileSync = (path: string, contents: string) => void;

interface EnsureVmBridgeDeps {
  execFileSync: ExecIpFileSync;
  mkdirSync: typeof mkdirSync;
  readFileSync: ReadUtf8FileSync;
  writeFileSync: WriteUtf8FileSync;
}

export function ensureVmBridge(
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  deps: EnsureVmBridgeDeps = {
    execFileSync: execFileSync as ExecIpFileSync,
    mkdirSync,
    readFileSync: readFileSync as ReadUtf8FileSync,
    writeFileSync: writeFileSync as WriteUtf8FileSync,
  },
) {
  if ((environment.COMPUTERD_RUNTIME_MODE ?? "systemd") === "development") {
    return;
  }

  if (platform !== "linux") {
    return;
  }

  const bridge = environment.COMPUTERD_VM_BRIDGE ?? DEFAULT_VM_BRIDGE;
  const bridgeAddress = environment.COMPUTERD_VM_BRIDGE_ADDRESS ?? DEFAULT_VM_BRIDGE_ADDRESS;
  const isolatedBridge = environment.COMPUTERD_VM_ISOLATED_BRIDGE;
  const isolatedBridgeAddress = environment.COMPUTERD_VM_ISOLATED_BRIDGE_ADDRESS;

  ensureLinkExists(bridge, deps);
  ensureAddressAssigned(bridge, bridgeAddress, deps);
  execIp(["link", "set", bridge, "up"], deps);
  ensureQemuBridgeAllowed(bridge, deps);
  if (isolatedBridge !== undefined) {
    ensureLinkExists(isolatedBridge, deps);
    if (isolatedBridgeAddress !== undefined) {
      ensureAddressAssigned(isolatedBridge, isolatedBridgeAddress, deps);
    }
    execIp(["link", "set", isolatedBridge, "up"], deps);
    ensureQemuBridgeAllowed(isolatedBridge, deps);
  }
}

function ensureLinkExists(bridge: string, deps: EnsureVmBridgeDeps) {
  try {
    execIp(["link", "show", "dev", bridge], deps);
  } catch {
    execIp(["link", "add", "name", bridge, "type", "bridge"], deps);
  }
}

function ensureAddressAssigned(bridge: string, address: string, deps: EnsureVmBridgeDeps) {
  const current = execIp(["-4", "addr", "show", "dev", bridge], deps, { captureOutput: true });
  if (current.includes(address)) {
    return;
  }

  execIp(["addr", "add", address, "dev", bridge], deps);
}

function ensureQemuBridgeAllowed(bridge: string, deps: EnsureVmBridgeDeps) {
  deps.mkdirSync(QEMU_BRIDGE_CONFIG_DIRECTORY, { recursive: true });
  const expectedLine = `allow ${bridge}`;
  let current = "";

  try {
    current = deps.readFileSync(QEMU_BRIDGE_CONFIG_PATH, "utf8");
  } catch {}

  const lines = current
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.includes(expectedLine)) {
    return;
  }

  lines.push(expectedLine);
  deps.writeFileSync(QEMU_BRIDGE_CONFIG_PATH, `${lines.join("\n")}\n`);
}

function execIp(args: string[], deps: EnsureVmBridgeDeps, options?: { captureOutput?: boolean }) {
  return deps.execFileSync("/usr/sbin/ip", args, {
    encoding: "utf8",
    stdio: options?.captureOutput ? ["ignore", "pipe", "pipe"] : "pipe",
  });
}
