import { z } from "zod";

export const computerProfileSchema = z.enum(["host", "browser", "container"]);
export const computerStateSchema = z.enum(["stopped", "running", "broken"]);

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
  mode: z.enum(["none", "virtual-display"]),
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

export const computerNetworkSchema = z.object({
  mode: z.enum(["host", "isolated"]),
  proxy: z.string().optional(),
});

export const computerLifecycleSchema = z.object({
  autostart: z.boolean().optional(),
});

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
});

const computerDetailBaseSchema = computerSummaryBaseSchema.extend({
  resources: computerResourcesSchema,
  storage: computerStorageSchema,
  network: computerNetworkSchema,
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

export const computerSummarySchema = z.discriminatedUnion("profile", [
  hostComputerSummarySchema,
  browserComputerSummarySchema,
  containerComputerSummarySchema,
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

export const computerDetailSchema = z.discriminatedUnion("profile", [
  hostComputerDetailSchema,
  browserComputerDetailSchema,
  containerComputerDetailSchema,
]);

const createComputerBaseSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  access: computerAccessSchema.optional(),
  resources: computerResourcesSchema.optional(),
  storage: computerStorageSchema.optional(),
  network: computerNetworkSchema.optional(),
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

export const updateBrowserViewportInputSchema = browserViewportSchema;

export const createComputerInputSchema = z.discriminatedUnion("profile", [
  createHostComputerInputSchema,
  createBrowserComputerInputSchema,
  createContainerComputerInputSchema,
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

export type BrowserComputerDetail = z.infer<typeof browserComputerDetailSchema>;
export type BrowserRuntime = z.infer<typeof browserRuntimeSchema>;
export type BrowserViewport = z.infer<typeof browserViewportSchema>;
export type ComputerAutomationSession = z.infer<typeof computerAutomationSessionSchema>;
export type ComputerAudioSession = z.infer<typeof computerAudioSessionSchema>;
export type ComputerAccess = z.infer<typeof computerAccessSchema>;
export type ComputerCapabilities = z.infer<typeof computerCapabilitiesSchema>;
export type ComputerConsoleSession = z.infer<typeof computerConsoleSessionSchema>;
export type ComputerExecSession = z.infer<typeof computerExecSessionSchema>;
export type ComputerDetail = z.infer<typeof computerDetailSchema>;
export type ComputerLifecycle = z.infer<typeof computerLifecycleSchema>;
export type ComputerMonitorSession = z.infer<typeof computerMonitorSessionSchema>;
export type ComputerNetwork = z.infer<typeof computerNetworkSchema>;
export type ComputerProfile = z.infer<typeof computerProfileSchema>;
export type ComputerResources = z.infer<typeof computerResourcesSchema>;
export type ComputerSessionAuthorization = z.infer<typeof computerSessionAuthorizationSchema>;
export type ComputerSessionConnect = z.infer<typeof computerSessionConnectSchema>;
export type ComputerScreenshot = z.infer<typeof computerScreenshotSchema>;
export type ComputerState = z.infer<typeof computerStateSchema>;
export type ComputerStorage = z.infer<typeof computerStorageSchema>;
export type ComputerSummary = z.infer<typeof computerSummarySchema>;
export type CreateBrowserRuntime = z.infer<typeof createBrowserRuntimeSchema>;
export type CreateBrowserComputerInput = z.infer<typeof createBrowserComputerInputSchema>;
export type CreateComputerInput = z.infer<typeof createComputerInputSchema>;
export type CreateContainerComputerInput = z.infer<typeof createContainerComputerInputSchema>;
export type CreateContainerRuntime = z.infer<typeof createContainerRuntimeSchema>;
export type CreateHostComputerInput = z.infer<typeof createHostComputerInputSchema>;
export type HostUnitDetail = z.infer<typeof hostUnitDetailSchema>;
export type HostUnitSummary = z.infer<typeof hostUnitSummarySchema>;
export type ContainerComputerDetail = z.infer<typeof containerComputerDetailSchema>;
export type ContainerRuntime = z.infer<typeof containerRuntimeSchema>;
export type HostComputerDetail = z.infer<typeof hostComputerDetailSchema>;
export type HostRuntime = z.infer<typeof hostRuntimeSchema>;
export type UpdateBrowserViewportInput = z.infer<typeof updateBrowserViewportInputSchema>;

export function parseComputerSummaries(value: unknown) {
  return z.array(computerSummarySchema).parse(value);
}

export function parseComputerDetail(value: unknown) {
  return computerDetailSchema.parse(value);
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

export function parseCreateComputerInput(value: unknown) {
  return createComputerInputSchema.parse(value);
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
      (profile === "host" || profile === "container") && access?.console?.mode === "pty",
    browserAvailable: profile === "browser",
    automationAvailable: profile === "browser" && state === "running",
    screenshotAvailable: profile === "browser" && state === "running",
    audioAvailable: profile === "browser" && state === "running",
  } satisfies ComputerCapabilities;
}
