import { useEffect, useRef, useState } from "react";
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
    <main className="browser-stage-shell">
      <header className="browser-stage-toolbar">
        <p className="eyebrow">Browser stage</p>
        <h1>{computerName}</h1>
      </header>

      {error ? (
        <div className="alert browser-stage-alert" role="alert">
          {error}
        </div>
      ) : null}

      <section className="browser-stage-viewport">
        <div ref={shellRef} className="novnc-shell novnc-stage" data-testid="novnc-shell" />
      </section>
      <span className="browser-stage-status" data-testid="monitor-state">
        {formatMonitorStateLabel(state, session)}
      </span>
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
