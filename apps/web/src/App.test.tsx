import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryHistory } from "@tanstack/react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { connectConsoleClient } from "./transport/console-client";
import { connectMonitorClient } from "./transport/monitor-client";

vi.mock("./transport/monitor-client", () => ({
  connectMonitorClient: vi.fn((_options: { onStateChange: (state: string) => void }) => ({
    dispose: vi.fn(),
  })),
}));

vi.mock("./transport/console-client", () => ({
  connectConsoleClient: vi.fn(() => ({
    dispose: vi.fn(),
  })),
}));

interface FakeComputer {
  name: string;
  unitName: string;
  profile: "host" | "browser" | "container" | "vm";
  state: "stopped" | "running" | "broken";
  access?: Record<string, unknown>;
  runtime: Record<string, unknown>;
  networkId?: string;
}

const hostUnits = [
  {
    unitName: "docker.service",
    unitType: "service",
    state: "active",
    description: "Docker Engine",
    capabilities: {
      canInspect: true,
    },
    command: "/usr/bin/dockerd",
    status: {
      activeState: "active",
      subState: "running",
      loadState: "loaded",
    },
    recentLogs: ["dockerd started"],
  },
];

let computers: FakeComputer[];
let images: Array<Record<string, unknown>>;
let networks: Array<Record<string, unknown>>;
let snapshotsByComputer: Record<
  string,
  Array<{ name: string; createdAt: string; sizeBytes: number }>
