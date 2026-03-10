import { useEffect, useRef, useState } from "react";
import type { ComputerAudioSession, ComputerMonitorSession } from "@computerd/core";
import {
  createAudioSession,
  createMonitorSession,
  updateBrowserViewport,
} from "../transport/computer-sessions";
import { connectMonitorClient, type MonitorConnectionState } from "../transport/monitor-client";
import { formatError } from "../transport/http";

interface MonitorPageProps {
  computerName: string;
}

export function MonitorPage({ computerName }: MonitorPageProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastViewportRef = useRef<string | null>(null);
  const [session, setSession] = useState<ComputerMonitorSession | null>(null);
  const [audioSession, setAudioSession] = useState<ComputerAudioSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [videoState, setVideoState] = useState<MonitorConnectionState>("connecting");
  const [audioState, setAudioState] = useState<AudioConnectionState>("connecting");

  useEffect(() => {
    document.title = `${computerName} - Computerd Browser`;
    return () => {
      document.title = "Computerd";
    };
  }, [computerName]);

  useEffect(() => {
    let cancelled = false;

    setSession(null);
    setAudioSession(null);
    setError(null);
    setVideoState("connecting");
    setAudioState("connecting");

    void Promise.allSettled([
      createMonitorSession(computerName),
      createAudioSession(computerName),
    ]).then(([monitorResult, audioResult]) => {
      if (cancelled) {
        return;
      }

      if (monitorResult.status === "fulfilled") {
        lastViewportRef.current =
          monitorResult.value.viewport === undefined
            ? null
            : `${monitorResult.value.viewport.width}x${monitorResult.value.viewport.height}`;
        setSession(monitorResult.value);
      } else {
        setError(formatError(monitorResult.reason));
      }

      if (audioResult.status === "fulfilled") {
        setAudioSession(audioResult.value);
      } else {
        console.warn("Failed to create browser audio session.", audioResult.reason);
        setAudioState("unavailable");
      }
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
      onStateChange: setVideoState,
    });

    return () => {
      client.dispose();
    };
  }, [session]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio === null || audioSession === null) {
      return;
    }

    let cancelled = false;
    const nextUrl = buildAudioStreamUrl(audioSession);
    setAudioState("connecting");
    audio.src = nextUrl;
    safelyInvokeMediaMethod(audio, "load");

    const tryPlay = () => {
      void audio
        .play()
        .then(() => {
          if (!cancelled) {
            setAudioState("connected");
          }
        })
        .catch(() => {
          if (!cancelled) {
            setAudioState("blocked");
          }
        });
    };

    const handleCanPlay = () => {
      if (cancelled) {
        return;
      }

      tryPlay();
    };
    const handlePlaying = () => {
      if (!cancelled) {
        setAudioState("connected");
      }
    };
    const handleError = () => {
      if (!cancelled) {
        setAudioState("unavailable");
      }
    };

    audio.addEventListener("canplay", handleCanPlay);
    audio.addEventListener("playing", handlePlaying);
    audio.addEventListener("error", handleError);
    tryPlay();

    return () => {
      cancelled = true;
      safelyInvokeMediaMethod(audio, "pause");
      audio.removeAttribute("src");
      safelyInvokeMediaMethod(audio, "load");
      audio.removeEventListener("canplay", handleCanPlay);
      audio.removeEventListener("playing", handlePlaying);
      audio.removeEventListener("error", handleError);
    };
  }, [audioSession]);

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

      <div className="browser-stage-toolbar">
        <audio
          ref={audioRef}
          className="browser-stage-audio"
          autoPlay
          controls
          playsInline
          preload="none"
          data-testid="browser-audio"
        />
        {audioState === "blocked" ? (
          <button
            type="button"
            onClick={() => {
              const audio = audioRef.current;
              if (audio === null) {
                return;
              }

              void audio
                .play()
                .then(() => {
                  setAudioState("connected");
                })
                .catch(() => {
                  setAudioState("blocked");
                });
            }}
          >
            Enable audio
          </button>
        ) : null}
      </div>

      <div ref={shellRef} className="browser-stage-canvas-shell" data-testid="novnc-shell" />
      <span className="browser-stage-status" data-testid="monitor-state">
        {formatMonitorStateLabel(videoState, audioState, session, audioSession)}
      </span>
    </main>
  );
}

type AudioConnectionState = "connecting" | "connected" | "blocked" | "unavailable";

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
  videoState: MonitorConnectionState,
  audioState: AudioConnectionState,
  session: ComputerMonitorSession | null,
  audioSession: ComputerAudioSession | null,
) {
  if (session === null && videoState === "connecting") {
    return "loading session";
  }

  const videoLabel = formatVideoState(videoState);
  const audioLabel =
    audioSession === null && audioState === "connecting"
      ? "audio unavailable"
      : formatAudioState(audioState);

  if (session !== null) {
    return `${videoLabel} / ${audioLabel}`;
  }

  return videoLabel;
}

function formatVideoState(state: MonitorConnectionState) {
  if (state === "connected") {
    return "video connected";
  }

  if (state === "unavailable") {
    return "video unavailable";
  }

  return "video connecting";
}

function formatAudioState(state: AudioConnectionState) {
  if (state === "connected") {
    return "audio connected";
  }

  if (state === "blocked") {
    return "audio blocked by autoplay";
  }

  if (state === "unavailable") {
    return "audio unavailable";
  }

  return "audio connecting";
}

function buildAudioStreamUrl(session: ComputerAudioSession) {
  if (session.connect.mode === "websocket-url") {
    return session.connect.url;
  }

  return new URL(session.connect.url, window.location.origin).toString();
}

function safelyInvokeMediaMethod(audio: HTMLAudioElement, method: "load" | "pause") {
  try {
    audio[method]();
  } catch {
    // jsdom does not implement media methods; real browsers do.
  }
}
