import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import Docker from "dockerode";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, normalize, resolve } from "node:path";
import type {
  ContainerImageDetail,
  ImageDetail,
  ImageSummary,
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

export interface ImageProvider {
  deleteContainerImage: (id: string) => Promise<void>;
  getImage: (id: string) => Promise<ImageDetail>;
  listImages: () => Promise<ImageSummary[]>;
  pullContainerImage: (reference: string) => Promise<ContainerImageDetail>;
  requireVmImage: (id: string, kind: "qcow2" | "iso") => Promise<VmImageDetail>;
}

export interface CreateImageProviderOptions {
  configPath: string;
  docker?: Docker;
  dockerSocketPath: string;
  qemuImgCommand?: string;
}

export function createImageProvider({
  configPath,
  docker,
  dockerSocketPath,
  qemuImgCommand = "qemu-img",
}: CreateImageProviderOptions): ImageProvider {
  const dockerClient = docker ?? new Docker({ socketPath: dockerSocketPath });

  return {
    async listImages() {
      const [vmImages, containerImages] = await Promise.all([
        listVmImages(configPath, qemuImgCommand),
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

async function listVmImages(configPath: string, qemuImgCommand: string): Promise<VmImageDetail[]> {
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
    const image = await readVmImage(resolve(filePath), "explicit-file", qemuImgCommand, true);
    if (image) {
      images.set(image.id, image);
    }
  }

  return [...images.values()];
}

async function readVmImage(
  filePath: string,
  sourceType: "directory" | "explicit-file",
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
  sourceType: "directory" | "explicit-file",
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
