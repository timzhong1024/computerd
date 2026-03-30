import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { FileComputerMetadataStore } from "./metadata-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

test("hydrates legacy browser metadata without runtime user", async () => {
  const root = await mkdtemp(join(tmpdir(), "computerd-metadata-store-"));
  directories.push(root);
  const store = new FileComputerMetadataStore(root);

  await writeFile(
    join(root, "computerd-chrome1.service.json"),
    `${JSON.stringify(
      {
        name: "chrome1",
        unitName: "computerd-chrome1.service",
        profile: "browser",
        createdAt: "2026-03-10T00:00:00.000Z",
        lastActionAt: "2026-03-10T00:00:00.000Z",
        runtime: {
          browser: "chromium",
          persistentProfile: true,
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
      },
      null,
      2,
    )}\n`,
  );

  const computer = await store.getComputer("chrome1");

  expect(computer).toMatchObject({
    name: "chrome1",
    profile: "browser",
    runtime: {
      runtimeUser: "computerd-b-chrome1",
    },
  });

  await store.putComputer(computer!);
  const persisted = await readFile(join(root, "computerd-chrome1.service.json"), "utf8");
  expect(persisted).toContain('"runtimeUser": "computerd-b-chrome1"');
});
