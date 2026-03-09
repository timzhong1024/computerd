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
    <main className="app-shell monitor-shell">
      <section className="hero monitor-hero">
        <div>
          <p className="eyebrow">Computer monitor</p>
          <h1>{computerName}</h1>
          <p className="lede">Live browser surface backed by a noVNC session.</p>
        </div>
        <div className="surface-actions">
          <Link className="surface-link surface-link-secondary" to="/">
            Back to inventory
          </Link>
          <Link
            className="surface-link surface-link-secondary"
            to="/computers/$name/console"
            params={{ name: computerName }}
          >
            Open console
          </Link>
        </div>
      </section>

      {error ? (
        <div className="alert" role="alert">
          {error}
        </div>
      ) : null}

      <section className="panel monitor-panel">
        <div className="panel-header">
          <h2>Monitor session</h2>
          <span className={`status-pill status-${state}`} data-testid="monitor-state">
            {formatMonitorStateLabel(state, session)}
          </span>
        </div>
        <p className="monitor-copy">
          {session === null
            ? "Loading monitor session."
            : "Browser session connected through the noVNC bridge."}
        </p>
        <div ref={shellRef} className="novnc-shell" data-testid="novnc-shell" />
        {session ? (
          <dl className="detail-grid session-grid">
            <div>
              <dt>Protocol</dt>
              <dd>{session.protocol}</dd>
            </div>
            <div>
              <dt>Connect mode</dt>
              <dd>{session.connect.mode}</dd>
            </div>
            <div>
              <dt>Connect target</dt>
              <dd>{session.connect.url}</dd>
            </div>
            <div>
              <dt>Authorization</dt>
              <dd>{session.authorization.mode}</dd>
            </div>
          </dl>
        ) : null}
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
