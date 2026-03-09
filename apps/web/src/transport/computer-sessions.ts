import {
  parseComputerConsoleSession,
  parseComputerMonitorSession,
  type ComputerConsoleSession,
  type ComputerMonitorSession,
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
