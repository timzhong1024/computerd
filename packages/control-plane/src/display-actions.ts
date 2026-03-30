import { setTimeout as delay } from "node:timers/promises";
import { Socket } from "node:net";
import type {
  BrowserViewport,
  ComputerScreenshot,
  DisplayAction,
  DisplayMouseButton,
  RunDisplayActionsObserve,
  RunDisplayActionsResult,
} from "@computerd/core";

interface ExecuteDisplayActionsOptions {
  computerName: string;
  host?: string;
  port: number;
  viewport: BrowserViewport;
  ops: DisplayAction[];
  observe: RunDisplayActionsObserve;
  captureScreenshot: () => Promise<ComputerScreenshot>;
}

interface VncSessionInfo {
  width: number;
  height: number;
}

type RfbConnector = (host: string, port: number) => Promise<RfbConnection>;

export async function executeDisplayActionsOverVnc(
  options: ExecuteDisplayActionsOptions,
  connect: RfbConnector = connectToRfb,
): Promise<RunDisplayActionsResult> {
  const host = options.host ?? "127.0.0.1";
  const startedAt = new Date().toISOString();
  let completedOpCount = 0;
  let viewport: BrowserViewport = options.viewport;

  try {
    const connection = await connect(host, options.port);
    viewport = {
      width: connection.server.width,
      height: connection.server.height,
    };

    try {
      for (const [index, op] of options.ops.entries()) {
        try {
          await executeOneDisplayAction(connection, viewport, op);
          completedOpCount = index + 1;
        } catch (error) {
          return {
            computerName: options.computerName,
            completedOpCount,
            stoppedAtOpIndex: index,
            failure: classifyDisplayActionError(error),
            viewport,
            screenshot: options.observe.screenshot ? await captureScreenshot(options) : undefined,
            capturedAt: new Date().toISOString(),
          };
        }
      }
    } finally {
      connection.close();
    }
  } catch (error) {
    return {
      computerName: options.computerName,
      completedOpCount,
      stoppedAtOpIndex: completedOpCount,
      failure: classifyDisplayActionError(error),
      viewport,
      capturedAt: new Date().toISOString(),
    };
  }

  const screenshot = options.observe.screenshot ? await captureScreenshot(options) : undefined;

  return {
    computerName: options.computerName,
    completedOpCount,
    viewport:
      screenshot === undefined
        ? (viewport ?? {
            width: 0,
            height: 0,
          })
        : {
            width: screenshot.width,
            height: screenshot.height,
          },
    screenshot,
    capturedAt: screenshot?.capturedAt ?? startedAt,
  };
}

async function captureScreenshot(options: ExecuteDisplayActionsOptions) {
  try {
    return await options.captureScreenshot();
  } catch (error) {
    throw new ScreenshotCaptureError(
      error instanceof Error ? error.message : "Display action screenshot capture failed.",
    );
  }
}

async function executeOneDisplayAction(
  connection: RfbConnection,
  viewport: BrowserViewport,
  op: DisplayAction,
) {
  if (op.type === "mouse.move") {
    assertCoordinatesInViewport(op.x, op.y, viewport);
    connection.movePointer(op.x, op.y);
    return;
  }

  if (op.type === "mouse.down") {
    connection.setButtonDown(op.button, true);
    return;
  }

  if (op.type === "mouse.up") {
    connection.setButtonDown(op.button, false);
    return;
  }

  if (op.type === "mouse.scroll") {
    connection.scrollPointer(op.deltaX, op.deltaY);
    return;
  }

  if (op.type === "key.down") {
    connection.keyEvent(op.key, true);
    return;
  }

  if (op.type === "key.up") {
    connection.keyEvent(op.key, false);
    return;
  }

  if (op.type === "key.press") {
    connection.keyEvent(op.key, true);
    connection.keyEvent(op.key, false);
    return;
  }

  if (op.type === "text.insert") {
    for (const character of [...op.text]) {
      connection.keyEvent(character, true);
      connection.keyEvent(character, false);
    }
    return;
  }

  await delay(op.ms);
}

function assertCoordinatesInViewport(x: number, y: number, viewport: BrowserViewport) {
  if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
    throw new CoordinateOutOfBoundsError(
      `Pointer target (${x}, ${y}) is outside viewport ${viewport.width}x${viewport.height}.`,
    );
  }
}