>;
let openSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  computers = [
    {
      name: "starter-host",
      unitName: "computerd-starter-host.service",
      profile: "host",
      state: "stopped",
      runtime: {
        command: "/usr/bin/bash",
      },
    },
    {
      name: "research-browser",
      unitName: "computerd-research-browser.service",
      profile: "browser",
      state: "running",
      runtime: {
        browser: "chromium",
        persistentProfile: true,
        runtimeUser: "computerd-b-research-browser",
        profileDirectory: "/var/lib/computerd/computers/research-browser/profile",
        runtimeDirectory: "/run/computerd/computers/research-browser",
        display: {
          protocol: "x11",
          mode: "virtual-display",
          viewport: {
            width: 1440,
            height: 900,
          },
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
      },
    },
  ];
  snapshotsByComputer = {};
  images = [
    {
      id: "filesystem-vm:dev-qcow2",
      kind: "qcow2",
      provider: "filesystem-vm",
      name: "ubuntu-cloud.qcow2",
      status: "available",
      sourceType: "directory",
    },
    {
      id: "filesystem-vm:dev-iso",
      kind: "iso",
      provider: "filesystem-vm",
      name: "ubuntu.iso",
      status: "available",
      sourceType: "directory",
    },
    {
      id: "docker:sha256:ubuntu-24-04",
      kind: "container",
      provider: "docker",
      name: "ubuntu:24.04",
      status: "available",
    },
  ];
  networks = [
    createNetworkSummary({
      id: "network-host",
      name: "Host network",
      kind: "host",
      cidr: "192.168.250.0/24",
      attachedComputerCount: 2,
      deletable: false,
      status: {
        state: "healthy",
        bridgeName: "br0",
      },
      gateway: {
        dhcp: { provider: "dnsmasq", state: "unsupported" },
        dns: { provider: "dnsmasq", state: "unsupported" },
        programmableGateway: { provider: null, state: "unsupported" },
        health: { state: "healthy", natState: "unsupported" },
      },
    }),
  ];

  vi.mocked(connectMonitorClient).mockReset();
  vi.mocked(connectMonitorClient).mockImplementation(
    ({ onStateChange }: { onStateChange: (state: "connected" | "unavailable") => void }) => {
      onStateChange("unavailable");
      return {
        dispose: vi.fn(),
      };
    },
  );
  vi.mocked(connectConsoleClient).mockReset();
  vi.mocked(connectConsoleClient).mockImplementation(() => ({
    dispose: vi.fn(),
  }));
  openSpy = vi.fn(() => ({ focus: vi.fn() }));
  vi.stubGlobal("open", openSpy);

  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";

      if (url === "/api/computers" && method === "GET") {
        return jsonResponse(computers.map((computer) => createComputerSummary(computer)));
      }

      if (url === "/api/networks" && method === "GET") {
        return jsonResponse(networks);
      }

      if (url === "/api/networks" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { name: string; cidr: string };
        const created = createNetworkSummary({
          id: `network-${body.name}`,
          name: body.name,
          kind: "isolated",
          cidr: body.cidr,
          attachedComputerCount: 0,
          deletable: true,
          status: {
            state: "healthy",
            bridgeName: "ctd12345678",
          },
          gateway: {
            dhcp: { provider: "dnsmasq", state: "healthy" },
            dns: { provider: "dnsmasq", state: "healthy" },
            programmableGateway: { provider: null, state: "unsupported" },
            health: { state: "healthy", natState: "healthy" },
          },
        });
        networks = [...networks, created];
        return jsonResponse(created, 201);
      }

      const deleteNetworkMatch = /^\/api\/networks\/(?<id>.+)$/.exec(url);
      if (deleteNetworkMatch?.groups?.id && method === "DELETE") {
        const id = decodeURIComponent(deleteNetworkMatch.groups.id);
        networks = networks.filter((network) => network.id !== id);
        return jsonResponse(null, 204);
      }

      if (url === "/api/images" && method === "GET") {
        return jsonResponse(images);
      }

      if (url === "/api/images/vm/import" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        const source = body.source as { type: "file"; path: string } | { type: "url"; url: string };
        const rawName =
          source.type === "file"
            ? (source.path.split("/").at(-1) ?? "imported.qcow2")
            : (source.url.split("/").at(-1) ?? "imported.qcow2");
        const imported = {
          id: `filesystem-vm:imported-${rawName}`,
          kind: rawName.endsWith(".iso") ? "iso" : "qcow2",
          provider: "filesystem-vm",
          name: rawName,
          status: "available",
          sourceType: "managed-import",
          path: `/var/lib/computerd/images/vm/${rawName}`,
          sizeBytes: 123,
          format: rawName.endsWith(".iso") ? "iso" : "qcow2",
        };
        images = [...images, imported];
        return jsonResponse(imported, 201);
      }

      if (url === "/api/images/vm/upload" && method === "POST") {
        const body = init?.body;
        if (typeof body !== "object" || body === null || !("get" in body)) {
          return jsonResponse({ error: "missing form data" }, 400);
        }
        const file = body.get("file");
        const fileName = file instanceof File ? file.name : "uploaded.qcow2";
        const uploaded = {
          id: `filesystem-vm:uploaded-${fileName}`,
          kind: fileName.endsWith(".iso") ? "iso" : "qcow2",
          provider: "filesystem-vm",
          name: fileName,
          status: "available",
          sourceType: "managed-import",
          path: `/var/lib/computerd/images/vm/${fileName}`,
          sizeBytes: 123,
          format: fileName.endsWith(".iso") ? "iso" : "qcow2",
        };
        images = [...images, uploaded];
        return jsonResponse(uploaded, 201);
      }

      const deleteVmImageMatch = /^\/api\/images\/vm\/(?<id>.+)$/.exec(url);
      if (deleteVmImageMatch?.groups?.id && method === "DELETE") {
        const id = decodeURIComponent(deleteVmImageMatch.groups.id);
        images = images.filter((image) => image.id !== id);
        return jsonResponse(null, 204);
      }

      if (url === "/api/images/container/pull" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { reference: string };
        const pulled = {
          id: `docker:sha256:${body.reference.replace(/[^a-z0-9]+/gi, "-")}`,
          kind: "container",
          provider: "docker",
          name: body.reference,
          status: "available",
          reference: body.reference,
          imageId: `sha256:${body.reference.replace(/[^a-z0-9]+/gi, "-")}`,
          repoTags: [body.reference],
          sizeBytes: 123,
        };
        images = [...images, pulled];
        return jsonResponse(pulled, 201);
      }

      const deleteContainerImageMatch = /^\/api\/images\/container\/(?<id>.+)$/.exec(url);
      if (deleteContainerImageMatch?.groups?.id && method === "DELETE") {
        const id = decodeURIComponent(deleteContainerImageMatch.groups.id);
        images = images.filter((image) => image.id !== id);
        return jsonResponse(null, 204);
      }

      if (url === "/api/host-units" && method === "GET") {
        return jsonResponse(
          hostUnits.map((unit) => ({
            unitName: unit.unitName,
            unitType: unit.unitType,
            state: unit.state,
            description: unit.description,
            capabilities: unit.capabilities,
          })),
        );
      }

      if (
        url.startsWith("/api/computers/") &&
        url.endsWith("/audio-sessions") &&
        method === "POST"
      ) {
        const name = decodeURIComponent(
          url.slice("/api/computers/".length, -"/audio-sessions".length),
        );
        return jsonResponse({
          computerName: name,
          protocol: "http-audio-stream",
          connect: {
            mode: "relative-websocket-path",
            url: `/api/computers/${encodeURIComponent(name)}/audio`,
          },
          authorization: {
            mode: "none",
          },
          mimeType: "audio/ogg",
        });
      }

      if (
        url.startsWith("/api/computers/") &&
        url.endsWith("/monitor-sessions") &&
        method === "POST"
      ) {
        const name = decodeURIComponent(
          url.slice("/api/computers/".length, -"/monitor-sessions".length),
        );
        return jsonResponse({
          computerName: name,
          protocol: "vnc",
          connect: {
            mode: "relative-websocket-path",
            url: `/api/computers/${encodeURIComponent(name)}/monitor/ws`,
          },
          authorization: {
            mode: "none",
          },
        });
      }

      if (
        url.startsWith("/api/computers/") &&
        url.endsWith("/console-sessions") &&
        method === "POST"
      ) {
        const name = decodeURIComponent(
          url.slice("/api/computers/".length, -"/console-sessions".length),
        );
        return jsonResponse({
          computerName: name,
          protocol: "ttyd",
          connect: {
            mode: "relative-websocket-path",
            url: `/api/computers/${encodeURIComponent(name)}/console/ws`,
          },
          authorization: {
            mode: "none",
          },
        });
      }

      if (
        url.startsWith("/api/computers/") &&
        url.endsWith("/exec-sessions") &&
        method === "POST"
      ) {
        const name = decodeURIComponent(
          url.slice("/api/computers/".length, -"/exec-sessions".length),
        );
        return jsonResponse({
          computerName: name,
          protocol: "ttyd",
          connect: {
            mode: "relative-websocket-path",
            url: `/api/computers/${encodeURIComponent(name)}/exec/ws`,
          },
          authorization: {
            mode: "none",
          },
        });
      }

      if (
        url.startsWith("/api/computers/") &&
        url.endsWith("/automation-sessions") &&
        method === "POST"
      ) {
        const name = decodeURIComponent(
          url.slice("/api/computers/".length, -"/automation-sessions".length),
        );
        return jsonResponse({
          computerName: name,
          protocol: "cdp",
          connect: {
            mode: "relative-websocket-path",
            url: `/api/computers/${encodeURIComponent(name)}/automation/ws`,
          },
          authorization: {
            mode: "none",
          },
        });
      }

      if (url.startsWith("/api/computers/") && url.endsWith("/screenshots") && method === "POST") {
        const name = decodeURIComponent(
          url.slice("/api/computers/".length, -"/screenshots".length),
        );
        return jsonResponse({
          computerName: name,
          format: "png",
          mimeType: "image/png",
          capturedAt: "2026-03-09T08:00:00.000Z",
          width: 1440,
          height: 900,
          dataBase64: "c2NyZWVuc2hvdA==",
        });
      }

      if (url.startsWith("/api/computers/") && url.endsWith("/snapshots") && method === "GET") {
        const name = decodeURIComponent(url.slice("/api/computers/".length, -"/snapshots".length));
        return jsonResponse(snapshotsByComputer[name] ?? []);
      }

      if (url.startsWith("/api/computers/") && url.endsWith("/snapshots") && method === "POST") {
        const name = decodeURIComponent(url.slice("/api/computers/".length, -"/snapshots".length));
        const body = JSON.parse(String(init?.body)) as { name: string };
        if (!snapshotsByComputer[name]) {
          snapshotsByComputer[name] = [];
        }

        const snapshot = {
          name: body.name,
          createdAt: "2026-03-10T08:00:00.000Z",
          sizeBytes: 2048,
        };
        snapshotsByComputer[name] = [snapshot, ...snapshotsByComputer[name]];
        return jsonResponse(snapshot, 201);
      }

      if (url.startsWith("/api/computers/") && url.endsWith("/restore") && method === "POST") {
        const name = decodeURIComponent(url.slice("/api/computers/".length, -"/restore".length));
        const computer = computers.find((entry) => entry.name === name);
        if (computer === undefined) {
          return jsonResponse({ error: `Computer "${name}" was not found.` }, 404);
        }

        return jsonResponse(createComputerDetail(computer));
      }

      const deleteSnapshotMatch =
        /^\/api\/computers\/(?<name>[^/]+)\/snapshots\/(?<snapshotName>[^/]+)$/.exec(url);
      if (deleteSnapshotMatch?.groups && method === "DELETE") {
        const name = decodeURIComponent(deleteSnapshotMatch.groups.name!);
        const snapshotName = decodeURIComponent(deleteSnapshotMatch.groups.snapshotName!);
        snapshotsByComputer[name] = (snapshotsByComputer[name] ?? []).filter(
          (snapshot) => snapshot.name !== snapshotName,
        );
        return jsonResponse(null, 204);
      }

      if (url.startsWith("/api/computers/") && method === "GET") {
        const name = decodeURIComponent(url.slice("/api/computers/".length));
        const computer = computers.find((entry) => entry.name === name);
        if (computer === undefined) {
          return jsonResponse({ error: `Computer "${name}" was not found.` }, 404);
        }

        return jsonResponse(createComputerDetail(computer));
      }

      if (url.startsWith("/api/computers/") && method === "DELETE") {
        const name = decodeURIComponent(url.slice("/api/computers/".length));
        computers = computers.filter((entry) => entry.name !== name);
        return jsonResponse(null, 204);
      }

      if (url.startsWith("/api/host-units/") && method === "GET") {
        return jsonResponse(hostUnits[0]);
      }

      if (url === "/api/computers" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        const nextComputer: FakeComputer = {
          name: body.name,
          unitName:
            body.profile === "container" ? `docker:${body.name}` : `computerd-${body.name}.service`,
          profile: body.profile,
          state: "stopped",
          networkId: (body.networkId as string | undefined) ?? "network-host",
          runtime:
            body.profile === "browser"
              ? {
                  ...body.runtime,
                  runtimeUser: `computerd-b-${body.name}`,
                }
              : body.profile === "container"
                ? {
                    ...body.runtime,
                    containerId: `development-${body.name}`,
                    containerName: body.name,
                  }
                : body.runtime,
        };
        computers = [...computers, nextComputer];
        return jsonResponse(createComputerDetail(nextComputer), 201);
      }

      const actionMatch = /^\/api\/computers\/(?<name>[^/]+)\/(?<action>start|stop|restart)$/.exec(
        url,
      );
      if (actionMatch?.groups) {
        const computer = computers.find((entry) => entry.name === actionMatch.groups?.name);
        if (computer === undefined) {
          return jsonResponse({ error: "missing" }, 404);
        }

        computer.state = actionMatch.groups.action === "stop" ? "stopped" : "running";
        return jsonResponse(createComputerDetail(computer));
      }

      return jsonResponse({ error: `Unhandled request ${method} ${url}` }, 500);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("renders computer inventory, host inspect, and monitor action links", async () => {
  renderApp("/");

  expect(await screen.findAllByText("starter-host")).toHaveLength(2);
  expect(await screen.findAllByText("docker.service")).toHaveLength(1);
  expect(
    screen.getByText("A computer control plane for homelab and agent workflows."),
  ).toBeInTheDocument();
  expect(await screen.findByText("computerd-starter-host.service")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /research-browser/i }));
  expect(await screen.findByTestId("open-monitor-link")).toHaveTextContent("Open monitor");
  expect(screen.getByTestId("create-automation-session")).toBeEnabled();
  expect(screen.getByTestId("capture-screenshot")).toBeEnabled();
  expect(screen.queryByTestId("open-console-link")).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId("open-monitor-link"));
  expect(openSpy).toHaveBeenCalledWith(
    "/computers/research-browser/monitor",
    "computerd-monitor-research-browser",
    expect.stringContaining("width=1472"),
  );
});

