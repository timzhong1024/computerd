import { ensureVmBridge } from "./ensure-vm-bridge";

test("ensures bridge, address, and qemu bridge config on linux systemd runtime", () => {
  const executed: string[] = [];
  let bridgeConfig = "";
  const execFileSyncMock = (_command: string, argsOrOptions?: unknown) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    executed.push(args.join(" "));
    if (args.join(" ") === "link show dev br0") {
      throw new Error("missing bridge");
    }

    if (args.join(" ") === "-4 addr show dev br0") {
      return "";
    }

    return "";
  };

  ensureVmBridge(
    {
      COMPUTERD_RUNTIME_MODE: "systemd",
      COMPUTERD_VM_BRIDGE: "br0",
      COMPUTERD_VM_BRIDGE_ADDRESS: "192.168.250.1/24",
    },
    "linux",
    {
      execFileSync: execFileSyncMock,
      mkdirSync() {},
      readFileSync(_path, _encoding) {
        if (bridgeConfig.length === 0) {
          throw new Error("missing");
        }

        return bridgeConfig;
      },
      writeFileSync(_path, contents) {
        bridgeConfig = String(contents);
      },
    },
  );

  expect(executed).toEqual([
    "link show dev br0",
    "link add name br0 type bridge",
    "-4 addr show dev br0",
    "addr add 192.168.250.1/24 dev br0",
    "link set br0 up",
  ]);
  expect(bridgeConfig).toContain("allow br0");
});

test("ensures isolated bridge when configured", () => {
  const executed: string[] = [];
  let bridgeConfig = "";
  const execFileSyncMock = (_command: string, argsOrOptions?: unknown) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    executed.push(args.join(" "));
    if (args.join(" ") === "link show dev br0" || args.join(" ") === "link show dev br1") {
      throw new Error("missing bridge");
    }

    if (args.join(" ") === "-4 addr show dev br0" || args.join(" ") === "-4 addr show dev br1") {
      return "";
    }

    return "";
  };

  ensureVmBridge(
    {
      COMPUTERD_RUNTIME_MODE: "systemd",
      COMPUTERD_VM_BRIDGE: "br0",
      COMPUTERD_VM_BRIDGE_ADDRESS: "192.168.250.1/24",
      COMPUTERD_VM_ISOLATED_BRIDGE: "br1",
      COMPUTERD_VM_ISOLATED_BRIDGE_ADDRESS: "192.168.251.1/24",
    },
    "linux",
    {
      execFileSync: execFileSyncMock,
      mkdirSync() {},
      readFileSync(_path, _encoding) {
        if (bridgeConfig.length === 0) {
          throw new Error("missing");
        }

        return bridgeConfig;
      },
      writeFileSync(_path, contents) {
        bridgeConfig = String(contents);
      },
    },
  );

  expect(executed).toEqual(
    expect.arrayContaining([
      "link add name br0 type bridge",
      "addr add 192.168.250.1/24 dev br0",
      "link set br0 up",
      "link add name br1 type bridge",
      "addr add 192.168.251.1/24 dev br1",
      "link set br1 up",
    ]),
  );
  expect(bridgeConfig).toContain("allow br0");
  expect(bridgeConfig).toContain("allow br1");
});

test("skips bridge setup in development runtime mode", () => {
  const execFileSync = vi.fn();

  ensureVmBridge(
    {
      COMPUTERD_RUNTIME_MODE: "development",
    },
    "linux",
    {
      execFileSync,
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
  );

  expect(execFileSync).not.toHaveBeenCalled();
});
