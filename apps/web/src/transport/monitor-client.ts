import type { ComputerMonitorSession } from "@computerd/core";

export type MonitorConnectionState = "connecting" | "connected" | "unavailable";

export interface MonitorClientHandle {
  dispose: () => void;
}

interface ConnectMonitorClientOptions {
  session: ComputerMonitorSession;
  target: HTMLDivElement;
  onStateChange: (state: MonitorConnectionState) => void;
}

export function connectMonitorClient({
  session,
  target,
  onStateChange,
}: ConnectMonitorClientOptions): MonitorClientHandle {
  const websocketUrl = buildMonitorWebSocketUrl(session);
  onStateChange("connecting");
  target.replaceChildren(createMonitorPlaceholder(websocketUrl));
  let disposed = false;
  let rfb: NoVncRfbLike | null = null;

  void loadNoVnc()
    .then((RFB) => {
      if (disposed) {
        return;
      }

      target.replaceChildren();
      rfb = new RFB(target, websocketUrl);
      rfb.scaleViewport = true;
      rfb.resizeSession = true;
      rfb.viewOnly = false;
      rfb.addEventListener("connect", () => {
        onStateChange("connected");
      });
      rfb.addEventListener("disconnect", () => {
        onStateChange("unavailable");
      });
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

async function loadNoVnc(): Promise<new (target: HTMLDivElement, url: string) => NoVncRfbLike> {
  const module = (await import("@novnc/novnc")) as {
    default: new (target: HTMLDivElement, url: string) => NoVncRfbLike;
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
