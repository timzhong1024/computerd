import { setTimeout as delay } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { startServer } from "./index";

test("starts listening without waiting for configured networks", async () => {
  const ensureConfiguredNetworks = vi.fn().mockRejectedValue(new Error("dnsmasq missing"));
  const listen = vi.fn((_port: number, _host: string, callback?: () => void) => {
    callback?.();
  });
  const logger = {
    log: vi.fn(),
    error: vi.fn(),
  };

  const app = {
    listen,
  };

  startServer({
    host: "127.0.0.1",
    port: 3000,
    ensureVmBridge: vi.fn(),
    controlPlane: {
      networkProvider: {
        ensureConfiguredNetworks,
      },
    } as never,
    createApp: vi.fn(() => app as never),
    logger,
  });

  expect(listen).toHaveBeenCalledWith(3000, "127.0.0.1", expect.any(Function));

  await delay(0);

  expect(ensureConfiguredNetworks).toHaveBeenCalledTimes(1);
  expect(logger.error).toHaveBeenCalledWith(
    "Failed to ensure configured networks during startup.",
    expect.any(Error),
  );
});
