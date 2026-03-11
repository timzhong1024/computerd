import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { connectConsoleClient, type ConsoleConnectionState } from "../transport/console-client";

interface ConsolePageProps {
  computerName: string;
  mode?: "console" | "exec";
}

export function ConsolePage({ computerName, mode = "console" }: ConsolePageProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<ConsoleConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (shellRef.current === null) {
      return;
    }

    const client = connectConsoleClient({
      computerName,
      mode,
      onError: setError,
      onStateChange: (nextState) => {
        setState(nextState);
        if (nextState === "connecting" || nextState === "connected") {
          setError(null);
        }
      },
      target: shellRef.current,
    });

    return () => {
      client.dispose();
    };
  }, [computerName, mode]);

  return (
    <main className="app-shell monitor-shell">
      <section className="hero monitor-hero">
        <div>
          <p className="eyebrow">Computer {mode}</p>
          <h1>{computerName}</h1>
          <p className="lede">
            {mode === "exec"
              ? "Interactive debug shell opened with docker exec over websocket."
              : "Interactive console attached to the computer's primary process/stdin over websocket."}
          </p>
        </div>
        <div className="surface-actions">
          <Link className="surface-link surface-link-secondary" to="/">
            Back to inventory
          </Link>
          <Link
            className="surface-link"
            to="/computers/$name/monitor"
            params={{ name: computerName }}
          >
            Open monitor
          </Link>
        </div>
      </section>

      <section className="panel monitor-panel">
        <div className="panel-header">
          <h2>Console shell</h2>
          <span className={`status-pill status-${state}`} data-testid="console-state">
            {renderStateLabel(state)}
          </span>
        </div>
        <p className="monitor-copy">
          {mode === "exec"
            ? "Exec opens a fresh /bin/sh inside the running container for debugging; it does not attach to the main process."
            : "Console attaches to the computer's primary interactive process/stdin rather than starting a new shell."}
        </p>
        {error ? <p role="alert">{error}</p> : null}
        <div ref={shellRef} className="console-shell" data-testid="console-shell" />
      </section>
    </main>
  );
}

function renderStateLabel(state: ConsoleConnectionState) {
  const labels = {
    connecting: "connecting",
    connected: "connected",
    disconnected: "disconnected",
    error: "error",
  } as const;

  return labels[state];
}
