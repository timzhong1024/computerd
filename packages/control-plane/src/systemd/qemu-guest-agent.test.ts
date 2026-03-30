import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { QemuGuestAgentClient } from "./qemu-guest-agent";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

test("runs guest commands through guest-exec and guest-exec-status", async () => {
  const guestAgent = await createFakeGuestAgentServer();
  const client = new QemuGuestAgentClient(guestAgent.socketPath);

  await client.waitForReady();
  const result = await client.runCommand({
    command: "echo ready",
    shell: true,
    captureOutput: true,
    environment: {
      TEST_VALUE: "123",
    },
  });

  expect(result).toMatchObject({
    exitCode: 0,
    stdout: "echo ready",
    stderr: "",
    timedOut: false,
  });
  expect(guestAgent.lastExecArguments).toMatchObject({
    path: "/bin/sh",
    arg: ["-lc", "echo ready"],
    env: ["TEST_VALUE=123"],
    "capture-output": true,
  });

  await guestAgent.close();
});

test("writes and reads guest files through guest-file commands", async () => {
  const guestAgent = await createFakeGuestAgentServer();
  const client = new QemuGuestAgentClient(guestAgent.socketPath);

  await client.waitForReady();
  await expect(
    client.writeFile({
      path: "/tmp/nested/result.txt",
      dataBase64: Buffer.from("hello guest", "utf8").toString("base64"),
      createParents: true,
      mode: 0o644,
    }),
  ).resolves.toMatchObject({
    path: "/tmp/nested/result.txt",
    sizeBytes: 11,
  });

  await expect(
    client.readFile({
      path: "/tmp/nested/result.txt",
    }),
  ).resolves.toMatchObject({
    path: "/tmp/nested/result.txt",
    dataBase64: Buffer.from("hello guest", "utf8").toString("base64"),
    sizeBytes: 11,
    truncated: false,
  });

  expect(guestAgent.files.get("/tmp/nested/result.txt")?.toString("utf8")).toBe("hello guest");
  expect(guestAgent.executedCommands).toEqual(
    expect.arrayContaining([
      expect.stringContaining("mkdir -p '/tmp/nested'"),
      expect.stringContaining("chmod 644 '/tmp/nested/result.txt'"),
    ]),
  );

  await guestAgent.close();
});

