import {
  parseComputerAutomationSession,
  parseComputerAudioSession,
  parseComputerDetail,
  parseComputerConsoleSession,
  parseComputerMonitorSession,
  parseComputerScreenshot,
  type ComputerAutomationSession,
  type ComputerAudioSession,
  type ComputerDetail,
  type ComputerConsoleSession,
  type ComputerMonitorSession,
  type ComputerScreenshot,
} from "@computerd/core";
import { postJson } from "./http";

export async function createMonitorSession(name: string): Promise<ComputerMonitorSession> {
  return await postJson(
    `/api/computers/${encodeURIComponent(name)}/monitor-sessions`,
    undefined,
    parseComputerMonitorSession,
  );
}

export async function createConsoleSession(name: string): Promise<ComputerConsoleSession> {
  return await postJson(
    `/api/computers/${encodeURIComponent(name)}/console-sessions`,
    undefined,
    parseComputerConsoleSession,
  );
}

export async function createAutomationSession(name: string): Promise<ComputerAutomationSession> {
  return await postJson(
    `/api/computers/${encodeURIComponent(name)}/automation-sessions`,
    undefined,
    parseComputerAutomationSession,
  );
}

export async function createAudioSession(name: string): Promise<ComputerAudioSession> {
  return await postJson(
    `/api/computers/${encodeURIComponent(name)}/audio-sessions`,
    undefined,
    parseComputerAudioSession,
  );
}

export async function createScreenshot(name: string): Promise<ComputerScreenshot> {
  return await postJson(
    `/api/computers/${encodeURIComponent(name)}/screenshots`,
    undefined,
    parseComputerScreenshot,
  );
}

export async function updateBrowserViewport(
  name: string,
  viewport: { width: number; height: number },
): Promise<ComputerDetail> {
  return await postJson(
    `/api/computers/${encodeURIComponent(name)}/viewport`,
    viewport,
    parseComputerDetail,
  );
}
