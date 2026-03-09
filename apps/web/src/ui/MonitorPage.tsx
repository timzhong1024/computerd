import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { ComputerMonitorSession } from "@computerd/core";
import { createMonitorSession } from "../transport/computer-sessions";
import { connectMonitorClient, type MonitorConnectionState } from "../transport/monitor-client";
import { formatError } from "../transport/http";

interface MonitorPageProps {
  computerName: string;
}

export function MonitorPage({ computerName }: MonitorPageProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [session, setSession] = useState<ComputerMonitorSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<MonitorConnectionState>("connecting");
  const viewport = session?.viewport ?? { width: 1440, height: 900 };

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

  return (
    <main className="browser-stage-shell">
      <header className="browser-stage-toolbar">
        <div className="browser-stage-meta">
          <p className="eyebrow">Browser stage</p>
          <h1>{computerName}</h1>
          <p className="browser-stage-copy">
            {session === null
              ? "Loading browser session."
              : `${viewport.width}x${viewport.height} remote surface over noVNC.`}
          </p>
        </div>
        <div className="browser-stage-actions">
          <Link className="surface-link surface-link-secondary" to="/">
            Back to inventory
          </Link>
          <span className={`status-pill status-${state}`} data-testid="monitor-state">
            {formatMonitorStateLabel(state, session)}
          </span>
        </div>
      </header>

      {error ? (
        <div className="alert browser-stage-alert" role="alert">
          {error}
        </div>
      ) : null}

      <section className="browser-stage-viewport">
        <div
          className="browser-stage-frame"
          style={
            session === null
              ? undefined
              : {
                  width: `${viewport.width}px`,
                  height: `${viewport.height}px`,
                }
          }
        >
          <div ref={shellRef} className="novnc-shell novnc-stage" data-testid="novnc-shell" />
        </div>
      </section>
    </main>
  );
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
