import { useEffect, useRef, useState } from "react";
import type { ComputerMonitorSession } from "@computerd/core";
import { createMonitorSession, updateBrowserViewport } from "../transport/computer-sessions";
import { connectMonitorClient, type MonitorConnectionState } from "../transport/monitor-client";
import { formatError } from "../transport/http";

interface MonitorPageProps {
  computerName: string;
}

export function MonitorPage({ computerName }: MonitorPageProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const lastViewportRef = useRef<string | null>(null);
  const [session, setSession] = useState<ComputerMonitorSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<MonitorConnectionState>("connecting");

  useEffect(() => {
    document.title = `${computerName} - Computerd Browser`;
    return () => {
      document.title = "Computerd";
    };
  }, [computerName]);

  useEffect(() => {
    let cancelled = false;

    setSession(null);
    setError(null);
    setState("connecting");

    void createMonitorSession(computerName)
      .then((nextSession) => {
        if (cancelled) {
          return;
        }

        lastViewportRef.current =
          nextSession.viewport === undefined
            ? null
            : `${nextSession.viewport.width}x${nextSession.viewport.height}`;
        setSession(nextSession);
      })
      .catch((caughtError) => {
        if (cancelled) {
          return;
        }

        setError(formatError(caughtError));
      });

    return () => {
      cancelled = true;
    };
  }, [computerName]);

  useEffect(() => {
    if (session === null || shellRef.current === null) {
      return;
    }

    const client = connectMonitorClient({
      session,
      target: shellRef.current,
      onStateChange: setState,
    });

    return () => {
      client.dispose();
    };
  }, [session]);

  useEffect(() => {
    if (shellRef.current === null || typeof ResizeObserver === "undefined") {
      return;
    }

    const target = shellRef.current;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) {
        return;
      }

      const nextViewport = normalizeViewport(entry.contentRect.width, entry.contentRect.height);
      if (nextViewport === null) {
        return;
      }

      const key = `${nextViewport.width}x${nextViewport.height}`;
      if (key === lastViewportRef.current) {
        return;
      }

      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }

      timeoutId = setTimeout(() => {
        void updateBrowserViewport(computerName, nextViewport)
          .then((detail) => {
            if (cancelled || detail.profile !== "browser") {
              return;
            }

            const appliedViewport = detail.runtime.display.viewport;
            lastViewportRef.current = `${appliedViewport.width}x${appliedViewport.height}`;
          })
          .catch((caughtError) => {
            if (cancelled) {
              return;
            }

            console.warn("Failed to update browser viewport.", caughtError);
          });
      }, 150);
    });

    observer.observe(target);

    return () => {
      cancelled = true;
      observer.disconnect();
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    };
  }, [computerName]);

  return (
    <main className="browser-stage-shell">
      {error ? (
        <div className="alert browser-stage-alert" role="alert">
          {error}
        </div>
      ) : null}

      <div ref={shellRef} className="browser-stage-canvas-shell" data-testid="novnc-shell" />
      <span className="browser-stage-status" data-testid="monitor-state">
        {formatMonitorStateLabel(state, session)}
      </span>
    </main>
  );
}

function normalizeViewport(width: number, height: number) {
  const normalizedWidth = Math.max(Math.floor(width), 320);
  const normalizedHeight = Math.max(Math.floor(height), 240);
  if (!Number.isFinite(normalizedWidth) || !Number.isFinite(normalizedHeight)) {
    return null;
  }

  return {
    width: normalizedWidth,
    height: normalizedHeight,
  };
}

function formatMonitorStateLabel(
  state: MonitorConnectionState,
  session: ComputerMonitorSession | null,
) {
  if (session === null && state === "connecting") {
    return "loading session";
  }

  if (state === "connected") {
    return "connected";
  }

  if (state === "unavailable") {
    return "websocket unavailable";
  }

  return "connecting";
}
