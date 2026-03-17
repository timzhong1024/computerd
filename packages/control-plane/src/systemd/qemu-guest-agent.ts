import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  VmGuestCommandInput,
  VmGuestCommandResult,
  VmGuestFileReadInput,
  VmGuestFileReadResult,
  VmGuestFileWriteInput,
  VmGuestFileWriteResult,
} from "@computerd/core";

const DEFAULT_TIMEOUT_MS = 30_000;
const READ_CHUNK_SIZE = 64 * 1024;
const WRITE_CHUNK_SIZE = 48 * 1024;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export class QemuGuestAgentUnavailableError extends Error {}
export class QemuGuestAgentProtocolError extends Error {}
export class QemuGuestAgentCommandError extends Error {}

export interface ReadGuestFileOptions extends VmGuestFileReadInput {}
export interface WriteGuestFileOptions extends VmGuestFileWriteInput {}

export class QemuGuestAgentClient {
  constructor(private readonly socketPath: string) {}

  async waitForReady(timeoutMs = 10_000) {
    const startedAt = Date.now();
    let lastError: unknown;

    while (Date.now() - startedAt < timeoutMs) {
      try {
        await this.sendCommand("guest-sync-delimited", { id: randomUUID() }, 2_000);
        return;
      } catch (error) {
        lastError = error;
        await delay(250);
      }
    }

    throw new QemuGuestAgentUnavailableError(
      lastError instanceof Error
        ? lastError.message
        : `QEMU guest agent at ${this.socketPath} is not ready.`,
    );
  }

  async runCommand(input: VmGuestCommandInput): Promise<VmGuestCommandResult> {
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const payload = input.shell
      ? {
          path: "/bin/sh",
          arg: ["-lc", buildShellCommand(input.command, input.workingDirectory)],
          env: toGuestEnv(input.environment),
          "capture-output": input.captureOutput ?? true,
        }
      : {
          path: input.command,
          env: toGuestEnv(input.environment),
          "capture-output": input.captureOutput ?? true,
        };
    const response = await this.sendCommand("guest-exec", payload, timeoutMs);
    const pid = readGuestExecPid(response);
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const status = await this.sendCommand("guest-exec-status", { pid }, timeoutMs);
      const result = readReturnRecord(status, "guest-exec-status");
      const exited = readBoolean(result, "exited");
      if (!exited) {
        await delay(200);
        continue;
      }

      return {
        exitCode: readOptionalInteger(result, "exitcode"),
        stdout: readOptionalBase64String(result, "out-data"),
        stderr: readOptionalBase64String(result, "err-data"),
        timedOut: false,
        completedAt: new Date().toISOString(),
      };
    }

    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: true,
      completedAt: new Date().toISOString(),
    };
  }

  async readFile(input: ReadGuestFileOptions): Promise<VmGuestFileReadResult> {
    const handle = readReturnInteger(
      await this.sendCommand("guest-file-open", { path: input.path, mode: "rb" }),
      "guest-file-open",
    );
    const chunks: Buffer[] = [];
    let sizeBytes = 0;
    let truncated = false;

    try {
      while (true) {
        const remaining = (input.maxBytes ?? Number.MAX_SAFE_INTEGER) - sizeBytes;
        if (remaining <= 0) {
          truncated = true;
          break;
        }

        const response = await this.sendCommand("guest-file-read", {
          handle,
          count: Math.min(READ_CHUNK_SIZE, remaining),
        });
        const result = readReturnRecord(response, "guest-file-read");
        const count = readInteger(result, "count");
        const eof = readBoolean(result, "eof");
        const data = readOptionalBase64Buffer(result, "buf-b64");
        if (data.length > 0) {
          chunks.push(data);
          sizeBytes += data.length;
        }
        if (eof || count === 0) {
          break;
        }
      }
    } finally {
      await this.closeFile(handle);
    }

    return {
      path: input.path,
      dataBase64: Buffer.concat(chunks).toString("base64"),
      sizeBytes,
      truncated,
    };
  }

  async writeFile(input: WriteGuestFileOptions): Promise<VmGuestFileWriteResult> {
    if (input.createParents) {
      await this.runCommand({
        command: `mkdir -p ${quoteShell(dirname(input.path))}`,
        shell: true,
        captureOutput: true,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
    }

    const handle = readReturnInteger(
      await this.sendCommand("guest-file-open", { path: input.path, mode: "wb" }),
      "guest-file-open",
    );
    const buffer = Buffer.from(input.dataBase64, "base64");

    try {
      for (let offset = 0; offset < buffer.length; offset += WRITE_CHUNK_SIZE) {
        const chunk = buffer.subarray(offset, offset + WRITE_CHUNK_SIZE);
        await this.sendCommand("guest-file-write", {
          handle,
          "buf-b64": chunk.toString("base64"),
          count: chunk.length,
        });
      }
    } finally {
      await this.closeFile(handle);
    }

    if (input.mode !== undefined) {
      await this.runCommand({
        command: `chmod ${input.mode.toString(8)} ${quoteShell(input.path)}`,
        shell: true,
        captureOutput: true,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
    }

    return {
      path: input.path,
      sizeBytes: buffer.length,
    };
  }

  private async closeFile(handle: number) {
    try {
      await this.sendCommand("guest-file-close", { handle });
    } catch {
      // Ignore close failures to preserve the original read/write error.
    }
  }

  private async sendCommand(
    command: string,
    argumentsPayload: Record<string, unknown> = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const socket = await connectToGuestAgent(this.socketPath, timeoutMs);
    const syncId = randomUUID();

    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      let buffer = "";
      let synced = false;
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new QemuGuestAgentUnavailableError(`Guest agent command "${command}" timed out.`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        socket.removeAllListeners();
        socket.destroy();
      };

      const handleMessage = (message: Record<string, unknown>) => {
        if ("error" in message) {
          cleanup();
          reject(new QemuGuestAgentCommandError(JSON.stringify(message.error)));
          return;
        }

        if (!synced) {
          if (message.return === syncId) {
            synced = true;
            socket.write(JSON.stringify({ execute: command, arguments: argumentsPayload }));
            socket.write("\n");
          }
          return;
        }

        cleanup();
        resolve(message);
      };

      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        while (true) {
          const newlineIndex = buffer.search(/\r?\n/);
          if (newlineIndex === -1) {
            break;
          }

          const rawLine = buffer.slice(0, newlineIndex).trim();
          const sliceEnd = buffer[newlineIndex] === "\r" && buffer[newlineIndex + 1] === "\n" ? 2 : 1;
          buffer = buffer.slice(newlineIndex + sliceEnd);
          if (rawLine.length === 0) {
            continue;
          }

          let payload: unknown;
          try {
            payload = JSON.parse(rawLine);
          } catch (error) {
            cleanup();
            reject(
              new QemuGuestAgentProtocolError(
                error instanceof Error ? error.message : "Failed to parse guest agent JSON.",
              ),
            );
            return;
          }

          if (!isRecord(payload)) {
            cleanup();
            reject(new QemuGuestAgentProtocolError("Guest agent returned a non-object payload."));
            return;
          }

          handleMessage(payload);
        }
      });

      socket.once("error", (error) => {
        cleanup();
        reject(new QemuGuestAgentUnavailableError(error.message));
      });

      socket.write(Buffer.from([0xff]));
      socket.write(
        JSON.stringify({
          execute: "guest-sync-delimited",
          arguments: {
            id: syncId,
          },
        }),
      );
      socket.write("\n");
    });
  }
}

