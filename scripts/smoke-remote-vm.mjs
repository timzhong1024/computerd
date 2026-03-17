import { spawn } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { normalize } from "node:path";

const defaults = {
  remoteHost: process.env.COMPUTERD_REMOTE_HOST,
  remoteRepo: process.env.COMPUTERD_REMOTE_REPO ?? "/root/computerd",
  remotePort: Number.parseInt(process.env.COMPUTERD_REMOTE_PORT ?? "3001", 10),
  vmBaseImage: process.env.COMPUTERD_VM_BASE_IMAGE,
  vmBridge: process.env.COMPUTERD_VM_BRIDGE ?? "br0",
  vmUser: process.env.COMPUTERD_VM_USER ?? "ubuntu",
  vmPassword: process.env.COMPUTERD_VM_PASSWORD ?? "ubuntu",
};

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const remoteHost = args.remoteHost ?? defaults.remoteHost;
const remoteRepo = args.remoteRepo ?? defaults.remoteRepo;
const remotePort = args.remotePort ?? defaults.remotePort;
const vmBaseImage = args.vmBaseImage ?? defaults.vmBaseImage;
const vmBridge = args.vmBridge ?? defaults.vmBridge;
const vmName = args.vmName ?? `vm-smoke-${Date.now().toString(36)}`;
const vmIp = args.vmIp ?? `192.168.250.${randomInt(180, 240)}`;
const vmPrefixLength = args.vmPrefixLength ?? 24;
const vmImageId = `filesystem-vm:${createHash("sha256").update(normalize(vmBaseImage)).digest("hex").slice(0, 16)}`;
const remoteServerPidFile = `/tmp/computerd-vm-remote-smoke-${remotePort}.pid`;
const remoteServerLogFile = `/tmp/computerd-vm-remote-smoke-${remotePort}.log`;

assert(
  (remoteHost ?? "").length > 0,
  "missing remote host; pass --remote-host or set COMPUTERD_REMOTE_HOST",
);
assert(
  (vmBaseImage ?? "").length > 0,
  "missing VM base image; pass --vm-base-image or set COMPUTERD_VM_BASE_IMAGE",
);

const vmPayload = {
  name: vmName,
  profile: "vm",
  access: {
    console: { mode: "pty", writable: true },
    display: { mode: "vnc" },
    logs: true,
  },
  storage: { rootMode: "persistent" },
  network: { mode: "host" },
    runtime: {
      hypervisor: "qemu",
      source: {
        kind: "qcow2",
        imageId: vmImageId,
        cloudInit: {
          enabled: true,
          user: defaults.vmUser,
          password: defaults.vmPassword,
      },
    },
    nics: [
      {
        name: "primary",
        ipv4: { type: "static", address: vmIp, prefixLength: vmPrefixLength },
        ipv6: { type: "disabled" },
      },
    ],
  },
};

console.log(`[vm-remote-smoke] target: ${remoteHost}:${remoteRepo}`);
console.log(`[vm-remote-smoke] vm: ${vmName} @ ${vmIp}/${vmPrefixLength}`);
console.log(`[vm-remote-smoke] imageId: ${vmImageId}`);

try {
  await syncWorkspace(remoteHost, remoteRepo);
  await remoteScript(
    remoteHost,
    `
set -euo pipefail
cd ${shellEscape(remoteRepo)}
pnpm install --frozen-lockfile
pnpm build
`,
  );
  await startRemoteServer(remoteHost, remoteRepo, remotePort, vmBridge);

  const created = await createRemoteComputer(remoteHost, remotePort, vmPayload);
  assert(created.profile === "vm", "create did not return a VM detail");
  assert(
    created.runtime?.nics?.[0]?.ipConfigApplied === true,
    "VM NIC config was not auto-applied",
  );
  assert(created.runtime?.bridge === vmBridge, `VM bridge mismatch: expected ${vmBridge}`);

  await postRemote(remoteHost, remotePort, `/api/computers/${vmName}/start`);
  const running = await waitForComputerState(remoteHost, remotePort, vmName, "running");
  assert(running.runtime?.nics?.[0]?.macAddress, "running VM did not expose a resolved NIC MAC");

  await waitForRemotePing(remoteHost, vmIp);
  const neighbor = await remoteScript(
    remoteHost,
    `
set -euo pipefail
ip neigh show dev ${shellEscape(vmBridge)} | grep ${shellEscape(vmIp)} || true
`,
  );

  console.log("[vm-remote-smoke] create/start/network validation passed");
  console.log(`[vm-remote-smoke] bridge neighbor: ${neighbor.stdout.trim()}`);
} finally {
  await stopAndDeleteVm(remoteHost, remotePort, vmName);
  await stopRemoteServer(remoteHost, remoteServerPidFile);
}

