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

function createFakeBus({
  serviceProperties,
  unitProperties,
}: {
  serviceProperties: Record<string, { signature: string; value: unknown }>;
  unitProperties: Record<string, { signature: string; value: unknown }>;
}) {
  const properties = {
    Get() {
      throw new Error("Get is not implemented in this fake.");
    },
    async GetAll(interfaceName: string) {
      if (interfaceName === "org.freedesktop.systemd1.Unit") {
        return unitProperties;
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
