import { expect, test } from "vitest";
import { createPipeWireRuntimeEnvironment, selectPipeWireNodeTarget } from "./pipewire-host";

test("selects the newest matching pipewire browser audio node", () => {
  const target = selectPipeWireNodeTarget(
    [
      {
        id: 14,
        info: {
          props: {
            "application.name": "computerd-browser",
            "application.process.user": "computerd-b-research-browser",
            "computerd.computer.name": "research-browser",
            "media.class": "Stream/Output/Audio",
          },
        },
      },
      {
        id: 22,
        info: {
          props: {
            "application.name": "computerd-browser",
            "application.process.user": "computerd-b-research-browser",
            "computerd.computer.name": "research-browser",
            "media.class": "Stream/Output/Audio",
          },
        },
      },
      {
        id: 30,
        info: {
          props: {
            "application.name": "computerd-browser",
            "application.process.user": "computerd-b-other-browser",
            "computerd.computer.name": "other-browser",
            "media.class": "Stream/Output/Audio",
          },
        },
      },
    ],
    "research-browser",
    "computerd-b-research-browser",
  );

  expect(target?.id).toBe(22);
});

test("ignores non-browser or non-audio nodes", () => {
  const target = selectPipeWireNodeTarget(
    [
      {
        id: 10,
        info: {
          props: {
            "application.name": "computerd-browser",
            "application.process.user": "computerd-b-research-browser",
            "computerd.computer.name": "research-browser",
            "media.class": "Video/Source",
          },
        },
      },
    ],
    "research-browser",
    "computerd-b-research-browser",
  );

  expect(target).toBeUndefined();
});

test("creates a per-browser pipewire runtime environment", () => {
  const environment = createPipeWireRuntimeEnvironment(
    {
      name: "research-browser",
      unitName: "computerd-research-browser.service",
      profile: "browser",
      createdAt: "2026-03-10T00:00:00.000Z",
      lastActionAt: "2026-03-10T00:00:00.000Z",
      runtime: {
        browser: "chromium",
        persistentProfile: true,
        runtimeUser: "computerd-b-research-browser",
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
    {
      browserRuntimeDirectory: "/run/computerd/computers",
      browserStateDirectory: "/var/lib/computerd/computers",
    },
  );

  expect(environment).toEqual({
    HOME: "/var/lib/computerd/computers/research-browser/home",
    XDG_CONFIG_HOME: "/var/lib/computerd/computers/research-browser/home/.config",
    XDG_RUNTIME_DIR: "/run/computerd/computers/research-browser",
  });
});
