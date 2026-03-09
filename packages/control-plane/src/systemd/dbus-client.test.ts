import type { MessageBus } from "dbus-next";
import { expect, test } from "vitest";
import { createSystemdDbusClient } from "./dbus-client";

test("treats LoadState=not-found as a missing unit", async () => {
  const client = createSystemdDbusClient({
    bus: createFakeBus({
      unitProperties: {
        ActiveState: variant("s", "inactive"),
        Description: variant("s", "Missing unit"),
        LoadState: variant("s", "not-found"),
        SubState: variant("s", "dead"),
      },
      serviceProperties: {},
    }),
  });

  await expect(client.getRuntimeState("computerd-missing.service")).resolves.toBeNull();
});

test("treats oversized CPUWeight sentinel values as unset", async () => {
  const client = createSystemdDbusClient({
    bus: createFakeBus({
      unitProperties: {
        ActiveState: variant("s", "active"),
        Description: variant("s", "Terminal"),
        LoadState: variant("s", "loaded"),
        SubState: variant("s", "running"),
      },
      serviceProperties: {
        CPUWeight: variant("t", BigInt("18446744073709551615")),
      },
    }),
  });

  await expect(client.getRuntimeState("computerd-terminal.service")).resolves.toMatchObject({
    cpuWeight: undefined,
  });
});

test("throws the unit name when CPUWeight is out of range", async () => {
  const client = createSystemdDbusClient({
    bus: createFakeBus({
      unitProperties: {
        ActiveState: variant("s", "active"),
        Description: variant("s", "Terminal"),
        LoadState: variant("s", "loaded"),
        SubState: variant("s", "running"),
      },
      serviceProperties: {
        CPUWeight: variant("t", BigInt(20_000)),
      },
    }),
  });

  await expect(client.getRuntimeState("computerd-terminal.service")).rejects.toThrow(
    "Unit computerd-terminal.service returned unsupported CPUWeight=",
  );
});

test("throws when CPUWeight is a non-sentinel uint64 overflow value", async () => {
  const client = createSystemdDbusClient({
    bus: createFakeBus({
      unitProperties: {
        ActiveState: variant("s", "active"),
        Description: variant("s", "Terminal"),
        LoadState: variant("s", "loaded"),
        SubState: variant("s", "running"),
      },
      serviceProperties: {
        CPUWeight: variant("t", BigInt("18446744073709551614")),
      },
    }),
  });

  await expect(client.getRuntimeState("computerd-terminal.service")).rejects.toThrow(
    "Expected 1..10000 or uint64 max sentinel",
  );
});

test("startUnit waits until the unit is no longer activating", async () => {
  const client = createSystemdDbusClient({
    bus: createFakeBus({
      unitProperties: {
        ActiveState: variant("s", "activating"),
        Description: variant("s", "Browser"),
        LoadState: variant("s", "loaded"),
        SubState: variant("s", "start"),
      },
      unitPropertiesSequence: [
        {
          ActiveState: variant("s", "activating"),
          Description: variant("s", "Browser"),
          LoadState: variant("s", "loaded"),
          SubState: variant("s", "start"),
        },
        {
          ActiveState: variant("s", "failed"),
          Description: variant("s", "Browser"),
          LoadState: variant("s", "loaded"),
          SubState: variant("s", "failed"),
        },
      ],
      serviceProperties: {
        Result: variant("s", "exit-code"),
      },
    }),
  });

  await expect(client.startUnit("computerd-browser.service")).resolves.toMatchObject({
    activeState: "failed",
    subState: "failed",
  });
});

function createFakeBus({
  serviceProperties,
  unitProperties,
  unitPropertiesSequence,
}: {
  serviceProperties: Record<string, { signature: string; value: unknown }>;
  unitProperties: Record<string, { signature: string; value: unknown }>;
  unitPropertiesSequence?: Array<Record<string, { signature: string; value: unknown }>>;
}) {
  let unitStateIndex = 0;
  const properties = {
    Get() {
      throw new Error("Get is not implemented in this fake.");
    },
    async GetAll(interfaceName: string) {
      if (interfaceName === "org.freedesktop.systemd1.Unit") {
        if (!unitPropertiesSequence) {
          return unitProperties;
        }

        const nextState =
          unitPropertiesSequence[Math.min(unitStateIndex, unitPropertiesSequence.length - 1)];
        unitStateIndex += 1;
        return nextState;
      }
      if (interfaceName === "org.freedesktop.systemd1.Service") {
        return serviceProperties;
      }

      throw new Error(`Unexpected interface ${interfaceName}`);
    },
    on() {
      // No-op for tests.
    },
  };

  const manager = {
    async DisableUnitFiles() {
      return [];
    },
    async EnableUnitFiles() {
      return [false, []] as const;
    },
    async GetUnitFileState() {
      return "disabled";
    },
    async ListUnits() {
      return [];
    },
    async LoadUnit() {
      return "/org/freedesktop/systemd1/unit/computerd_2dmissing_2eservice";
    },
    async Reload() {},
    async RestartUnit() {
      return "";
    },
    async StartUnit() {
      return "";
    },
    async StopUnit() {
      return "";
    },
    async Subscribe() {},
  };

  return {
    async getProxyObject(_busName: string, objectPath: string) {
      if (objectPath === "/org/freedesktop/systemd1") {
        return {
          getInterface() {
            return manager;
          },
        };
      }

      return {
        getInterface() {
          return properties;
        },
      };
    },
  } as unknown as MessageBus;
}

function variant(signature: string, value: unknown) {
  return { signature, value };
}
