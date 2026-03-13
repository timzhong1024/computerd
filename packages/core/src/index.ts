import { z } from "zod";

export const computerProfileSchema = z.enum(["host", "browser", "container", "vm"]);
export const computerStateSchema = z.enum(["stopped", "running", "broken"]);
export const imageStatusSchema = z.enum(["available", "broken"]);

export const computerCapabilitiesSchema = z.object({
  canInspect: z.boolean(),
  canStart: z.boolean(),
  canStop: z.boolean(),
  canRestart: z.boolean(),
  consoleAvailable: z.boolean(),
  browserAvailable: z.boolean(),
  automationAvailable: z.boolean(),
  screenshotAvailable: z.boolean(),
  audioAvailable: z.boolean(),
});

export const computerConsoleAccessSchema = z.object({
  mode: z.literal("pty"),
  writable: z.boolean(),
});

export const computerDisplayAccessSchema = z.object({
  mode: z.enum(["none", "virtual-display", "vnc"]),
});

export const computerSessionConnectSchema = z.object({
  mode: z.enum(["websocket-url", "relative-websocket-path"]),
  url: z.string().min(1),
});

export const browserViewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const computerSessionAuthorizationSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("none"),
  }),
  z.object({
    mode: z.literal("ticket"),
    ticket: z.string().min(1),
  }),
]);

export const computerMonitorSessionSchema = z.object({
  computerName: z.string().min(1),
  protocol: z.literal("vnc"),
  connect: computerSessionConnectSchema,
  authorization: computerSessionAuthorizationSchema,
  expiresAt: z.string().datetime().optional(),
  viewport: browserViewportSchema.optional(),
});

export const computerAutomationSessionSchema = z.object({
  computerName: z.string().min(1),
  protocol: z.literal("cdp"),
  connect: computerSessionConnectSchema,
  authorization: computerSessionAuthorizationSchema,
  expiresAt: z.string().datetime().optional(),
});

export const computerAudioSessionSchema = z.object({
  computerName: z.string().min(1),
  protocol: z.literal("http-audio-stream"),
  connect: computerSessionConnectSchema,
  authorization: computerSessionAuthorizationSchema,
  mimeType: z.literal("audio/ogg"),
  expiresAt: z.string().datetime().optional(),
});

export const computerScreenshotSchema = z.object({
  computerName: z.string().min(1),
  format: z.literal("png"),
  mimeType: z.literal("image/png"),
  capturedAt: z.string().datetime(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  dataBase64: z.string().min(1),
});

export const computerSnapshotSchema = z.object({
  name: z.string().min(1),
  createdAt: z.string().datetime(),
  sizeBytes: z.number().int().nonnegative(),
});

export const computerConsoleSessionSchema = z.object({
  computerName: z.string().min(1),
  protocol: z.literal("ttyd"),
  connect: computerSessionConnectSchema,
  authorization: computerSessionAuthorizationSchema,
  expiresAt: z.string().datetime().optional(),
});

export const computerExecSessionSchema = z.object({
  computerName: z.string().min(1),
  protocol: z.literal("ttyd"),
  connect: computerSessionConnectSchema,
  authorization: computerSessionAuthorizationSchema,
  expiresAt: z.string().datetime().optional(),
});

export const computerAccessSchema = z.object({
  console: computerConsoleAccessSchema.optional(),
  display: computerDisplayAccessSchema.optional(),
  logs: z.boolean().optional(),
});

export const computerResourcesSchema = z.object({
  cpuWeight: z.number().int().min(1).max(10_000).optional(),
  memoryMaxMiB: z.number().int().positive().optional(),
  tasksMax: z.number().int().positive().optional(),
});

export const computerStorageSchema = z.object({
  rootMode: z.enum(["persistent", "ephemeral"]),
  writablePaths: z.array(z.string()).optional(),
  storageGiB: z.number().int().positive().optional(),
});

export const networkKindSchema = z.enum(["host", "isolated"]);
export const networkComponentStateSchema = z.enum(["healthy", "degraded", "broken", "unsupported"]);

export const networkDnsProviderSchema = z.enum(["dnsmasq", "smartdns"]);
export const networkProgrammableGatewayProviderSchema = z.enum(["tailscale", "openvpn"]);

export const networkDhcpConfigSchema = z.object({
  provider: z.literal("dnsmasq"),
});

export const networkDnsConfigSchema = z.object({
  provider: networkDnsProviderSchema.optional(),
});

export const networkProgrammableGatewayConfigSchema = z.object({
  provider: networkProgrammableGatewayProviderSchema.nullish(),
});

export const createNetworkGatewaySchema = z.object({
  dns: networkDnsConfigSchema.optional(),
  programmableGateway: networkProgrammableGatewayConfigSchema.optional(),
});

export const networkGatewayComponentSchema = z.object({
  provider: z.string().min(1).nullable(),
  state: networkComponentStateSchema,
});

export const networkGatewayHealthSchema = z.object({
  state: z.enum(["healthy", "degraded", "broken"]),
  natState: networkComponentStateSchema,
});

export const networkGatewaySchema = z.object({
  dhcp: networkGatewayComponentSchema,
  dns: networkGatewayComponentSchema,
  programmableGateway: networkGatewayComponentSchema,
  health: networkGatewayHealthSchema,
});

export const networkStatusSchema = z.object({
  state: z.enum(["healthy", "degraded", "broken"]),
  bridgeName: z.string().min(1),
});

export const networkSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: networkKindSchema,
  cidr: z.string().min(1),
  status: networkStatusSchema,
  gateway: networkGatewaySchema,
  attachedComputerCount: z.number().int().nonnegative(),
  deletable: z.boolean(),
});