async function connectToGuestAgent(socketPath: string, timeoutMs: number) {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = new Socket();
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(
        new QemuGuestAgentUnavailableError(`Timed out connecting to guest agent at ${socketPath}.`),
      );
    }, timeoutMs);

    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(new QemuGuestAgentUnavailableError(error.message));
    });
    socket.connect(socketPath, () => {
      clearTimeout(timeout);
      resolve(socket);
    });
  });
}

function buildShellCommand(command: string, workingDirectory: string | undefined) {
  if (!workingDirectory) {
    return command;
  }

  return `cd ${quoteShell(workingDirectory)} && ${command}`;
}

function toGuestEnv(environment: Record<string, string> | undefined) {
  if (!environment) {
    return undefined;
  }

  return Object.entries(environment).map(([key, value]) => `${key}=${value}`);
}

function quoteShell(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readGuestExecPid(payload: Record<string, unknown>) {
  return readInteger(readReturnRecord(payload, "guest-exec"), "pid");
}

function readReturnRecord(payload: Record<string, unknown>, command: string) {
  const result = payload.return;
  if (!isRecord(result)) {
    throw new QemuGuestAgentProtocolError(`Expected "return" object from ${command}.`);
  }

  return result;
}

function readReturnInteger(payload: Record<string, unknown>, command: string) {
  const result = payload.return;
  if (typeof result !== "number" || !Number.isInteger(result)) {
    throw new QemuGuestAgentProtocolError(`Expected integer "return" from ${command}.`);
  }

  return result;
}

function readInteger(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new QemuGuestAgentProtocolError(`Expected integer "${key}" in guest agent response.`);
  }

  return value;
}

function readOptionalInteger(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new QemuGuestAgentProtocolError(`Expected optional integer "${key}" in response.`);
  }

  return value;
}

function readBoolean(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (typeof value !== "boolean") {
    throw new QemuGuestAgentProtocolError(`Expected boolean "${key}" in guest agent response.`);
  }

  return value;
}

function readOptionalBase64String(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    throw new QemuGuestAgentProtocolError(`Expected base64 string "${key}" in response.`);
  }

  const buffer = Buffer.from(value, "base64");
  if (buffer.length > MAX_CAPTURE_BYTES) {
    throw new QemuGuestAgentCommandError(
      `Guest agent output "${key}" exceeded ${MAX_CAPTURE_BYTES} bytes.`,
    );
  }

  return buffer.toString("utf8");
}

function readOptionalBase64Buffer(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (value === undefined) {
    return Buffer.alloc(0);
  }
  if (typeof value !== "string") {
    throw new QemuGuestAgentProtocolError(`Expected base64 string "${key}" in response.`);
  }

  return Buffer.from(value, "base64");
}
