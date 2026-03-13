import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBrowserRuntimeUser } from "./browser-runtime";
import { ComputerMetadataStore, type PersistedComputer } from "./types";

export class FileComputerMetadataStore extends ComputerMetadataStore {
  constructor(private readonly directory: string) {
    super();
  }

  async listComputers() {
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory, { withFileTypes: true });
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const payload = await readFile(join(this.directory, entry.name), "utf8");
          return normalizePersistedComputer(JSON.parse(payload) as PersistedComputer);
        }),
    );

    return records.sort((left, right) => left.name.localeCompare(right.name));
  }

  async getComputer(name: string) {
    const records = await this.listComputers();
    return records.find((record) => record.name === name) ?? null;
  }

  async putComputer(computer: PersistedComputer) {
    await mkdir(this.directory, { recursive: true });
    await writeFile(
      metadataFilePath(this.directory, computer.unitName),
      `${JSON.stringify(computer, null, 2)}\n`,
    );
  }

  async deleteComputer(name: string) {
    const computer = await this.getComputer(name);
    if (computer === null) {
      return;
    }

    await rm(metadataFilePath(this.directory, computer.unitName), { force: true });
  }
}

export class DevelopmentComputerMetadataStore extends ComputerMetadataStore {
  constructor(private readonly records: Map<string, PersistedComputer>) {
    super();
  }

  async listComputers() {
    return [...this.records.values()];
  }

  async getComputer(name: string) {
    return this.records.get(name) ?? null;
  }

  async putComputer(computer: PersistedComputer) {
    this.records.set(computer.name, computer);
  }

  async deleteComputer(name: string) {
    this.records.delete(name);
  }
}

function normalizePersistedComputer(computer: PersistedComputer): PersistedComputer {
  if (computer.profile !== "browser" || computer.runtime.runtimeUser !== undefined) {
    return computer;
  }

  return {
    ...computer,
    runtime: {
      ...computer.runtime,
      runtimeUser: createBrowserRuntimeUser(computer.name),
    },
  };
}

function metadataFilePath(directory: string, unitName: string) {
  return join(directory, `${unitName}.json`);
}