async function createFakeGuestAgentServer() {
  const root = await mkdtemp(join(tmpdir(), "computerd-qga-"));
  tempDirectories.push(root);
  const socketPath = join(root, "guest-agent.sock");
  const files = new Map<string, Buffer>();
  const fileHandles = new Map<number, { path: string; mode: string; offset: number }>();
  const execResults = new Map<number, { exitcode: number; out: string; err: string }>();
  const executedCommands: string[] = [];
  let nextHandle = 1;
  let nextPid = 1;
  let lastExecArguments: Record<string, unknown> | null = null;

  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += Buffer.from(chunk.filter((byte) => byte !== 0xff)).toString("utf8");
      while (true) {
        const newlineIndex = buffer.search(/\r?\n/);
        if (newlineIndex === -1) {
          return;
        }

        const line = buffer.slice(0, newlineIndex).trim();
        const sliceEnd = buffer[newlineIndex] === "\r" && buffer[newlineIndex + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(newlineIndex + sliceEnd);
        if (line.length === 0) {
          continue;
        }

        const request = JSON.parse(line) as {
          execute?: string;
          arguments?: Record<string, unknown>;
        };
        const response = handleGuestAgentRequest(request, {
          execResults,
          executedCommands,
          fileHandles,
          files,
          nextHandle: () => nextHandle++,
          nextPid: () => nextPid++,
          setLastExecArguments(value) {
            lastExecArguments = value;
          },
        });
        socket.write(`${JSON.stringify(response)}\n`);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    executedCommands,
    files,
    get lastExecArguments() {
      return lastExecArguments;
    },
    socketPath,
    async close() {
      await closeServer(server);
      await rm(root, { force: true, recursive: true });
    },
  };
}

function handleGuestAgentRequest(
  request: { execute?: string; arguments?: Record<string, unknown> },
  state: {
    execResults: Map<number, { exitcode: number; out: string; err: string }>;
    executedCommands: string[];
    fileHandles: Map<number, { path: string; mode: string; offset: number }>;
    files: Map<string, Buffer>;
    nextHandle: () => number;
    nextPid: () => number;
    setLastExecArguments: (value: Record<string, unknown>) => void;
  },
) {
  if (request.execute === "guest-sync-delimited") {
    return { return: request.arguments?.id ?? null };
  }

  if (request.execute === "guest-exec") {
    const pid = state.nextPid();
    const argumentsPayload = request.arguments ?? {};
    state.setLastExecArguments(argumentsPayload);
    const command = readGuestCommand(argumentsPayload);
    state.executedCommands.push(command);
    state.execResults.set(pid, {
      exitcode: 0,
      out: command,
      err: "",
    });
    return { return: { pid } };
  }

  if (request.execute === "guest-exec-status") {
    const pid = request.arguments?.pid;
    if (typeof pid !== "number") {
      return { error: { desc: "missing pid" } };
    }
    const result = state.execResults.get(pid);
    if (!result) {
      return { error: { desc: "unknown pid" } };
    }
    return {
      return: {
        exited: true,
        exitcode: result.exitcode,
        "out-data": Buffer.from(result.out, "utf8").toString("base64"),
        "err-data": Buffer.from(result.err, "utf8").toString("base64"),
      },
    };
  }

  if (request.execute === "guest-file-open") {
    const path = request.arguments?.path;
    const mode = request.arguments?.mode;
    if (typeof path !== "string" || typeof mode !== "string") {
      return { error: { desc: "invalid guest-file-open request" } };
    }
    const handle = state.nextHandle();
    if (mode === "wb") {
      state.files.set(path, Buffer.alloc(0));
    }
    state.fileHandles.set(handle, { path, mode, offset: 0 });
    return { return: handle };
  }

  if (request.execute === "guest-file-read") {
    const handle = request.arguments?.handle;
    const count = request.arguments?.count;
    if (typeof handle !== "number" || typeof count !== "number") {
      return { error: { desc: "invalid guest-file-read request" } };
    }
    const fileHandle = state.fileHandles.get(handle);
    if (!fileHandle) {
      return { error: { desc: "unknown file handle" } };
    }
    const file = state.files.get(fileHandle.path) ?? Buffer.alloc(0);
    const chunk = file.subarray(fileHandle.offset, fileHandle.offset + count);
    fileHandle.offset += chunk.length;
    return {
      return: {
        count: chunk.length,
        eof: fileHandle.offset >= file.length,
        "buf-b64": chunk.toString("base64"),
      },
    };
  }

  if (request.execute === "guest-file-write") {
    const handle = request.arguments?.handle;
    const payload = request.arguments?.["buf-b64"];
    if (typeof handle !== "number" || typeof payload !== "string") {
      return { error: { desc: "invalid guest-file-write request" } };
    }
    const fileHandle = state.fileHandles.get(handle);
    if (!fileHandle) {
      return { error: { desc: "unknown file handle" } };
    }
    const chunk = Buffer.from(payload, "base64");
    const existing = state.files.get(fileHandle.path) ?? Buffer.alloc(0);
    state.files.set(fileHandle.path, Buffer.concat([existing, chunk]));
    fileHandle.offset += chunk.length;
    return { return: chunk.length };
  }

  if (request.execute === "guest-file-close") {
    const handle = request.arguments?.handle;
    if (typeof handle === "number") {
      state.fileHandles.delete(handle);
    }
    return { return: null };
  }

  return { error: { desc: `unsupported command: ${String(request.execute)}` } };
}

function readGuestCommand(argumentsPayload: Record<string, unknown>) {
  const path = argumentsPayload.path;
  const arg = argumentsPayload.arg;
  if (path === "/bin/sh" && Array.isArray(arg) && arg[0] === "-lc" && typeof arg[1] === "string") {
    return arg[1];
  }
  if (typeof path === "string") {
    return path;
  }
  throw new TypeError("Expected a guest command payload.");
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
