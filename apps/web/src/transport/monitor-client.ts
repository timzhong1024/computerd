import type { ComputerMonitorSession } from "@computerd/core";

export type MonitorConnectionState = "connecting" | "connected" | "unavailable";

export interface MonitorClientHandle {
  dispose: () => void;
}

interface ConnectMonitorClientOptions {
  session: ComputerMonitorSession;
  target: HTMLElement;
  onStateChange: (state: MonitorConnectionState) => void;
}

export function connectMonitorClient({
  session,
  target,
  onStateChange,
}: ConnectMonitorClientOptions): MonitorClientHandle {
  const websocketUrl = buildMonitorWebSocketUrl(session);
  console.info("[monitor] connect:start", {
    computerName: session.computerName,
    websocketUrl,
  });
  logMonitorDimensions("initial-target", target);
  onStateChange("connecting");
  target.replaceChildren(createMonitorPlaceholder(websocketUrl));
  let disposed = false;
  let rfb: NoVncRfbLike | null = null;
  let snapshotTimer: ReturnType<typeof setInterval> | null = null;

  void loadNoVnc()
    .then((RFB) => {
      if (disposed) {
        return;
      }

      target.replaceChildren();
      rfb = new RFB(target, websocketUrl);
      console.info("[monitor] rfb:constructed");
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.viewOnly = false;
      rfb.addEventListener("connect", () => {
        console.info("[monitor] rfb:connect");
        logMonitorTree(target);
        onStateChange("connected");
      });
      rfb.addEventListener("disconnect", (event) => {
        console.warn("[monitor] rfb:disconnect", event);
        logMonitorTree(target);
        onStateChange("unavailable");
      });
      rfb.addEventListener("credentialsrequired", (event) => {
        console.info("[monitor] rfb:credentialsrequired", event);
      });
      rfb.addEventListener("securityfailure", (event) => {
        console.error("[monitor] rfb:securityfailure", event);
      });
      rfb.addEventListener("clippingviewport", (event) => {
        console.info("[monitor] rfb:clippingviewport", event);
        logMonitorTree(target);
      });

      snapshotTimer = setInterval(() => {
        if (disposed) {
          return;
        }

        logMonitorTree(target);
      }, 2_000);
    })
    .catch((error: unknown) => {
      if (disposed) {
        return;
      }

      console.error("Failed to initialize noVNC monitor client.", error);
      onStateChange("unavailable");
      target.replaceChildren(createMonitorUnavailable(websocketUrl));
    });

  return {
    dispose() {
      disposed = true;
      if (snapshotTimer !== null) {
        clearInterval(snapshotTimer);
      }
      rfb?.disconnect();
      target.replaceChildren();
    },
  };
}

type NoVncRfbLike = {
  scaleViewport: boolean;
  resizeSession: boolean;
  viewOnly: boolean;
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  disconnect: () => void;
};

async function loadNoVnc(): Promise<new (target: HTMLElement, url: string) => NoVncRfbLike> {
  const module = (await import("./novnc-rfb")) as {
    default: new (target: HTMLElement, url: string) => NoVncRfbLike;
  };
  return module.default;
}

function buildMonitorWebSocketUrl(session: ComputerMonitorSession) {
  const baseUrl =
    session.connect.mode === "websocket-url"
      ? new URL(session.connect.url)
      : new URL(session.connect.url, toWebSocketOrigin(window.location));

  if (session.authorization.mode === "ticket") {
    baseUrl.searchParams.set("ticket", session.authorization.ticket);
  }

  return baseUrl.toString();
}

function toWebSocketOrigin(location: Location) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}`;
}

function createMonitorPlaceholder(websocketUrl: string) {
  const placeholder = document.createElement("div");
  placeholder.className = "novnc-placeholder";

  const title = document.createElement("strong");
  title.textContent = "noVNC shell prepared";
  placeholder.append(title);

  const copy = document.createElement("p");
  copy.textContent = `Waiting for backend WebSocket bridge at ${websocketUrl}.`;
  placeholder.append(copy);

  return placeholder;
}

function createMonitorUnavailable(websocketUrl: string) {
  const placeholder = document.createElement("div");
  placeholder.className = "novnc-placeholder";

  const title = document.createElement("strong");
  title.textContent = "noVNC failed to initialize";
  placeholder.append(title);

  const copy = document.createElement("p");
  copy.textContent = `The browser monitor could not load its noVNC client for ${websocketUrl}. Check the browser console and Vite dev server logs.`;
  placeholder.append(copy);

  return placeholder;
}

function logMonitorTree(target: HTMLElement) {
  logMonitorDimensions("target", target);
  const screen = target.firstElementChild;
  if (screen instanceof HTMLDivElement) {
    logMonitorDimensions("screen", screen);
  } else {
    console.info("[monitor] screen:missing");
  }

  const canvas = target.querySelector("canvas");
  if (canvas instanceof HTMLCanvasElement) {
    logMonitorDimensions("canvas", canvas);
    console.info("[monitor] canvas:bitmap", {
      width: canvas.width,
      height: canvas.height,
    });
  } else {
    console.info("[monitor] canvas:missing");
  }
}

function logMonitorDimensions(label: string, element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  console.info(`[monitor] ${label}:dimensions`, {
    className: element.className,
    clientWidth: element.clientWidth,
    clientHeight: element.clientHeight,
    offsetWidth: element.offsetWidth,
    offsetHeight: element.offsetHeight,
    scrollWidth: element.scrollWidth,
    scrollHeight: element.scrollHeight,
    rectWidth: rect.width,
    rectHeight: rect.height,
    styleWidth: element.style.width || null,
    styleHeight: element.style.height || null,
  });
}
