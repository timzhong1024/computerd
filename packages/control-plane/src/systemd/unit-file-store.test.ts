import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createFileUnitStore } from "./unit-file-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

test("renders browser exec start without invalid background separators", async () => {
  const root = await mkdtemp(join(tmpdir(), "computerd-unit-store-"));
  directories.push(root);
  const store = createFileUnitStore({
    directory: join(root, "units"),
    browserRuntimeDirectory: join(root, "run"),
    browserStateDirectory: join(root, "state"),
    terminalRuntimeDirectory: join(root, "terminals"),
  });

  await store.writeUnitFile({
    name: "browser-smoke",
    unitName: "computerd-browser-smoke.service",
    profile: "browser",
    createdAt: "2026-03-09T00:00:00.000Z",
    lastActionAt: "2026-03-09T00:00:00.000Z",
    runtime: {
      browser: "chromium",
      persistentProfile: true,
      viewport: {
        width: 1600,
        height: 1000,
      },
    },
    access: {
      display: {
        mode: "virtual-display",
      },
      logs: true,
    },
    resources: {},
    storage: {
      rootMode: "persistent",
    },
    network: {
      mode: "host",
    },
    lifecycle: {},
  });

  const unitFile = await readFile(join(root, "units", "computerd-browser-smoke.service"), "utf8");
  expect(unitFile).not.toContain("&;");
  expect(unitFile).toContain("CHROMIUM_SANDBOX_FLAG=--no-sandbox");
  expect(unitFile).toContain("Environment=COMPUTERD_BROWSER_VIEWPORT=1600x1000");
  expect(unitFile).toContain("--window-size=1600,1000");
});
