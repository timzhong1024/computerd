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
        profileDirectory: join(stateDirectory, "profile"),
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
    screenshot: {
      format: "png",
      available: true,
    },
  };
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
