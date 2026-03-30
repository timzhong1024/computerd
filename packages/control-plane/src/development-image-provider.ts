import type {
  ContainerImageDetail,
  ImageDetail,
  ImportVmImageInput,
  VmImageDetail,
} from "@computerd/core";
import { BrokenImageError, ImageNotFoundError, ImageProvider } from "./images";
import { slugify } from "./shared";

export class DevelopmentImageProvider extends ImageProvider {
  constructor(private readonly images: Map<string, ImageDetail>) {
    super();
  }

  async listImages() {
    return [...this.images.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async getImage(id: string) {
    const image = this.images.get(id);
    if (!image) {
      throw new ImageNotFoundError(id);
    }

    return image;
  }

  async requireVmImage(id: string, kind: "qcow2" | "iso") {
    const image = await this.getImage(id);
    if (image.provider !== "filesystem-vm" || image.kind !== kind) {
      throw new ImageNotFoundError(id);
    }
    if (image.status === "broken") {
      throw new BrokenImageError(id);
    }
    return image;
  }

  async importVmImage(input: ImportVmImageInput) {
    const timestamp = new Date().toISOString();
    const reference =
      input.source.type === "file" ? input.source.path : new URL(input.source.url).pathname;
    const name = reference.split("/").at(-1) || "imported-image";
    const kind = (name.toLowerCase().endsWith(".iso") ? "iso" : "qcow2") as "iso" | "qcow2";
    const id = `filesystem-vm:${slugify(reference)}`;
    const image = {
      id,
      kind,
      provider: "filesystem-vm",
      name,
      status: "available",
      createdAt: timestamp,
      lastSeenAt: timestamp,
      path: `/images/${name}`,
      sizeBytes: 123_456_789,
      format: kind,
      sourceType: "managed-import",
    } satisfies VmImageDetail;

    this.images.set(id, image);
    return image;
  }

  async pullContainerImage(reference: string) {
    const existing = [...this.images.values()].find(
      (image) =>
        image.provider === "docker" &&
        (image.reference === reference || image.repoTags.includes(reference)),
    );
    if (existing?.provider === "docker") {
      return existing;
    }

    const image = {
      id: `docker:sha256:${slugify(reference)}`,
      kind: "container",
      provider: "docker",
      name: reference,
      status: "available",
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      reference,
      imageId: `sha256:${slugify(reference)}`,
      repoTags: [reference],
      sizeBytes: 123_456_789,
    } satisfies ContainerImageDetail;

    this.images.set(image.id, image);
    return image;
  }

  async deleteContainerImage(id: string) {
    const image = this.images.get(id);
    if (!image || image.provider !== "docker") {
      throw new ImageNotFoundError(id);
    }

    this.images.delete(id);
  }

  async deleteVmImage(id: string) {
    const image = this.images.get(id);
    if (!image || image.provider !== "filesystem-vm") {
      throw new ImageNotFoundError(id);
    }

    this.images.delete(id);
  }
}
