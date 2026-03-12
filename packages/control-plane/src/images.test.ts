import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createImageProvider, ImageNotFoundError } from "./images";

const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("lists vm images from configured directories and explicit files", async () => {
  const root = await mkdtemp(join(tmpdir(), "computerd-images-"));
  directories.push(root);

  const imageDirectory = join(root, "images");
  await mkdir(imageDirectory, { recursive: true });
  await writeFile(join(imageDirectory, "ubuntu.iso"), "iso");
  await writeFile(join(imageDirectory, "ubuntu-cloud.img"), "qcow2");
  const missingPath = join(root, "missing.qcow2");
  await writeFile(
    join(root, "images.json"),
    JSON.stringify({
      directories: [imageDirectory],
      files: [missingPath],
    }),
  );

  const provider = createImageProvider({
    configPath: join(root, "images.json"),
    dockerSocketPath: "/var/run/docker.sock",
    qemuImgCommand: join(root, "fake-qemu-img"),
    docker: createDockerStub(),
  });

  await writeFakeQemuImg(join(root, "fake-qemu-img"));

  const images = await provider.listImages();

  expect(images).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "iso",
        provider: "filesystem-vm",
        name: "ubuntu.iso",
        status: "available",
      }),
      expect.objectContaining({
        kind: "qcow2",
        provider: "filesystem-vm",
        name: "ubuntu-cloud.img",
        status: "available",
      }),
      expect.objectContaining({
        kind: "qcow2",
        provider: "filesystem-vm",
        name: "missing.qcow2",
        status: "broken",
      }),
    ]),
  );
});

test("lists, pulls, gets and deletes container images through docker inventory", async () => {
  const docker = createDockerStub();
  const root = await mkdtemp(join(tmpdir(), "computerd-images-"));
  directories.push(root);
  await writeFile(join(root, "images.json"), JSON.stringify({}));

  const provider = createImageProvider({
    configPath: join(root, "images.json"),
    dockerSocketPath: "/var/run/docker.sock",
    docker,
  });

  const initial = await provider.listImages();
  expect(initial).toEqual([
    expect.objectContaining({
      kind: "container",
      provider: "docker",
      name: "ubuntu:24.04",
    }),
  ]);

  const pulled = await provider.pullContainerImage("node:22");
  expect(pulled.reference).toBe("node:22");

  const detail = await provider.getImage("docker:sha256:node-22");
  expect(detail).toMatchObject({
    provider: "docker",
    reference: "node:22",
  });

  await provider.deleteContainerImage("docker:sha256:node-22");
  await expect(provider.getImage("docker:sha256:node-22")).rejects.toBeInstanceOf(
    ImageNotFoundError,
  );
});

function createDockerStub() {
  const images = new Map([
    [
      "sha256:ubuntu-24-04",
      {
        Id: "sha256:ubuntu-24-04",
        RepoTags: ["ubuntu:24.04"],
        Created: 1_700_000_000,
        Size: 123,
      },
    ],
  ]);

  return {
    modem: {
      followProgress(_stream: unknown, callback: (error: Error | null) => void) {
        callback(null);
      },
    },
    async listImages() {
      return [...images.values()];
    },
    getImage(id: string) {
      return {
        async inspect() {
          const match =
            images.get(id) ??
            [...images.values()].find((image) => image.Id === id || image.RepoTags?.includes(id));
          if (!match) {
            throw new Error(`No such image: ${id}`);
          }

          return {
            Id: match.Id,
            RepoTags: match.RepoTags,
            Created: new Date().toISOString(),
            Size: match.Size,
          };
        },
        async remove() {
          images.delete(id.replace(/^docker:/, ""));
          images.delete(id);
        },
      };
    },
    async pull(reference: string) {
      const key = `sha256:${reference.replace(/[^a-z0-9]+/gi, "-")}`;
      images.set(key, {
        Id: key,
        RepoTags: [reference],
        Created: 1_700_000_000,
        Size: 456,
      });
      return {};
    },
  } as never;
}

async function writeFakeQemuImg(scriptPath: string) {
  const script = [
    "#!/usr/bin/env bash",
    "set -eu",
    'target="$3"',
    'if [[ "$target" == *.img || "$target" == *.qcow2 ]]; then',
    '  printf \'{"format":"qcow2"}\'',
    "  exit 0",
    "fi",
    "exit 1",
  ].join("\n");
  await writeFile(scriptPath, script, { mode: 0o755 });
}
