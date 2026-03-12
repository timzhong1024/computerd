import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import Docker from "dockerode";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, normalize, resolve, sep } from "node:path";
import type {
  ContainerImageDetail,
  ImageDetail,
  ImageSummary,
  ImportVmImageInput,
  VmImageDetail,
} from "@computerd/core";

export class ImageNotFoundError extends Error {
  constructor(id: string) {
    super(`Image "${id}" was not found.`);
    this.name = "ImageNotFoundError";
  }
}

export class BrokenImageError extends Error {
  constructor(id: string) {
    super(`Image "${id}" is broken and cannot be used.`);
    this.name = "BrokenImageError";
  }
}

export class ImageMutationNotAllowedError extends Error {
  constructor(id: string) {
    super(`Image "${id}" cannot be mutated by computerd.`);
    this.name = "ImageMutationNotAllowedError";
  }
}

export interface ImageProvider {
  deleteContainerImage: (id: string) => Promise<void>;
  deleteVmImage: (id: string) => Promise<void>;
  getImage: (id: string) => Promise<ImageDetail>;
  listImages: () => Promise<ImageSummary[]>;
  pullContainerImage: (reference: string) => Promise<ContainerImageDetail>;
  importVmImage: (input: ImportVmImageInput) => Promise<VmImageDetail>;
  requireVmImage: (id: string, kind: "qcow2" | "iso") => Promise<VmImageDetail>;
}

export interface CreateImageProviderOptions {
  configPath: string;
  docker?: Docker;
  dockerSocketPath: string;
  qemuImgCommand?: string;
  vmImageStoreDir: string;
  fetchImpl?: typeof fetch;
}

export function createImageProvider({
  configPath,
  docker,
  dockerSocketPath,
  qemuImgCommand = "qemu-img",
  vmImageStoreDir,
  fetchImpl = fetch,
}: CreateImageProviderOptions): ImageProvider {
  const dockerClient = docker ?? new Docker({ socketPath: dockerSocketPath });

  return {
    async listImages() {
      const [vmImages, containerImages] = await Promise.all([
        listVmImages(configPath, qemuImgCommand, vmImageStoreDir),
        listContainerImages(dockerClient),
      ]);
      return [...vmImages, ...containerImages].sort((left, right) =>
        left.name.localeCompare(right.name),
      );
    },
    async getImage(id) {
      const images = await this.listImages();
      const image = images.find((entry) => entry.id === id);
      if (!image) {
        throw new ImageNotFoundError(id);
      }

      if (image.provider === "filesystem-vm") {
        return image as VmImageDetail;
      }

      return image as ContainerImageDetail;
    },
    async requireVmImage(id, kind) {
      const image = await this.getImage(id);
      if (image.provider !== "filesystem-vm" || image.kind !== kind) {
        throw new ImageNotFoundError(id);
      }
      if (image.status === "broken") {
        throw new BrokenImageError(id);
      }
      return image;
    },
    async importVmImage(input) {
      return await importVmImage({
        configPath,
        input,
        qemuImgCommand,
        storeDir: vmImageStoreDir,
        fetchImpl,
      });
    },
    async deleteVmImage(id) {
      const detail = await this.getImage(id);
      if (detail.provider !== "filesystem-vm" || detail.sourceType !== "managed-import") {
        throw new ImageMutationNotAllowedError(id);
      }

      await deleteManagedVmImage(configPath, detail.path);
    },
    async pullContainerImage(reference) {
      const stream = await dockerClient.pull(reference);
      await new Promise<void>((resolvePull, rejectPull) => {
        dockerClient.modem.followProgress(stream, (error: Error | null) => {
          if (error) {
            rejectPull(error);
            return;
          }
          resolvePull();
        });
      });

      return await getContainerImageByReference(dockerClient, reference);
    },
    async deleteContainerImage(id) {
      const detail = await this.getImage(id);
      if (detail.provider !== "docker") {
        throw new ImageNotFoundError(id);
      }
      await dockerClient.getImage(detail.imageId).remove();
    },
  };
}