async function syncWorkspace(remote, target) {
  console.log("[vm-remote-smoke] syncing workspace");
  await run(
    "bash",
    [
      "-lc",
      [
        "COPYFILE_DISABLE=1 tar -cz",
        "--exclude .git",
        "--exclude node_modules",
        "--exclude dist",
        "--exclude playwright-report",
        "--exclude test-results",
        "-f - .",
        `| ssh ${shellEscape(remote)} ${shellEscape(`mkdir -p ${target} && tar -xzmf - -C ${target}`)}`,
      ].join(" "),
    ],
    { stdio: "inherit" },
  );
}

async function startRemoteServer(remote, repo, port, bridge) {
  console.log(`[vm-remote-smoke] starting remote server on :${port}`);
  await remoteScript(
    remote,
    `
set -euo pipefail
cd ${shellEscape(repo)}
rm -f ${shellEscape(remoteServerPidFile)} ${shellEscape(remoteServerLogFile)}
nohup bash -lc 'cd ${shellEscape(repo)} && PORT=${port} COMPUTERD_VM_BRIDGE=${shellEscape(bridge)} node apps/server/dist/server.js' >${shellEscape(remoteServerLogFile)} 2>&1 &
echo $! > ${shellEscape(remoteServerPidFile)}
for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:${port}/healthz >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done
cat ${shellEscape(remoteServerLogFile)} || true
exit 1
`,
  );
}

async function stopRemoteServer(remote, pidFile) {
  await remoteScript(
    remote,
    `
set -euo pipefail
if [ -f ${shellEscape(pidFile)} ]; then
  pid=$(cat ${shellEscape(pidFile)})
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -f ${shellEscape(pidFile)}
fi
`,
    { allowFailure: true },
  );
}

async function createRemoteComputer(remote, port, payload) {
  console.log("[vm-remote-smoke] creating VM");
  const response = await remoteScript(
    remote,
    `
set -euo pipefail
cat > /tmp/${shellEscape(payload.name)}.json <<'JSON'
${JSON.stringify(payload, null, 2)}
JSON
status=$(curl -sS -o /tmp/${shellEscape(payload.name)}-response.json -w '%{http_code}' -X POST \\
  -H 'content-type: application/json' \\
  --data @/tmp/${shellEscape(payload.name)}.json \\
  http://127.0.0.1:${port}/api/computers)
if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
  cat /tmp/${shellEscape(payload.name)}-response.json
  rm -f /tmp/${shellEscape(payload.name)}.json /tmp/${shellEscape(payload.name)}-response.json
  exit 22
fi
cat /tmp/${shellEscape(payload.name)}-response.json
rm -f /tmp/${shellEscape(payload.name)}.json
rm -f /tmp/${shellEscape(payload.name)}-response.json
`,
  );

  return JSON.parse(response.stdout);
}

async function stopAndDeleteVm(remote, port, name) {
  if (!name) {
    return;
  }

  await remoteScript(
    remote,
    `
set -euo pipefail
curl -sf -X POST http://127.0.0.1:${port}/api/computers/${shellEscape(name)}/stop >/dev/null || true
curl -sf -X DELETE http://127.0.0.1:${port}/api/computers/${shellEscape(name)} >/dev/null || true
`,
    { allowFailure: true },
  );
}

