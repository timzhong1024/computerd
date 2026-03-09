import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ComputerMetadataStore, PersistedComputer } from "./types";

export interface FileComputerMetadataStoreOptions {
  directory: string;
}

export function createFileComputerMetadataStore({
  directory,
}: FileComputerMetadataStoreOptions): ComputerMetadataStore {
  async function listComputers() {
    await mkdir(directory, { recursive: true });
    const entries = await readdir(directory, { withFileTypes: true });
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const payload = await readFile(join(directory, entry.name), "utf8");
          return JSON.parse(payload) as PersistedComputer;
        }),
    );

    return records.sort((left, right) => left.name.localeCompare(right.name));
  }

  return {
    listComputers,
    async getComputer(name) {
      const records = await listComputers();
      return records.find((record) => record.name === name) ?? null;
    },
    async putComputer(computer) {
      await mkdir(directory, { recursive: true });
      await writeFile(metadataFilePath(directory, computer.unitName), `${JSON.stringify(computer, null, 2)}\n`);
    },
    async deleteComputer(name) {
      const computer = await this.getComputer(name);
      if (computer === null) {
        return;
      }

      await rm(metadataFilePath(directory, computer.unitName), { force: true });
    },
  };
}

function metadataFilePath(directory: string, unitName: string) {
  return join(directory, `${unitName}.json`);
}