export const networkDetailSchema = networkSummarySchema;

function isValidIpv4Cidr(value: string) {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(value.trim());
  if (!match) {
    return false;
  }

  const prefixLength = Number.parseInt(match[2] ?? "", 10);
  if (prefixLength < 16 || prefixLength > 29) {
    return false;
  }

  return isValidIpv4Address(match[1] ?? "");
}

export const createNetworkInputSchema = z.object({
  name: z.string().min(1),
  cidr: z.string().refine(isValidIpv4Cidr, {
    message: "Expected an IPv4 CIDR with prefix length between /16 and /29.",
  }),
  gateway: createNetworkGatewaySchema.optional(),
});

export const computerLifecycleSchema = z.object({
  autostart: z.boolean().optional(),
});

export const imageProviderSchema = z.enum(["filesystem-vm", "docker"]);

export const hostRuntimeSchema = z.object({
  command: z.string().min(1).optional(),
  workingDirectory: z.string().optional(),
  environment: z.record(z.string(), z.string()).optional(),
});

export const createContainerRuntimeSchema = z.object({
  provider: z.literal("docker"),
  image: z.string().min(1),
  command: z.string().min(1).optional(),
  workingDirectory: z.string().optional(),
  environment: z.record(z.string(), z.string()).optional(),
});

export const containerRuntimeSchema = createContainerRuntimeSchema.extend({
  containerId: z.string().min(1),
  containerName: z.string().min(1),
});

export const createBrowserRuntimeSchema = z.object({
  browser: z.literal("chromium"),
  persistentProfile: z.boolean(),
  viewport: browserViewportSchema.optional(),
});

function isValidIpv4Address(value: string) {
  const octets = value.split(".");
  if (octets.length !== 4) {
    return false;
  }

  return octets.every((octet) => {
    if (!/^\d+$/.test(octet)) {
      return false;
    }

    const parsed = Number.parseInt(octet, 10);
    return parsed >= 0 && parsed <= 255;
  });
}

function isValidIpv6Address(value: string) {
  return /^[0-9a-f:]+$/i.test(value) && value.includes(":");
}

function isValidMacAddress(value: string) {
  return /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i.test(value);
}

const vmNicIpv4DisabledSchema = z.object({
  type: z.literal("disabled"),
});

const vmNicIpv4DhcpSchema = z.object({
  type: z.literal("dhcp"),
});

const vmNicIpv4StaticSchema = z.object({
  type: z.literal("static"),
  address: z.string().refine(isValidIpv4Address, {
    message: "Expected a valid IPv4 address.",
  }),
  prefixLength: z.number().int().min(1).max(32),
});

export const vmNicIpv4Schema = z.discriminatedUnion("type", [
  vmNicIpv4DisabledSchema,
  vmNicIpv4DhcpSchema,
  vmNicIpv4StaticSchema,
]);

const vmNicIpv6DisabledSchema = z.object({
  type: z.literal("disabled"),
});

const vmNicIpv6DhcpSchema = z.object({
  type: z.literal("dhcp"),
});

const vmNicIpv6SlaacSchema = z.object({
  type: z.literal("slaac"),
});

const vmNicIpv6StaticSchema = z.object({
  type: z.literal("static"),
  address: z.string().refine(isValidIpv6Address, {
    message: "Expected a valid IPv6 address.",
  }),
  prefixLength: z.number().int().min(1).max(128),
});