test("creates a browser computer and refreshes inventory", async () => {
  renderApp("/");

  fireEvent.change(await screen.findByLabelText("Name"), {
    target: { value: "lab-browser" },
  });
  fireEvent.change(screen.getByLabelText("Profile"), {
    target: { value: "browser" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create computer" }));

  expect(await screen.findAllByText("lab-browser")).toHaveLength(2);
  await waitFor(() => {
    expect(screen.getByText(/chromium · profile persistent/i)).toBeInTheDocument();
  });
});

test("creates and deletes isolated networks from the inventory", async () => {
  renderApp("/");

  fireEvent.change(await screen.findByLabelText("Network name"), {
    target: { value: "isolated-lab" },
  });
  fireEvent.change(screen.getByLabelText("CIDR"), {
    target: { value: "192.168.252.0/24" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create network" }));

  const networkRow = await screen.findByText("isolated-lab");
  expect(networkRow).toBeInTheDocument();

  const networkListItem = networkRow.closest("li");
  if (networkListItem === null) {
    throw new TypeError("Expected network list item");
  }
  fireEvent.click(within(networkListItem).getByRole("button", { name: "Delete" }));

  await waitFor(() => {
    expect(screen.queryByText("isolated-lab")).not.toBeInTheDocument();
  });
});

test("blocks isolated networks for browser and host computers in the create form", async () => {
  networks = [
    ...networks,
    createNetworkSummary({
      id: "network-isolated-lab",
      name: "isolated-lab",
      kind: "isolated",
      cidr: "192.168.252.0/24",
      attachedComputerCount: 0,
      deletable: true,
      status: {
        state: "healthy",
        bridgeName: "ctd12345678",
      },
      gateway: {
        dhcp: { provider: "dnsmasq", state: "healthy" },
        dns: { provider: "dnsmasq", state: "healthy" },
        programmableGateway: { provider: null, state: "unsupported" },
        health: { state: "healthy", natState: "healthy" },
      },
    }),
  ];

  renderApp("/");

  fireEvent.change(await screen.findByLabelText("Profile"), {
    target: { value: "browser" },
  });
  fireEvent.change(screen.getByLabelText("Network"), {
    target: { value: "network-isolated-lab" },
  });

  expect(
    screen.getByText(/browser computers do not support isolated networks yet/i),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create computer" })).toBeDisabled();
});

test("creates a container computer and shows exec shell affordance", async () => {
  renderApp("/");

  fireEvent.change(await screen.findByLabelText("Name"), {
    target: { value: "lab-container" },
  });
  fireEvent.change(screen.getByLabelText("Profile"), {
    target: { value: "container" },
  });
  fireEvent.change(screen.getByLabelText("Image"), {
    target: { value: "ubuntu:24.04" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create computer" }));

  expect(await screen.findByRole("button", { name: /lab-container/i })).toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "lab-container" })).toBeInTheDocument();
  expect(screen.getByText(/docker · ubuntu:24.04/i)).toBeInTheDocument();
  expect(screen.getByTestId("open-console-link")).toBeInTheDocument();
  expect(screen.getByTestId("open-exec-link")).toBeInTheDocument();

  const createRequest = vi
    .mocked(fetch)
    .mock.calls.find(
      ([url, init]) => url === "/api/computers" && (init?.method ?? "GET") === "POST",
    );
  expect(createRequest).toBeDefined();
  expect(JSON.parse(String(createRequest?.[1]?.body))).toMatchObject({
    profile: "container",
    runtime: {
      image: "ubuntu:24.04",
    },
  });
});

test("creates a vm computer and shows monitor plus console affordances", async () => {
  renderApp("/");

  fireEvent.change(await screen.findByLabelText("Name"), {
    target: { value: "linux-vm" },
  });
  fireEvent.change(screen.getByLabelText("Profile"), {
    target: { value: "vm" },
  });
  fireEvent.change(screen.getByLabelText("Base image"), {
    target: { value: "filesystem-vm:dev-qcow2" },
  });
  fireEvent.change(screen.getByLabelText("IPv4 mode"), {
    target: { value: "static" },
  });
  fireEvent.change(screen.getByLabelText("IPv4 address"), {
    target: { value: "192.168.250.10" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create computer" }));

  expect(await screen.findByRole("button", { name: /linux-vm/i })).toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "linux-vm" })).toBeInTheDocument();
  expect(screen.getByText(/qemu · qcow2/i)).toBeInTheDocument();
  expect(screen.getByText(/192.168.250.10\/24/)).toBeInTheDocument();
  expect(screen.getByTestId("open-monitor-link")).toHaveTextContent("Open monitor");
  expect(screen.getByTestId("open-console-link")).toBeInTheDocument();
  expect(screen.getByTestId("capture-screenshot")).toBeDisabled();
  expect(screen.getByTestId("vm-snapshot-list")).toHaveTextContent("No snapshots yet.");
});

test("imports and removes vm images plus pulls and deletes container images", async () => {
  renderApp("/");

  fireEvent.change(await screen.findByLabelText("Import source"), {
    target: { value: "file" },
  });
  fireEvent.change(screen.getByLabelText("File path"), {
    target: { value: "/images/imported.qcow2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Import VM image" }));

  expect(await screen.findByText(/imported.qcow2/i)).toBeInTheDocument();
  const uploadInput = screen.getByLabelText("Upload image") as HTMLInputElement;
  fireEvent.change(uploadInput, {
    target: {
      files: [new File(["qcow2"], "uploaded.qcow2", { type: "application/octet-stream" })],
    },
  });
  await waitFor(() => {
    expect(uploadInput.files?.[0]?.name).toBe("uploaded.qcow2");
  });
  const uploadForm = uploadInput.closest("form");
  if (uploadForm === null) {
    throw new TypeError("Expected upload form");
  }
  fireEvent.submit(uploadForm);
  expect(await screen.findByText(/uploaded.qcow2/i)).toBeInTheDocument();
  const importedImageRow = screen.getByText(/imported.qcow2/i).closest("li");
  if (importedImageRow === null) {
    throw new TypeError("Expected imported image row");
  }
  fireEvent.click(within(importedImageRow).getByRole("button", { name: "Remove" }));
  await waitFor(() => {
    expect(screen.queryByText(/imported.qcow2/i)).not.toBeInTheDocument();
  });

  fireEvent.change(screen.getByLabelText("Image reference"), {
    target: { value: "node:22" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Pull container image" }));
  const nodeImageRow = (await screen.findByText("node:22")).closest("li");
  if (nodeImageRow === null) {
    throw new TypeError("Expected node:22 image row");
  }
  fireEvent.click(within(nodeImageRow).getByRole("button", { name: "Delete" }));
  await waitFor(() => {
    expect(screen.queryByText("node:22")).not.toBeInTheDocument();
  });
});

test("manages vm snapshots from the detail page", async () => {
  snapshotsByComputer["linux-vm"] = [
    {
      name: "baseline",
      createdAt: "2026-03-09T08:00:00.000Z",
      sizeBytes: 1024,
    },
  ];
  computers.push({
    name: "linux-vm",
    unitName: "computerd-linux-vm.service",
    profile: "vm",
    state: "stopped",
    runtime: {
      hypervisor: "qemu",
      accelerator: "kvm",
      architecture: "x86_64",
      machine: "q35",
      bridge: "br0",
      diskImagePath: "/var/lib/computerd/computers/linux-vm/vm/disk.qcow2",
      serialSocketPath: "/run/computerd/computers/linux-vm/vm/serial.sock",
      nics: [
        {
          name: "primary",
          macAddress: "52:54:00:12:34:56",
          ipConfigApplied: true,
          ipv4: {
            type: "dhcp",
          },
        },
      ],
      source: {
        kind: "qcow2",
        imageId: "filesystem-vm:dev-qcow2",
        cloudInit: {
          user: "ubuntu",
        },
      },
      vncDisplay: 20,
      vncPort: 5920,
      displayViewport: {
        width: 1440,
        height: 900,
      },
    },
  });

  renderApp("/");

  fireEvent.click(await screen.findByRole("button", { name: /linux-vm/i }));
  expect(await screen.findByTestId("vm-snapshot-list")).toHaveTextContent("baseline");

  fireEvent.change(screen.getByLabelText("Snapshot name"), {
    target: { value: "checkpoint-2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create snapshot" }));

  await waitFor(() => {
    expect(screen.getByTestId("vm-snapshot-list")).toHaveTextContent("checkpoint-2");
  });

  fireEvent.click(screen.getByTestId("restore-snapshot-checkpoint-2"));
  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "linux-vm" })).toBeInTheDocument();
  });

  fireEvent.click(screen.getByTestId("delete-snapshot-checkpoint-2"));
  await waitFor(() => {
    expect(screen.getByTestId("vm-snapshot-list")).not.toHaveTextContent("checkpoint-2");
  });
});

test("disables vm snapshot mutations while running", async () => {
  computers.push({
    name: "running-vm",
    unitName: "computerd-running-vm.service",
    profile: "vm",
    state: "running",
    runtime: {
      hypervisor: "qemu",
      accelerator: "kvm",
      architecture: "x86_64",
      machine: "q35",
      bridge: "br0",
      diskImagePath: "/var/lib/computerd/computers/running-vm/vm/disk.qcow2",
      serialSocketPath: "/run/computerd/computers/running-vm/vm/serial.sock",
      nics: [
        {
          name: "primary",
          macAddress: "52:54:00:12:34:56",
          ipConfigApplied: true,
          ipv4: {
            type: "dhcp",
          },
        },
      ],
      source: {
        kind: "qcow2",
        imageId: "filesystem-vm:dev-qcow2",
        cloudInit: {
          user: "ubuntu",
        },
      },
      vncDisplay: 20,
      vncPort: 5920,
      displayViewport: {
        width: 1440,
        height: 900,
      },
    },
  });

  renderApp("/");

  fireEvent.click(await screen.findByRole("button", { name: /running-vm/i }));

  expect(await screen.findByTestId("capture-screenshot")).toBeEnabled();
  expect(await screen.findByRole("button", { name: "Create snapshot" })).toBeDisabled();
  expect(screen.getByTestId("restore-initial")).toBeDisabled();
});

test("deletes a selected computer and refreshes the inventory", async () => {
  renderApp("/");

  fireEvent.click(await screen.findByRole("button", { name: /starter-host/i }));
  fireEvent.click(await screen.findByTestId("computer-action-delete"));

  await waitFor(() => {
    expect(screen.queryByRole("button", { name: /starter-host/i })).not.toBeInTheDocument();
  });
  expect(screen.getByRole("button", { name: /research-browser/i })).toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "research-browser" })).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("renders monitor session shell and unavailable websocket state", async () => {
  const playSpy = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockRejectedValue(new DOMException("blocked", "NotAllowedError"));

  renderApp("/computers/research-browser/monitor");

  expect(await screen.findByTestId("novnc-shell")).toBeInTheDocument();
  expect(await screen.findByTestId("browser-audio")).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Enable audio" })).toBeInTheDocument();
  expect(await screen.findByTestId("monitor-state")).toHaveTextContent(
    "video unavailable / audio blocked by autoplay",
  );
  await waitFor(() => {
    expect(document.title).toBe("research-browser - Computerd Monitor");
  });
  expect(connectMonitorClient).toHaveBeenCalled();
  playSpy.mockRestore();
});

test("retries blocked monitor audio after clicking enable audio", async () => {
  const playSpy = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"))
    .mockResolvedValueOnce(undefined);

  renderApp("/computers/research-browser/monitor");

  const button = await screen.findByRole("button", { name: "Enable audio" });
  fireEvent.click(button);

  await waitFor(() => {
    expect(screen.getByTestId("monitor-state")).toHaveTextContent(
      "video unavailable / audio connected",
    );
  });

  expect(playSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  playSpy.mockRestore();
});

test("does not re-block audio after a manual enable click", async () => {
  const playSpy = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"))
    .mockResolvedValueOnce(undefined);

  renderApp("/computers/research-browser/monitor");

  const audio = (await screen.findByTestId("browser-audio")) as HTMLAudioElement;
  fireEvent.click(await screen.findByRole("button", { name: "Enable audio" }));
  fireEvent(audio, new Event("canplay"));

  await waitFor(() => {
    expect(screen.getByTestId("monitor-state")).toHaveTextContent(
      "video unavailable / audio connected",
    );
  });

  expect(playSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  playSpy.mockRestore();
});

test("creates browser automation sessions and screenshot previews from the detail page", async () => {
  renderApp("/");

  fireEvent.click(await screen.findByRole("button", { name: /research-browser/i }));
  fireEvent.click(await screen.findByTestId("create-automation-session"));
  expect(await screen.findByTestId("automation-connect-url")).toHaveTextContent(
    "/api/computers/research-browser/automation/ws",
  );

  fireEvent.click(screen.getByTestId("capture-screenshot"));
  expect(await screen.findByTestId("computer-screenshot-preview")).toHaveAttribute(
    "src",
    "data:image/png;base64,c2NyZWVuc2hvdA==",
  );
});

test("surfaces monitor session request failures", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/computers/missing/monitor-sessions") {
        return jsonResponse({ error: 'Computer "missing" was not found.' }, 404);
      }

      return jsonResponse({ error: `Unhandled request GET ${url}` }, 500);
    }),
  );

  renderApp("/computers/missing/monitor");

  expect(await screen.findByRole("alert")).toHaveTextContent(/missing/i);
});

test("renders console placeholder route", async () => {
  renderApp("/computers/starter-host/console");

  expect(await screen.findByText("Console shell")).toBeInTheDocument();
  expect(await screen.findByTestId("console-shell")).toBeInTheDocument();
  expect(screen.getByTestId("console-state")).toHaveTextContent("connecting");
  expect(connectConsoleClient).toHaveBeenCalledWith(
    expect.objectContaining({
      computerName: "starter-host",
      onStateChange: expect.any(Function),
    }),
  );
});

test("shows exec shell without console link for exec-only containers", async () => {
  computers.unshift({
    name: "workspace-container",
    unitName: "docker:workspace-container",
    profile: "container",
    state: "running",
    access: {
      logs: true,
    },
    runtime: {
      provider: "docker",
      image: "ubuntu:24.04",
      command: "sleep infinity",
      containerId: "container-123",
      containerName: "workspace-container",
    },
  });

  renderApp("/");

  fireEvent.click(await screen.findByRole("button", { name: /workspace-container/i }));

  expect(await screen.findByTestId("open-exec-link")).toBeInTheDocument();
  expect(screen.queryByTestId("open-console-link")).not.toBeInTheDocument();
});

test("hides lifecycle and surface actions for broken computers", async () => {
  computers.unshift({
    name: "broken-container",
    unitName: "docker:broken-container",
    profile: "container",
    state: "broken",
    access: {
      console: {
        mode: "pty",
        writable: true,
      },
      logs: true,
    },
    runtime: {
      provider: "docker",
      image: "ubuntu:24.04",
      command: "sleep infinity",
      containerId: "missing-container",
      containerName: "broken-container",
    },
  });

  renderApp("/");

  fireEvent.click(await screen.findByRole("button", { name: /broken-container/i }));

  expect(await screen.findByTestId("computer-state")).toHaveTextContent("broken");
  expect(screen.queryByTestId("open-console-link")).not.toBeInTheDocument();
  expect(screen.queryByTestId("open-exec-link")).not.toBeInTheDocument();
  expect(screen.queryByTestId("computer-action-delete")).not.toBeInTheDocument();
  expect(screen.getByTestId("computer-action-start")).toBeDisabled();
  expect(screen.getByTestId("computer-action-stop")).toBeDisabled();
  expect(screen.getByTestId("computer-action-restart")).toBeDisabled();
});

test("renders exec placeholder route", async () => {
  renderApp("/computers/workspace-container/exec");

  expect(await screen.findByText("Console shell")).toBeInTheDocument();
  expect(await screen.findByTestId("console-shell")).toBeInTheDocument();
  expect(screen.getByTestId("console-state")).toHaveTextContent("connecting");
  expect(connectConsoleClient).toHaveBeenCalledWith(
    expect.objectContaining({
      computerName: "workspace-container",
      mode: "exec",
      onStateChange: expect.any(Function),
    }),
  );
});

function renderApp(initialPath: string) {
  const history = createMemoryHistory({
    initialEntries: [initialPath],
  });

  return render(<App history={history} />);
}

function createComputerSummary(computer: FakeComputer) {
  const networkId = computer.networkId ?? "network-host";
  const network =
    networks.find((entry) => entry.id === networkId) ??
    createNetworkSummary({
      id: networkId,
      name: networkId,
      kind: "isolated",
      cidr: "192.168.252.0/24",
      attachedComputerCount: 0,
      deletable: true,
      status: {
        state: "healthy",
        bridgeName: "ctd12345678",
      },
      gateway: {
        dhcp: { provider: "dnsmasq", state: "healthy" },
        dns: { provider: "dnsmasq", state: "healthy" },
        programmableGateway: { provider: null, state: "unsupported" },
        health: { natState: "healthy", state: "healthy" },
      },
    });
  return {
    name: computer.name,
    unitName: computer.unitName,
    profile: computer.profile,
    state: computer.state,
    createdAt: "2026-03-09T08:00:00.000Z",
    access:
      computer.access ??
      (computer.profile === "host"
        ? {
            console: {
              mode: "pty",
              writable: true,
            },
            logs: true,
          }
        : computer.profile === "vm"
          ? {
              console: {
                mode: "pty",
                writable: true,
              },
              display: {
                mode: "vnc",
              },
              logs: true,
            }
          : computer.profile === "container"
            ? {
                console: {
                  mode: "pty",
                  writable: true,
                },
                logs: true,
              }
            : {
                display: {
                  mode: "virtual-display",
                },
                logs: true,
              }),
    capabilities: {
      canInspect: true,
      canStart: computer.state === "stopped",
      canStop: computer.state === "running",
      canRestart: computer.state === "running",
      consoleAvailable:
        computer.profile === "host" ||
        (computer.profile === "vm" &&
          (computer.access?.console as { mode?: string } | undefined)?.mode === "pty") ||
        (computer.profile === "container" &&
          (computer.access?.console as { mode?: string } | undefined)?.mode === "pty"),
      browserAvailable: computer.profile === "browser",
      automationAvailable: computer.profile === "browser" && computer.state === "running",
      screenshotAvailable:
        (computer.profile === "browser" || computer.profile === "vm") &&
        computer.state === "running",
      audioAvailable: computer.profile === "browser" && computer.state === "running",
    },
    network,
  };
}

function createComputerDetail(computer: FakeComputer) {
  const runtime =
    computer.profile === "browser"
      ? {
          browser: "chromium",
          persistentProfile: true,
          runtimeUser:
            (computer.runtime.runtimeUser as string | undefined) ?? `computerd-b-${computer.name}`,
          profileDirectory:
            (computer.runtime.profileDirectory as string | undefined) ??
            `/var/lib/computerd/computers/${computer.name}/profile`,
          runtimeDirectory:
            (computer.runtime.runtimeDirectory as string | undefined) ??
            `/run/computerd/computers/${computer.name}`,
          display: {
            protocol: "x11",
            mode: "virtual-display",
            viewport: {
              width: 1440,
              height: 900,
            },
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
        }
      : computer.profile === "container"
        ? {
            provider: (computer.runtime.provider as string | undefined) ?? "docker",
            image: (computer.runtime.image as string | undefined) ?? "ubuntu:24.04",
            command: computer.runtime.command,
            workingDirectory: computer.runtime.workingDirectory,
            environment: computer.runtime.environment,
            containerId:
              (computer.runtime.containerId as string | undefined) ??
              `development-${computer.name}`,
            containerName: (computer.runtime.containerName as string | undefined) ?? computer.name,
          }
        : computer.profile === "vm"
          ? {
              hypervisor: "qemu",
              accelerator: "kvm",
              architecture: "x86_64",
              machine: "q35",
              bridge: (computer.runtime.bridge as string | undefined) ?? "br0",
              nics: (
                (computer.runtime.nics as Array<Record<string, unknown>> | undefined) ?? [
                  {
                    name: "primary",
                    ipv4: {
                      type: "dhcp",
                    },
                    ipv6: {
                      type: "disabled",
                    },
                  },
                ]
              ).map((nic, index) => ({
                ...nic,
                macAddress:
                  (nic.macAddress as string | undefined) ??
                  `52:54:00:12:34:${(56 + index).toString(16).padStart(2, "0")}`,
                ipConfigApplied: (nic.ipConfigApplied as boolean | undefined) ?? true,
              })),
              source:
                (computer.runtime.source as Record<string, unknown> | undefined)?.kind === "iso"
                  ? {
                      path: "/images/ubuntu.iso",
                      ...(computer.runtime.source as Record<string, unknown>),
                    }
                  : {
                      kind: "qcow2",
                      imageId: "filesystem-vm:dev-qcow2",
                      path: "/images/ubuntu-cloud.qcow2",
                      cloudInit: {
                        user: "ubuntu",
                      },
                      ...(computer.runtime.source as Record<string, unknown> | undefined),
                    },
              diskImagePath:
                (computer.runtime.diskImagePath as string | undefined) ??
                `/var/lib/computerd/computers/${computer.name}/vm/disk.qcow2`,
              cloudInitImagePath:
                (computer.runtime.cloudInitImagePath as string | undefined) ??
                `/var/lib/computerd/computers/${computer.name}/vm/cloud-init.iso`,
              serialSocketPath:
                (computer.runtime.serialSocketPath as string | undefined) ??
                `/run/computerd/computers/${computer.name}/vm/serial.sock`,
              vncDisplay: (computer.runtime.vncDisplay as number | undefined) ?? 14,
              vncPort: (computer.runtime.vncPort as number | undefined) ?? 5914,
              displayViewport: (computer.runtime.displayViewport as
                | { width: number; height: number }
                | undefined) ?? {
                width: 1440,
                height: 900,
              },
            }
          : computer.runtime;

  return {
    ...createComputerSummary(computer),
    resources: {},
    storage: {
      rootMode: "persistent",
    },
    lifecycle: {},
    status: {
      lastActionAt: "2026-03-09T08:00:00.000Z",
      primaryUnit: computer.unitName,
    },
    runtime,
  };
}

function createNetworkSummary(input: {
  id: string;
  name: string;
  kind: "host" | "isolated";
  cidr: string;
  attachedComputerCount: number;
  deletable: boolean;
  status: {
    state: "healthy" | "degraded" | "broken";
    bridgeName: string;
  };
  gateway: {
    dhcp: {
      provider: "dnsmasq";
      state: "healthy" | "degraded" | "broken" | "unsupported";
    };
    dns: {
      provider: "dnsmasq" | "smartdns";
      state: "healthy" | "degraded" | "broken" | "unsupported";
    };
    programmableGateway: {
      provider: null | "tailscale" | "openvpn";
      state: "healthy" | "degraded" | "broken" | "unsupported";
    };
    health: {
      state: "healthy" | "degraded" | "broken";
      natState: "healthy" | "degraded" | "broken" | "unsupported";
    };
  };
}) {
  return input;
}

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}
