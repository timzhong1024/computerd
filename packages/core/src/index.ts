import { z } from "zod";

export const computerProfileSchema = z.enum(["terminal", "browser"]);
export const computerStateSchema = z.enum(["stopped", "running"]);

export const computerCapabilitiesSchema = z.object({
  canInspect: z.boolean(),
  canStart: z.boolean(),
  canStop: z.boolean(),
  canRestart: z.boolean(),
  consoleAvailable: z.boolean(),
  browserAvailable: z.boolean(),
  automationAvailable: z.boolean(),
  screenshotAvailable: z.boolean(),
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
  viewport: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional(),
});

export const computerAutomationSessionSchema = z.object({
  computerName: z.string().min(1),
  protocol: z.literal("cdp"),
  connect: computerSessionConnectSchema,
  authorization: computerSessionAuthorizationSchema,
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

export const terminalRuntimeSchema = z.object({
  execStart: z.string().min(1),
  workingDirectory: z.string().optional(),
  environment: z.record(z.string(), z.string()).optional(),
});

export const createBrowserRuntimeSchema = z.object({
  browser: z.literal("chromium"),
  persistentProfile: z.boolean(),
});

export const browserRuntimeSchema = createBrowserRuntimeSchema.extend({
  profileDirectory: z.string().min(1),
  runtimeDirectory: z.string().min(1),
  display: z.object({
    protocol: z.literal("x11"),
    mode: z.literal("virtual-display"),
    viewport: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
  }),
  automation: z.object({
    protocol: z.literal("cdp"),
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

export const terminalComputerSummarySchema = computerSummaryBaseSchema.extend({
  profile: z.literal("terminal"),
});

export const browserComputerSummarySchema = computerSummaryBaseSchema.extend({
  profile: z.literal("browser"),
});

export const computerSummarySchema = z.discriminatedUnion("profile", [
  terminalComputerSummarySchema,
  browserComputerSummarySchema,
]);

export const terminalComputerDetailSchema = computerDetailBaseSchema.extend({
  profile: z.literal("terminal"),
  runtime: terminalRuntimeSchema,
});

export const browserComputerDetailSchema = computerDetailBaseSchema.extend({
  profile: z.literal("browser"),
  runtime: browserRuntimeSchema,
});

export const computerDetailSchema = z.discriminatedUnion("profile", [
  terminalComputerDetailSchema,
  browserComputerDetailSchema,
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

export const createTerminalComputerInputSchema = createComputerBaseSchema.extend({
  profile: z.literal("terminal"),
  runtime: terminalRuntimeSchema,
});

export const createBrowserComputerInputSchema = createComputerBaseSchema.extend({
  profile: z.literal("browser"),
  runtime: createBrowserRuntimeSchema,
});

export const createComputerInputSchema = z.discriminatedUnion("profile", [
  createTerminalComputerInputSchema,
  createBrowserComputerInputSchema,
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
export type ComputerAutomationSession = z.infer<typeof computerAutomationSessionSchema>;
export type ComputerAccess = z.infer<typeof computerAccessSchema>;
export type ComputerCapabilities = z.infer<typeof computerCapabilitiesSchema>;
export type ComputerConsoleSession = z.infer<typeof computerConsoleSessionSchema>;
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
export type CreateTerminalComputerInput = z.infer<typeof createTerminalComputerInputSchema>;
export type HostUnitDetail = z.infer<typeof hostUnitDetailSchema>;
export type HostUnitSummary = z.infer<typeof hostUnitSummarySchema>;
export type TerminalComputerDetail = z.infer<typeof terminalComputerDetailSchema>;
export type TerminalRuntime = z.infer<typeof terminalRuntimeSchema>;

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

export function parseComputerConsoleSession(value: unknown) {
  return computerConsoleSessionSchema.parse(value);
}

export function parseComputerScreenshot(value: unknown) {
  return computerScreenshotSchema.parse(value);
}

export function parseCreateComputerInput(value: unknown) {
  return createComputerInputSchema.parse(value);
}

export function parseHostUnitSummaries(value: unknown) {
  return z.array(hostUnitSummarySchema).parse(value);
}

export function parseHostUnitDetail(value: unknown) {
  return hostUnitDetailSchema.parse(value);
}

export function createComputerCapabilities(profile: ComputerProfile, state: ComputerState) {
  return {
    canInspect: true,
    canStart: state === "stopped",
    canStop: state === "running",
    canRestart: state === "running",
    consoleAvailable: profile === "terminal",
    browserAvailable: profile === "browser",
    automationAvailable: profile === "browser" && state === "running",
    screenshotAvailable: profile === "browser" && state === "running",
  } satisfies ComputerCapabilities;
}