export const vmNicIpv6Schema = z.discriminatedUnion("type", [
  vmNicIpv6DisabledSchema,
  vmNicIpv6DhcpSchema,
  vmNicIpv6SlaacSchema,
  vmNicIpv6StaticSchema,
]);

export const createVmNicSchema = z.object({
  name: z.string().min(1),
  macAddress: z
    .string()
    .refine(isValidMacAddress, { message: "Expected a valid MAC address." })
    .optional(),
  ipv4: vmNicIpv4Schema.optional(),
  ipv6: vmNicIpv6Schema.optional(),
});

export const vmNicSchema = createVmNicSchema.extend({
  macAddress: z.string().refine(isValidMacAddress, {
    message: "Expected a valid MAC address.",
  }),
  ipConfigApplied: z.boolean(),
});

export const vmCloudInitEnabledSchema = z.object({
  enabled: z.literal(true).optional(),
  user: z.string().min(1),
  password: z.string().min(1).optional(),
  sshAuthorizedKeys: z.array(z.string().min(1)).optional(),
});

export const vmCloudInitDisabledSchema = z.object({
  enabled: z.literal(false),
});

export const vmCloudInitSchema = z.union([vmCloudInitEnabledSchema, vmCloudInitDisabledSchema]);

export const createVmRuntimeSourceQcow2Schema = z.object({
  kind: z.literal("qcow2"),
  imageId: z.string().min(1),
  cloudInit: vmCloudInitSchema,
});

export const createVmRuntimeSourceIsoSchema = z.object({
  kind: z.literal("iso"),
  imageId: z.string().min(1),
  diskSizeGiB: z.number().int().positive().optional(),
});

export const createVmRuntimeSourceSchema = z.discriminatedUnion("kind", [
  createVmRuntimeSourceQcow2Schema,
  createVmRuntimeSourceIsoSchema,
]);

export const vmRuntimeSourceQcow2Schema = createVmRuntimeSourceQcow2Schema.extend({
  path: z.string().min(1),
});

export const vmRuntimeSourceIsoSchema = createVmRuntimeSourceIsoSchema.extend({
  path: z.string().min(1),
});

export const vmRuntimeSourceSchema = z.discriminatedUnion("kind", [
  vmRuntimeSourceQcow2Schema,
  vmRuntimeSourceIsoSchema,
]);

export const createVmRuntimeSchema = z.object({
  hypervisor: z.literal("qemu"),
  source: createVmRuntimeSourceSchema,
  nics: z.array(createVmNicSchema).min(1),
});

export const vmRuntimeSchema = createVmRuntimeSchema.extend({
  accelerator: z.literal("kvm"),
  architecture: z.literal("x86_64"),
  machine: z.literal("q35"),
  source: vmRuntimeSourceSchema,
  bridge: z.string().min(1),
  diskImagePath: z.string().min(1),
  cloudInitImagePath: z.string().min(1).optional(),
  serialSocketPath: z.string().min(1),
  nics: z.array(vmNicSchema).min(1),
  vncDisplay: z.number().int().min(0),
  vncPort: z.number().int().positive(),
  displayViewport: browserViewportSchema,
});

const imageSummaryBaseSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["qcow2", "iso", "container"]),
  provider: imageProviderSchema,
  name: z.string().min(1),
  status: imageStatusSchema,
  createdAt: z.string().datetime().optional(),
  lastSeenAt: z.string().datetime().optional(),
});

export const vmImageSummarySchema = imageSummaryBaseSchema.extend({
  kind: z.enum(["qcow2", "iso"]),
  provider: z.literal("filesystem-vm"),
  sourceType: z.enum(["directory", "managed-import"]),
});

export const containerImageSummarySchema = imageSummaryBaseSchema.extend({
  kind: z.literal("container"),
  provider: z.literal("docker"),
});

export const imageSummarySchema = z.discriminatedUnion("provider", [
  vmImageSummarySchema,
  containerImageSummarySchema,
]);

export const vmImageDetailSchema = vmImageSummarySchema.extend({
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  format: z.enum(["qcow2", "iso"]).optional(),
});

export const containerImageDetailSchema = containerImageSummarySchema.extend({
  reference: z.string().min(1),
  imageId: z.string().min(1),
  repoTags: z.array(z.string().min(1)),
  sizeBytes: z.number().int().nonnegative(),
});

export const imageDetailSchema = z.discriminatedUnion("provider", [
  vmImageDetailSchema,
  containerImageDetailSchema,
]);