async function listVmImages(
  configPath: string,
  qemuImgCommand: string,
  vmImageStoreDir: string,
): Promise<VmImageDetail[]> {
  const config = await readImageConfig(configPath);
  const images = new Map<string, VmImageDetail>();

  for (const directory of config.directories) {
    const absoluteDirectory = resolve(directory);
    let entries;
    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const path = resolve(absoluteDirectory, entry.name);
      const image = await readVmImage(path, "directory", qemuImgCommand);
      if (image) {
        images.set(image.id, image);
      }
    }
  }

  for (const filePath of config.files) {
    const resolvedPath = resolve(filePath);
    const image = await readVmImage(
      resolvedPath,
      isManagedStorePath(vmImageStoreDir, resolvedPath) ? "managed-import" : "directory",
      qemuImgCommand,
      true,
    );
    if (image) {
      images.set(image.id, image);
    }
  }

  return [...images.values()];
}

async function readVmImage(
  filePath: string,
  sourceType: "directory" | "managed-import",
  qemuImgCommand: string,
  includeBroken = false,
): Promise<VmImageDetail | null> {
  try {
    const stats = await stat(filePath);
    if (!stats.isFile()) {
      return includeBroken ? createBrokenVmImage(filePath, sourceType) : null;
    }

    const detected = detectVmImageKind(filePath, qemuImgCommand);
    if (!detected) {
      return includeBroken ? createBrokenVmImage(filePath, sourceType) : null;
    }

    return {
      id: vmImageId(filePath),
      kind: detected.kind,
      provider: "filesystem-vm",
      name: basename(filePath),
      status: "available",
      createdAt: toOptionalIsoString(stats.birthtime),
      lastSeenAt: new Date().toISOString(),
      path: filePath,
      sizeBytes: stats.size,
      format: detected.format,
      sourceType,
    };
  } catch {
    return includeBroken ? createBrokenVmImage(filePath, sourceType) : null;
  }
}

function createBrokenVmImage(
  filePath: string,
  sourceType: "directory" | "managed-import",
): VmImageDetail {
  const kind = inferVmImageKind(filePath);
  return {
    id: vmImageId(filePath),
    kind,
    provider: "filesystem-vm",
    name: basename(filePath),
    status: "broken",
    lastSeenAt: new Date().toISOString(),
    path: filePath,
    sizeBytes: 0,
    format: kind,
    sourceType,
  };
}

function detectVmImageKind(filePath: string, qemuImgCommand: string) {
  if (extname(filePath).toLowerCase() === ".iso") {
    return {
      kind: "iso" as const,
      format: "iso" as const,
    };
  }

  try {
    const output = execFileSync(qemuImgCommand, ["info", "--output=json", filePath], {
      encoding: "utf8",
    });
    const parsed = JSON.parse(output) as { format?: string };
    if (parsed.format === "qcow2") {
      return {
        kind: "qcow2" as const,
        format: "qcow2" as const,
      };
    }
  } catch {
    return null;
  }

  return null;
}

async function listContainerImages(docker: Docker): Promise<ContainerImageDetail[]> {
  const images = await docker.listImages();
  return images.map((image) => {
    const repoTags = (image.RepoTags ?? []).filter(Boolean).sort();
    const reference = repoTags[0] ?? image.Id;
    return {
      id: containerImageId(image.Id),
      kind: "container",
      provider: "docker",
      name: reference,
      status: "available",
      createdAt:
        typeof image.Created === "number"
          ? new Date(image.Created * 1000).toISOString()
          : undefined,
      lastSeenAt: new Date().toISOString(),
      reference,
      imageId: image.Id,
      repoTags,
      sizeBytes: image.Size ?? 0,
    };
  });
}

async function getContainerImageByReference(docker: Docker, reference: string) {
  const images = await listContainerImages(docker);
  const exact = images.find(
    (image) => image.reference === reference || image.repoTags.includes(reference),
  );
  if (exact) {
    return exact;
  }

  const inspected = await docker.getImage(reference).inspect();
  return {
    id: containerImageId(inspected.Id),
    kind: "container" as const,
    provider: "docker" as const,
    name: reference,
    status: "available" as const,
    createdAt:
      typeof inspected.Created === "string" ? new Date(inspected.Created).toISOString() : undefined,
    lastSeenAt: new Date().toISOString(),
    reference,
    imageId: inspected.Id,
    repoTags: inspected.RepoTags ?? [],
    sizeBytes: inspected.Size ?? 0,
  };
}

