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

  const unavailableTimer = window.setTimeout(() => {
    onStateChange("unavailable");
  }, 0);

  return {
    dispose() {
      window.clearTimeout(unavailableTimer);
      target.replaceChildren();
    },
  };
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