function classifyDisplayActionError(error: unknown) {
  if (error instanceof CoordinateOutOfBoundsError) {
    return {
      code: "coordinate-out-of-bounds" as const,
      message: error.message,
    };
  }

  if (error instanceof UnsupportedDisplayOperationError) {
    return {
      code: "unsupported-operation" as const,
      message: error.message,
    };
  }

  if (error instanceof ScreenshotCaptureError) {
    return {
      code: "capture-error" as const,
      message: error.message,
    };
  }

  return {
    code: "transport-error" as const,
    message: error instanceof Error ? error.message : "Display action execution failed.",
  };
}

class CoordinateOutOfBoundsError extends Error {}
class UnsupportedDisplayOperationError extends Error {}
class ScreenshotCaptureError extends Error {}

class RfbConnection {
  private pointerX = 0;
  private pointerY = 0;
  private buttonMask = 0;

  constructor(
    private readonly socket: Socket,
    readonly server: VncSessionInfo,
  ) {}

  movePointer(x: number, y: number) {
    this.pointerX = x;
    this.pointerY = y;
    this.sendPointerEvent();
  }

  setButtonDown(button: DisplayMouseButton, pressed: boolean) {
    const maskBit = buttonMaskFor(button);
    this.buttonMask = pressed ? this.buttonMask | maskBit : this.buttonMask & ~maskBit;
    this.sendPointerEvent();
  }

  scrollPointer(deltaX: number, deltaY: number) {
    for (const [button, count] of [
      [deltaY < 0 ? 4 : 5, Math.abs(deltaY)],
      [deltaX < 0 ? 6 : 7, Math.abs(deltaX)],
    ] as const) {
      for (let index = 0; index < count; index += 1) {
        this.sendPointerEvent(button);
        this.sendPointerEvent();
      }
    }
  }

  keyEvent(key: string, down: boolean) {
    const payload = Buffer.alloc(8);
    payload[0] = 4;
    payload[1] = down ? 1 : 0;
    payload.writeUInt32BE(resolveKeysym(key), 4);
    this.socket.write(payload);
  }

  close() {
    this.socket.end();
    this.socket.destroy();
  }

  private sendPointerEvent(overrideMask?: number) {
    const payload = Buffer.alloc(6);
    payload[0] = 5;
    payload[1] = overrideMask ?? this.buttonMask;
    payload.writeUInt16BE(this.pointerX, 2);
    payload.writeUInt16BE(this.pointerY, 4);
    this.socket.write(payload);
  }
}

async function connectToRfb(host: string, port: number) {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const connection = new Socket();
    connection.once("error", reject);
    connection.connect(port, host, () => {
      connection.off("error", reject);
      resolve(connection);
    });
  });
  socket.setNoDelay(true);

  const reader = new SocketReader(socket);
  const protocolVersion = (await reader.readExact(12)).toString("ascii");
  if (!protocolVersion.startsWith("RFB 003.")) {
    socket.destroy();
    throw new Error(`Unsupported RFB protocol banner: ${protocolVersion}`);
  }
  socket.write(Buffer.from("RFB 003.008\n", "ascii"));

  const majorVersion = Number.parseInt(protocolVersion.slice(4, 7), 10);
  const minorVersion = Number.parseInt(protocolVersion.slice(8, 11), 10);
  let securityType = 0;

  if (majorVersion > 3 || (majorVersion === 3 && minorVersion >= 7)) {
    const count = (await reader.readExact(1)).readUInt8(0);
    if (count === 0) {
      const reasonLength = (await reader.readExact(4)).readUInt32BE(0);
      const reason = (await reader.readExact(reasonLength)).toString("utf8");
      throw new Error(`VNC server rejected the connection: ${reason}`);
    }

    const securityTypes = [...(await reader.readExact(count))];
    if (!securityTypes.includes(1)) {
      throw new UnsupportedDisplayOperationError(
        `VNC server does not support the no-auth security type required by computerd.`,
      );
    }
    securityType = 1;
    socket.write(Buffer.from([securityType]));
  } else {
    securityType = (await reader.readExact(4)).readUInt32BE(0);
    if (securityType !== 1) {
      throw new UnsupportedDisplayOperationError(
        `Unsupported legacy VNC security type ${securityType}.`,
      );
    }
  }

  if (securityType === 1) {
    const resultCode = (await reader.readExact(4)).readUInt32BE(0);
    if (resultCode !== 0) {
      throw new Error(`VNC authentication failed with result code ${resultCode}.`);
    }
  }

  socket.write(Buffer.from([1]));
  const serverInit = await reader.readExact(24);
  const width = serverInit.readUInt16BE(0);
  const height = serverInit.readUInt16BE(2);
  const nameLength = serverInit.readUInt32BE(20);
  if (nameLength > 0) {
    await reader.readExact(nameLength);
  }

  return new RfbConnection(socket, { width, height });
}