async function postRemote(remote, port, path) {
  const response = await remoteScript(
    remote,
    `
set -euo pipefail
curl -sf -X POST http://127.0.0.1:${port}${path}
`,
  );

  return JSON.parse(response.stdout);
}

async function fetchRemoteComputer(remote, port, name) {
  const response = await remoteScript(
    remote,
    `
set -euo pipefail
curl -sf http://127.0.0.1:${port}/api/computers/${shellEscape(name)}
`,
  );

  return JSON.parse(response.stdout);
}

async function waitForComputerState(remote, port, name, expected) {
  console.log(`[vm-remote-smoke] waiting for ${name} -> ${expected}`);
  let lastState = "unknown";

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const detail = await fetchRemoteComputer(remote, port, name);
    lastState = detail.state;
    if (detail.state === expected) {
      return detail;
    }

    await delay(1000);
  }

  throw new Error(`computer ${name} did not reach state ${expected}; last state was ${lastState}`);
}

async function waitForRemotePing(remote, ip) {
  console.log(`[vm-remote-smoke] waiting for guest ping ${ip}`);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await remoteScript(
      remote,
      `
set -euo pipefail
ping -c 1 -W 1 ${shellEscape(ip)}
`,
      { allowFailure: true },
    );

    if (result.exitCode === 0) {
      return;
    }

    await delay(1000);
  }

  throw new Error(`guest ${ip} never responded to ping`);
}

async function remoteScript(remote, script, options = {}) {
  return run("ssh", [remote, "bash", "-s"], {
    input: `${remoteShellPreamble()}\n${script}`,
    stdio: options.stdio ?? "pipe",
    allowFailure: options.allowFailure ?? false,
  });
}

async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.stdio ?? "pipe",
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    if (options.input && child.stdin) {
      child.stdin.end(options.input);
    }

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode !== 0 && !options.allowFailure) {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed with exit code ${exitCode}\n${stderr || stdout}`,
          ),
        );
        return;
      }

      resolve({ exitCode: exitCode ?? 0, stdout, stderr });
    });
  });
}

function parseArgs(rawArgs) {
  const parsed = {};

  for (let index = 0; index < rawArgs.length; index += 1) {
    const value = rawArgs[index];
    switch (value) {
      case "--":
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--remote-host":
        parsed.remoteHost = rawArgs[index + 1];
        index += 1;
        break;
      case "--remote-repo":
        parsed.remoteRepo = rawArgs[index + 1];
        index += 1;
        break;
      case "--remote-port":
        parsed.remotePort = Number.parseInt(rawArgs[index + 1] ?? "", 10);
        index += 1;
        break;
      case "--vm-name":
        parsed.vmName = rawArgs[index + 1];
        index += 1;
        break;
      case "--vm-ip":
        parsed.vmIp = rawArgs[index + 1];
        index += 1;
        break;
      case "--vm-prefix-length":
        parsed.vmPrefixLength = Number.parseInt(rawArgs[index + 1] ?? "", 10);
        index += 1;
        break;
      case "--vm-base-image":
        parsed.vmBaseImage = rawArgs[index + 1];
        index += 1;
        break;
      case "--vm-bridge":
        parsed.vmBridge = rawArgs[index + 1];
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${value}`);
    }
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage: node ./scripts/smoke-remote-vm.mjs [options]

Options:
  --remote-host <ssh-target>       required unless COMPUTERD_REMOTE_HOST is set
  --remote-repo <path>             default: ${defaults.remoteRepo}
  --remote-port <port>             default: ${defaults.remotePort}
  --vm-name <name>                 default: generated
  --vm-ip <ipv4>                   default: generated 192.168.250.x
  --vm-prefix-length <n>           default: 24
  --vm-base-image <path>           required unless COMPUTERD_VM_BASE_IMAGE is set
  --vm-bridge <bridge>             default: ${defaults.vmBridge}
`);
}

function shellEscape(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function remoteShellPreamble() {
  return `
if [ -x "$HOME/.local/share/fnm/fnm" ]; then
  eval "$("$HOME/.local/share/fnm/fnm" env --shell bash)"
fi
export PATH="$HOME/.local/share/pnpm:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
`;
}