export const browserRuntimeSchema = createBrowserRuntimeSchema.extend({
  runtimeUser: z.string().min(1),
  profileDirectory: z.string().min(1),
  runtimeDirectory: z.string().min(1),
  display: z.object({
    protocol: z.literal("x11"),
    mode: z.literal("virtual-display"),
    viewport: browserViewportSchema,
  }),
  automation: z.object({
    protocol: z.literal("cdp"),
    available: z.boolean(),
  }),
  audio: z.object({
    protocol: z.literal("pipewire"),
    isolation: z.literal("host-pipewire-user"),
    available: z.boolean(),
  }),
  screenshot: z.object({
    format: z.literal("png"),
    available: z.boolean(),
  }),
});

const computerSummaryBaseSchema = z.object({
  name: z.string().min(1),
  unitName: z.string().min(1),
  profile: computerProfileSchema,
  state: computerStateSchema,
  description: z.string().optional(),
  createdAt: z.string().datetime(),
  access: computerAccessSchema,
  capabilities: computerCapabilitiesSchema,
  network: networkSummarySchema,
});

const computerDetailBaseSchema = computerSummaryBaseSchema.extend({
  resources: computerResourcesSchema,
  storage: computerStorageSchema,
  lifecycle: computerLifecycleSchema,
  status: z.object({
    lastActionAt: z.string().datetime(),
    primaryUnit: z.string().min(1),
  }),
});

export const hostComputerSummarySchema = computerSummaryBaseSchema.extend({
  profile: z.literal("host"),
});

export const browserComputerSummarySchema = computerSummaryBaseSchema.extend({
  profile: z.literal("browser"),
});

export const containerComputerSummarySchema = computerSummaryBaseSchema.extend({
  profile: z.literal("container"),
});

export const vmComputerSummarySchema = computerSummaryBaseSchema.extend({
  profile: z.literal("vm"),
});

export const computerSummarySchema = z.discriminatedUnion("profile", [
  hostComputerSummarySchema,
  browserComputerSummarySchema,
  containerComputerSummarySchema,
  vmComputerSummarySchema,
]);

export const hostComputerDetailSchema = computerDetailBaseSchema.extend({
  profile: z.literal("host"),
  runtime: hostRuntimeSchema,
});

export const browserComputerDetailSchema = computerDetailBaseSchema.extend({
  profile: z.literal("browser"),
  runtime: browserRuntimeSchema,
});

export const containerComputerDetailSchema = computerDetailBaseSchema.extend({
  profile: z.literal("container"),
  runtime: containerRuntimeSchema,
});

export const vmComputerDetailSchema = computerDetailBaseSchema.extend({
  profile: z.literal("vm"),
  runtime: vmRuntimeSchema,
});

export const computerDetailSchema = z.discriminatedUnion("profile", [
  hostComputerDetailSchema,
  browserComputerDetailSchema,
  containerComputerDetailSchema,
  vmComputerDetailSchema,
]);

const createComputerBaseSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  access: computerAccessSchema.optional(),
  resources: computerResourcesSchema.optional(),
  storage: computerStorageSchema.optional(),
  networkId: z.string().min(1).optional(),
  lifecycle: computerLifecycleSchema.optional(),
});

export const createHostComputerInputSchema = createComputerBaseSchema.extend({
  profile: z.literal("host"),
  runtime: hostRuntimeSchema,
});

export const createBrowserComputerInputSchema = createComputerBaseSchema.extend({
  profile: z.literal("browser"),
  runtime: createBrowserRuntimeSchema,
});

export const createContainerComputerInputSchema = createComputerBaseSchema.extend({
  profile: z.literal("container"),
  runtime: createContainerRuntimeSchema,
});

export const createVmComputerInputSchema = createComputerBaseSchema.extend({
  profile: z.literal("vm"),
  runtime: createVmRuntimeSchema,
});

export const updateBrowserViewportInputSchema = browserViewportSchema;

export const createComputerSnapshotInputSchema = z.object({
  name: z.string().min(1),
});

export const restoreComputerInputSchema = z.discriminatedUnion("target", [
  z.object({
    target: z.literal("initial"),
  }),
  z.object({
    target: z.literal("snapshot"),
    snapshotName: z.string().min(1),
  }),
]);

export const createComputerInputSchema = z.discriminatedUnion("profile", [
  createHostComputerInputSchema,
  createBrowserComputerInputSchema,
  createContainerComputerInputSchema,
  createVmComputerInputSchema,
]);