class SocketReader {
  private readonly queue: Buffer[] = [];
  private queuedBytes = 0;

  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk) => {
      this.queue.push(chunk);
      this.queuedBytes += chunk.length;
      this.flush();
    });
  }

  private pending:
    | {
        bytes: number;
        resolve: (value: Buffer) => void;
        reject: (error: Error) => void;
      }
    | undefined;

  readExact(bytes: number) {
    return new Promise<Buffer>((resolve, reject) => {
      this.pending = {
        bytes,
        resolve,
        reject,
      };
      this.flush();
      this.socket.once("error", (error) =>
        reject(error instanceof Error ? error : new Error(String(error))),
      );
      this.socket.once("close", () => {
        if (this.pending !== undefined) {
          reject(new Error("VNC socket closed before the requested bytes were read."));
        }
      });
    });
  }

  private flush() {
    if (this.pending === undefined || this.queuedBytes < this.pending.bytes) {
      return;
    }

    const { bytes, resolve } = this.pending;
    this.pending = undefined;
    const output = Buffer.alloc(bytes);
    let offset = 0;
    while (offset < bytes) {
      const chunk = this.queue[0];
      if (!chunk) {
        break;
      }

      const remaining = bytes - offset;
      if (chunk.length <= remaining) {
        chunk.copy(output, offset);
        offset += chunk.length;
        this.queue.shift();
        this.queuedBytes -= chunk.length;
        continue;
      }

      chunk.copy(output, offset, 0, remaining);
      this.queue[0] = chunk.subarray(remaining);
      this.queuedBytes -= remaining;
      offset += remaining;
    }

    resolve(output);
  }
}

function buttonMaskFor(button: DisplayMouseButton) {
  if (button === "left") {
    return 1;
  }
  if (button === "middle") {
    return 2;
  }
  return 4;
}

function resolveKeysym(key: string) {
  const namedKey = NAMED_KEYSYMS[key];
  if (namedKey !== undefined) {
    return namedKey;
  }

  const codePoint = key.codePointAt(0);
  if (codePoint === undefined) {
    throw new UnsupportedDisplayOperationError(`Key ${JSON.stringify(key)} is not supported.`);
  }

  if (key.length === 1) {
    return codePoint <= 0xff ? codePoint : 0x01000000 | codePoint;
  }

  throw new UnsupportedDisplayOperationError(`Key ${JSON.stringify(key)} is not supported.`);
}

const NAMED_KEYSYMS: Record<string, number> = {
  Alt: 0xffe9,
  ArrowDown: 0xff54,
  ArrowLeft: 0xff51,
  ArrowRight: 0xff53,
  ArrowUp: 0xff52,
  Backspace: 0xff08,
  Control: 0xffe3,
  Delete: 0xffff,
  End: 0xff57,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Home: 0xff50,
  Meta: 0xffe7,
  PageDown: 0xff56,
  PageUp: 0xff55,
  Shift: 0xffe1,
  Space: 0x20,
  Tab: 0xff09,
  F1: 0xffbe,
  F2: 0xffbf,
  F3: 0xffc0,
  F4: 0xffc1,
  F5: 0xffc2,
  F6: 0xffc3,
  F7: 0xffc4,
  F8: 0xffc5,
  F9: 0xffc6,
  F10: 0xffc7,
  F11: 0xffc8,
  F12: 0xffc9,
};

export { CoordinateOutOfBoundsError, ScreenshotCaptureError, UnsupportedDisplayOperationError };