async function readImageConfig(configPath: string) {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as {
      directories?: unknown;
      files?: unknown;
    };
    return {
      directories: sanitizeStringArray(parsed.directories),
      files: sanitizeStringArray(parsed.files),
    };
  } catch {
    return {
      directories: [],
      files: [],
    };
  }
}

async function writeImageConfig(
  configPath: string,
  config: {
    directories: string[];
    files: string[];
  },
) {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        directories: [...new Set(config.directories.map((entry) => resolve(entry)))].sort(),
        files: [...new Set(config.files.map((entry) => resolve(entry)))].sort(),
      },
      null,
      2,
    )}\n`,
  );
}

async function importVmImage({
  configPath,
  input,
  qemuImgCommand,
  storeDir,
  fetchImpl,
}: {
  configPath: string;
  input: ImportVmImageInput;
  qemuImgCommand: string;
  storeDir: string;
  fetchImpl: typeof fetch;
}) {
  await mkdir(storeDir, { recursive: true });
  const config = await readImageConfig(configPath);
  const preferredName =
    input.source.type === "file"
      ? basename(input.source.path)
      : basename(new URL(input.source.url).pathname) || "imported-image";
  const temporaryPath = resolve(storeDir, `.partial-${randomUUID()}-${preferredName}`);

  if (input.source.type === "file") {
    await copyFile(resolve(input.source.path), temporaryPath);
  } else {
    const response = await fetchImpl(input.source.url);
    if (!response.ok) {
      throw new Error(
        `Failed to download VM image from "${input.source.url}" (${response.status}).`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(temporaryPath, bytes);
  }

  try {
    const detected = detectVmImageKind(temporaryPath, qemuImgCommand);
    if (!detected) {
      throw new Error("Imported VM image must be qcow2 or iso.");
    }

    const destinationPath = await chooseAvailableStorePath(storeDir, preferredName);
    await rename(temporaryPath, destinationPath);

    config.files.push(destinationPath);
    await writeImageConfig(configPath, config);
    const image = await readVmImage(destinationPath, "managed-import", qemuImgCommand, true);
    if (!image) {
      throw new Error(`Imported VM image "${destinationPath}" could not be indexed.`);
    }
    return image;
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function deleteManagedVmImage(configPath: string, filePath: string) {
  const config = await readImageConfig(configPath);
  config.files = config.files.filter((entry) => resolve(entry) !== resolve(filePath));
  await writeImageConfig(configPath, config);
  await rm(resolve(filePath), { force: true });
}

async function chooseAvailableStorePath(storeDir: string, preferredName: string) {
  const cleanName = preferredName.length > 0 ? preferredName : "imported-image";
  const extension = extname(cleanName);
  const stem = extension.length > 0 ? cleanName.slice(0, -extension.length) : cleanName;
  let attempt = 0;
  while (true) {
    const candidateName = attempt === 0 ? cleanName : `${stem}-${attempt + 1}${extension}`;
    const candidatePath = resolve(storeDir, candidateName);
    try {
      await stat(candidatePath);
      attempt += 1;
    } catch {
      return candidatePath;
    }
  }
}

function isManagedStorePath(storeDir: string, filePath: string) {
  const normalizedStoreDir = resolve(storeDir);
  const normalizedFilePath = resolve(filePath);
  return (
    normalizedFilePath === normalizedStoreDir ||
    normalizedFilePath.startsWith(`${normalizedStoreDir}${sep}`)
  );
}

function sanitizeStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function vmImageId(filePath: string) {
  return `filesystem-vm:${stableHash(normalize(filePath))}`;
}

function containerImageId(imageId: string) {
  return `docker:${imageId}`;
}

function stableHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function inferVmImageKind(filePath: string) {
  return extname(filePath).toLowerCase() === ".iso" ? "iso" : "qcow2";
}

function toOptionalIsoString(date: Date) {
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
