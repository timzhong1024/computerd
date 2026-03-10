import { join } from "node:path";
import type { BrowserRuntime, BrowserViewport, PersistedBrowserComputer } from "./types";

export interface BrowserRuntimePathsOptions {
  stateRootDirectory: string;
  runtimeRootDirectory: string;
}

export const DEFAULT_BROWSER_VIEWPORT = {
  width: 1440,
  height: 900,
} as const;

export function createBrowserRuntimePaths({
  stateRootDirectory,
  runtimeRootDirectory,
}: BrowserRuntimePathsOptions) {
  return {
    stateRootDirectory,
    runtimeRootDirectory,
    specForComputer(computer: PersistedBrowserComputer) {
      const slug = slugify(computer.name);
      const stateDirectory = join(stateRootDirectory, slug);
      const runtimeDirectory = join(runtimeRootDirectory, slug);
      const portBase = 20_000 + (stableHash(slug) % 10_000);

      return {
        slug,
        stateDirectory,
        runtimeDirectory,
        homeDirectory: join(stateDirectory, "home"),
        configDirectory: join(stateDirectory, "home", ".config"),
        pipewireClientConfigDirectory: join(
          stateDirectory,
          "home",
          ".config",
          "pipewire",
          "client.conf.d",
        ),
        profileDirectory: join(stateDirectory, "profile"),
        runtimeUser: computer.runtime.runtimeUser,
        audioNodeName: `computerd-browser-${slug}`,
        devtoolsPort: portBase,
        vncPort: portBase + 1,
        xvfbDisplay: `:${100 + (stableHash(`${slug}-display`) % 100)}`,
        viewport: computer.runtime.viewport ?? DEFAULT_BROWSER_VIEWPORT,
      };
    },
  };
}

export function toBrowserRuntimeDetail(
  computer: PersistedBrowserComputer,
  options: BrowserRuntimePathsOptions,
): BrowserRuntime {
  const spec = createBrowserRuntimePaths(options).specForComputer(computer);

  return {
    browser: computer.runtime.browser,
    persistentProfile: computer.runtime.persistentProfile,
    runtimeUser: computer.runtime.runtimeUser,
    profileDirectory: spec.profileDirectory,
    runtimeDirectory: spec.runtimeDirectory,
    display: {
      protocol: "x11",
      mode: "virtual-display",
      viewport: spec.viewport,
    },
    automation: {
      protocol: "cdp",
      available: true,
    },
    audio: {
      protocol: "pipewire",
      isolation: "host-pipewire-user",
      available: true,
    },
    screenshot: {
      format: "png",
      available: true,
    },
  };
}

export function createBrowserRuntimeUser(name: string) {
  return `computerd-b-${slugify(name)}`;
}

export function withBrowserViewport(
  computer: PersistedBrowserComputer,
  viewport: BrowserViewport,
): PersistedBrowserComputer {
  return {
    ...computer,
    runtime: {
      ...computer.runtime,
      viewport,
    },
  };
}

function stableHash(value: string) {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }

  return hash;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
