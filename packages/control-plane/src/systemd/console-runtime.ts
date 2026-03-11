import { access, mkdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { HostConsoleRuntimeSpec, PersistedHostComputer } from "./types";

export interface ConsoleRuntimePathsOptions {
  runtimeDirectory: string;
}

export function createConsoleRuntimePaths({ runtimeDirectory }: ConsoleRuntimePathsOptions) {
  return {
    runtimeDirectory,
    specForComputer(computer: Pick<PersistedHostComputer, "name">): HostConsoleRuntimeSpec {
      const directoryPath = join(runtimeDirectory, slugify(computer.name));
      return {
        directoryPath,
        sessionName: `computerd-${slugify(computer.name)}`,
        socketPath: join(directoryPath, "tmux.sock"),
      };
    },
    async ensureComputerDirectory(computer: Pick<PersistedHostComputer, "name">) {
      const spec = this.specForComputer(computer);
      await mkdir(spec.directoryPath, { recursive: true });
      return spec;
    },
    async cleanupComputerDirectory(computer: Pick<PersistedHostComputer, "name">) {
      const spec = this.specForComputer(computer);
      await rm(spec.directoryPath, { recursive: true, force: true });
    },
    async hasSocket(computer: Pick<PersistedHostComputer, "name">) {
      const spec = this.specForComputer(computer);
      try {
        await access(spec.socketPath, constants.R_OK | constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