export const hostUnitCapabilitiesSchema = z.object({
  canInspect: z.boolean(),
});

export const hostUnitSummarySchema = z.object({
  unitName: z.string().min(1),
  unitType: z.string().min(1),
  state: z.string().min(1),
  description: z.string().optional(),
  capabilities: hostUnitCapabilitiesSchema,
});

export const hostUnitDetailSchema = hostUnitSummarySchema.extend({
  execStart: z.string().min(1),
  status: z.object({
    activeState: z.string().min(1),
    subState: z.string().min(1),
    loadState: z.string().min(1),
  }),
  recentLogs: z.array(z.string()),
});

export const pullContainerImageInputSchema = z.object({
  reference: z.string().min(1),
});

export const importVmImageInputSchema = z.object({
  source: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("file"),
      path: z.string().min(1),
    }),
    z.object({
      type: z.literal("url"),
      url: z.url().refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
        message: "Expected an http or https URL.",
      }),
    }),
  ]),
});

export type BrowserComputerDetail = z.infer<typeof browserComputerDetailSchema>;
export type BrowserRuntime = z.infer<typeof browserRuntimeSchema>;
export type BrowserViewport = z.infer<typeof browserViewportSchema>;
export type ContainerImageDetail = z.infer<typeof containerImageDetailSchema>;
export type ContainerImageSummary = z.infer<typeof containerImageSummarySchema>;
export type ComputerAutomationSession = z.infer<typeof computerAutomationSessionSchema>;
export type ComputerAudioSession = z.infer<typeof computerAudioSessionSchema>;
export type ComputerAccess = z.infer<typeof computerAccessSchema>;
export type ComputerCapabilities = z.infer<typeof computerCapabilitiesSchema>;
export type ComputerConsoleSession = z.infer<typeof computerConsoleSessionSchema>;
export type ComputerExecSession = z.infer<typeof computerExecSessionSchema>;
export type ComputerDetail = z.infer<typeof computerDetailSchema>;
export type ComputerLifecycle = z.infer<typeof computerLifecycleSchema>;
export type ComputerMonitorSession = z.infer<typeof computerMonitorSessionSchema>;
export type ComputerProfile = z.infer<typeof computerProfileSchema>;
export type ComputerResources = z.infer<typeof computerResourcesSchema>;
export type ComputerSessionAuthorization = z.infer<typeof computerSessionAuthorizationSchema>;
export type ComputerSessionConnect = z.infer<typeof computerSessionConnectSchema>;
export type ComputerScreenshot = z.infer<typeof computerScreenshotSchema>;
export type ComputerSnapshot = z.infer<typeof computerSnapshotSchema>;
export type ComputerState = z.infer<typeof computerStateSchema>;
export type ComputerStorage = z.infer<typeof computerStorageSchema>;
export type ComputerSummary = z.infer<typeof computerSummarySchema>;
export type ContainerImagePullInput = z.infer<typeof pullContainerImageInputSchema>;
export type ImportVmImageInput = z.infer<typeof importVmImageInputSchema>;
export type CreateBrowserRuntime = z.infer<typeof createBrowserRuntimeSchema>;
export type CreateBrowserComputerInput = z.infer<typeof createBrowserComputerInputSchema>;
export type CreateComputerInput = z.infer<typeof createComputerInputSchema>;
export type CreateComputerSnapshotInput = z.infer<typeof createComputerSnapshotInputSchema>;
export type CreateContainerComputerInput = z.infer<typeof createContainerComputerInputSchema>;
export type CreateContainerRuntime = z.infer<typeof createContainerRuntimeSchema>;
export type CreateHostComputerInput = z.infer<typeof createHostComputerInputSchema>;
export type RestoreComputerInput = z.infer<typeof restoreComputerInputSchema>;
export type CreateVmComputerInput = z.infer<typeof createVmComputerInputSchema>;
export type CreateVmRuntime = z.infer<typeof createVmRuntimeSchema>;
export type CreateVmRuntimeSource = z.infer<typeof createVmRuntimeSourceSchema>;
export type HostUnitDetail = z.infer<typeof hostUnitDetailSchema>;
export type HostUnitSummary = z.infer<typeof hostUnitSummarySchema>;
export type ContainerComputerDetail = z.infer<typeof containerComputerDetailSchema>;
export type ContainerRuntime = z.infer<typeof containerRuntimeSchema>;
export type HostComputerDetail = z.infer<typeof hostComputerDetailSchema>;
export type HostRuntime = z.infer<typeof hostRuntimeSchema>;
export type ImageDetail = z.infer<typeof imageDetailSchema>;
export type ImageProvider = z.infer<typeof imageProviderSchema>;
export type ImageStatus = z.infer<typeof imageStatusSchema>;
export type ImageSummary = z.infer<typeof imageSummarySchema>;
export type NetworkDetail = z.infer<typeof networkDetailSchema>;
export type NetworkKind = z.infer<typeof networkKindSchema>;
export type NetworkStatus = z.infer<typeof networkStatusSchema>;
export type NetworkSummary = z.infer<typeof networkSummarySchema>;
export type CreateNetworkInput = z.infer<typeof createNetworkInputSchema>;
export type VmComputerDetail = z.infer<typeof vmComputerDetailSchema>;
export type VmCloudInit = z.infer<typeof vmCloudInitSchema>;
export type VmRuntimeSource = z.infer<typeof vmRuntimeSourceSchema>;
export type VmImageDetail = z.infer<typeof vmImageDetailSchema>;
export type VmImageSummary = z.infer<typeof vmImageSummarySchema>;
export type VmRuntime = z.infer<typeof vmRuntimeSchema>;
export type UpdateBrowserViewportInput = z.infer<typeof updateBrowserViewportInputSchema>;

export function parseComputerSummaries(value: unknown) {
  return z.array(computerSummarySchema).parse(value);
}

export function parseComputerDetail(value: unknown) {
  return computerDetailSchema.parse(value);
}

export function parseImageSummaries(value: unknown) {
  return z.array(imageSummarySchema).parse(value);
}

export function parseImageDetail(value: unknown) {
  return imageDetailSchema.parse(value);
}

export function parseNetworkSummaries(value: unknown) {
  return z.array(networkSummarySchema).parse(value);
}

export function parseNetworkDetail(value: unknown) {
  return networkDetailSchema.parse(value);
}

export function parseComputerMonitorSession(value: unknown) {
  return computerMonitorSessionSchema.parse(value);
}

export function parseComputerAutomationSession(value: unknown) {
  return computerAutomationSessionSchema.parse(value);
}

export function parseComputerAudioSession(value: unknown) {
  return computerAudioSessionSchema.parse(value);
}

export function parseComputerConsoleSession(value: unknown) {
  return computerConsoleSessionSchema.parse(value);
}

export function parseComputerExecSession(value: unknown) {
  return computerExecSessionSchema.parse(value);
}

export function parseComputerScreenshot(value: unknown) {
  return computerScreenshotSchema.parse(value);
}

export function parseComputerSnapshot(value: unknown) {
  return computerSnapshotSchema.parse(value);
}

export function parseComputerSnapshots(value: unknown) {
  return z.array(computerSnapshotSchema).parse(value);
}

export function parseCreateComputerInput(value: unknown) {
  return createComputerInputSchema.parse(value);
}

export function parseCreateComputerSnapshotInput(value: unknown) {
  return createComputerSnapshotInputSchema.parse(value);
}

export function parseRestoreComputerInput(value: unknown) {
  return restoreComputerInputSchema.parse(value);
}

export function parseUpdateBrowserViewportInput(value: unknown) {
  return updateBrowserViewportInputSchema.parse(value);
}

export function parseHostUnitSummaries(value: unknown) {
  return z.array(hostUnitSummarySchema).parse(value);
}

export function parseHostUnitDetail(value: unknown) {
  return hostUnitDetailSchema.parse(value);
}

export function parsePullContainerImageInput(value: unknown) {
  return pullContainerImageInputSchema.parse(value);
}

export function parseImportVmImageInput(value: unknown) {
  return importVmImageInputSchema.parse(value);
}

export function parseCreateNetworkInput(value: unknown) {
  return createNetworkInputSchema.parse(value);
}

export function createComputerCapabilities(
  profile: ComputerProfile,
  state: ComputerState,
  access?: ComputerAccess,
) {
  const isBroken = state === "broken";
  return {
    canInspect: true,
    canStart: !isBroken && state === "stopped",
    canStop: !isBroken && state === "running",
    canRestart: !isBroken && state === "running",
    consoleAvailable:
      (profile === "host" || profile === "container" || profile === "vm") &&
      access?.console?.mode === "pty",
    browserAvailable: profile === "browser",
    automationAvailable: profile === "browser" && state === "running",
    screenshotAvailable: profile === "browser" && state === "running",
    audioAvailable: profile === "browser" && state === "running",
  } satisfies ComputerCapabilities;
}
