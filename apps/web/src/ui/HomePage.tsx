import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import {
  parseComputerDetail,
  parseComputerSummaries,
  parseHostUnitDetail,
  parseHostUnitSummaries,
  type ComputerAutomationSession,
  type ComputerDetail,
  type ComputerScreenshot,
  type ComputerSummary,
  type HostUnitDetail,
  type HostUnitSummary,
} from "@computerd/core";
import { createAutomationSession, createScreenshot } from "../transport/computer-sessions";
import { formatError, getJson, postJson } from "../transport/http";

type SelectedItem =
  | {
      kind: "computer";
      name: string;
    }
  | {
      kind: "host-unit";
      unitName: string;
    };

export function HomePage() {
  const [computers, setComputers] = useState<ComputerSummary[]>([]);
  const [hostUnits, setHostUnits] = useState<HostUnitSummary[]>([]);
  const [selectedItem, setSelectedItem] = useState<SelectedItem | null>(null);
  const [selectedComputer, setSelectedComputer] = useState<ComputerDetail | null>(null);
  const [selectedHostUnit, setSelectedHostUnit] = useState<HostUnitDetail | null>(null);
  const [automationSession, setAutomationSession] = useState<ComputerAutomationSession | null>(
    null,
  );
  const [screenshot, setScreenshot] = useState<ComputerScreenshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [form, setForm] = useState({
    name: "",
    profile: "terminal",
    execStart: "/usr/bin/bash -i -l",
    workingDirectory: "",
    browser: "chromium",
  });

  useEffect(() => {
    void refreshInventory();
  }, []);

  async function refreshInventory() {
    try {
      const [nextComputers, nextHostUnits] = await Promise.all([
        getJson("/api/computers", parseComputerSummaries),
        getJson("/api/host-units", parseHostUnitSummaries),
      ]);

      setComputers(nextComputers);
      setHostUnits(nextHostUnits);

      if (selectedItem?.kind === "computer") {
        await loadComputer(selectedItem.name);
        return;
      }

      if (selectedItem?.kind === "host-unit") {
        await loadHostUnit(selectedItem.unitName);
        return;
      }

      if (nextComputers[0] !== undefined) {
        await loadComputer(nextComputers[0].name);
        return;
      }

      if (nextHostUnits[0] !== undefined) {
        await loadHostUnit(nextHostUnits[0].unitName);
      }
    } catch (caughtError) {
      setError(formatError(caughtError));
    }
  }

  async function loadComputer(name: string) {
    const detail = await getJson(`/api/computers/${encodeURIComponent(name)}`, parseComputerDetail);
    setSelectedItem({
      kind: "computer",
      name,
    });
    setSelectedComputer(detail);
    setSelectedHostUnit(null);
    setAutomationSession(null);
    setScreenshot(null);
  }

  async function loadHostUnit(unitName: string) {
    const detail = await getJson(
      `/api/host-units/${encodeURIComponent(unitName)}`,
      parseHostUnitDetail,
    );
    setSelectedItem({
      kind: "host-unit",
      unitName,
    });
    setSelectedHostUnit(detail);
    setSelectedComputer(null);
    setAutomationSession(null);
    setScreenshot(null);
  }

  async function handleCreateComputer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsBusy(true);
    setError(null);

    try {
      const payload =
        form.profile === "terminal"
          ? {
              name: form.name,
              profile: "terminal" as const,
              runtime: {
                execStart: form.execStart,
                ...(form.workingDirectory.length > 0
                  ? { workingDirectory: form.workingDirectory }
                  : {}),
              },
            }
          : {
              name: form.name,
              profile: "browser" as const,
              runtime: {
                browser: form.browser as "chromium",
                persistentProfile: true,
              },
            };

      const detail = await postJson("/api/computers", payload, parseComputerDetail);
      setForm((current) => ({
        ...current,
        name: "",
      }));
      await refreshInventory();
      setSelectedItem({
        kind: "computer",
        name: detail.name,
      });
      setSelectedComputer(detail);
      setSelectedHostUnit(null);
      setAutomationSession(null);
      setScreenshot(null);
    } catch (caughtError) {
      setError(formatError(caughtError));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleComputerAction(action: "start" | "stop" | "restart") {
    if (selectedComputer === null) {
      return;
    }

    setIsBusy(true);
    setError(null);

    try {
      const detail = await postJson(
        `/api/computers/${encodeURIComponent(selectedComputer.name)}/${action}`,
        undefined,
        parseComputerDetail,
      );
      setSelectedComputer(detail);
      setAutomationSession(null);
      setScreenshot(null);
      await refreshInventory();
    } catch (caughtError) {
      setError(formatError(caughtError));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleCreateAutomationSession() {
    if (selectedComputer === null || selectedComputer.profile !== "browser") {
      return;
    }

    setIsBusy(true);
    setError(null);

    try {
      setAutomationSession(await createAutomationSession(selectedComputer.name));
    } catch (caughtError) {
      setError(formatError(caughtError));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleCaptureScreenshot() {
    if (selectedComputer === null || selectedComputer.profile !== "browser") {
      return;
    }

    setIsBusy(true);
    setError(null);

    try {
      setScreenshot(await createScreenshot(selectedComputer.name));
    } catch (caughtError) {
      setError(formatError(caughtError));
    } finally {
      setIsBusy(false);
    }
  }

  function handleOpenBrowserWindow() {
    if (selectedComputer === null || selectedComputer.profile !== "browser") {
      return;
    }

    const viewport = selectedComputer.runtime.display.viewport;
    const chromeWidth = 32;
    const chromeHeight = 96;
    const fullWidth = viewport.width + chromeWidth;
    const fullHeight = viewport.height + chromeHeight;
    const availableWidth = window.screen.availWidth || window.screen.width || 0;
    const availableHeight = window.screen.availHeight || window.screen.height || 0;
    const needsFallback =
      availableWidth > 0 &&
      availableHeight > 0 &&
      (fullWidth > availableWidth || fullHeight > availableHeight);
    const width = needsFallback ? Math.round(viewport.width / 2) + chromeWidth : fullWidth;
    const height = needsFallback ? Math.round(viewport.height / 2) + chromeHeight : fullHeight;
    const left = Math.max(Math.round(((availableWidth || width) - width) / 2), 0);
    const top = Math.max(Math.round(((availableHeight || height) - height) / 2), 0);
    const url = `/computers/${encodeURIComponent(selectedComputer.name)}/monitor`;
    const features = [
      "popup=yes",
      "toolbar=no",
      "location=no",
      "status=no",
      "menubar=no",
      "scrollbars=yes",
      "resizable=yes",
      `width=${width}`,
      `height=${height}`,
      `left=${left}`,
      `top=${top}`,
    ].join(",");

    const popup = window.open(url, `computerd-browser-${selectedComputer.name}`, features);
    if (popup === null) {
      window.location.assign(url);
      return;
    }

    popup.focus();
  }

  return (
    <main className="app-shell">
      <section className="hero">
        <p className="eyebrow">Computerd</p>
        <h1>A computer control plane for homelab and agent workflows.</h1>
        <p className="lede">
          Managed computers stay front and center. Host systemd units remain visible as a
          lightweight inspect surface, not as the primary product model.
        </p>
      </section>

      {error ? (
        <div className="alert" role="alert">
          {error}
        </div>
      ) : null}

      <section className="layout-grid">
        <div className="panel">
          <h2>Create computer</h2>
          <form className="create-form" onSubmit={handleCreateComputer}>
            <label>
              Name
              <input
                name="name"
                value={form.name}
                onChange={(event) =>
                  setForm((current) => ({ ...current, name: event.target.value }))
                }
                placeholder="lab-terminal"
                required
              />
            </label>

            <label>
              Profile
              <select
                name="profile"
                value={form.profile}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    profile: event.target.value,
                  }))
                }
              >
                <option value="terminal">terminal</option>
                <option value="browser">browser</option>
              </select>
            </label>

            {form.profile === "terminal" ? (
              <>
                <label>
                  ExecStart
                  <input
                    name="execStart"
                    value={form.execStart}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, execStart: event.target.value }))
                    }
                    required
                  />
                </label>
                <label>
                  Working directory
                  <input
                    name="workingDirectory"
                    value={form.workingDirectory}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        workingDirectory: event.target.value,
                      }))
                    }
                    placeholder="/workspace"
                  />
                </label>
              </>
            ) : (
              <>
                <label>
                  Browser
                  <select
                    name="browser"
                    value={form.browser}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, browser: event.target.value }))
                    }
                  >
                    <option value="chromium">chromium</option>
                  </select>
                </label>
              </>
            )}

            <button type="submit" disabled={isBusy}>
              Create computer
            </button>
          </form>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2>Managed computers</h2>
            <button type="button" onClick={() => void refreshInventory()} disabled={isBusy}>
              Refresh
            </button>
          </div>
          <ul className="item-list">
            {computers.map((computer) => (
              <li key={computer.name}>
                <button
                  type="button"
                  className="item-button"
                  onClick={() => void loadComputer(computer.name)}
                >
                  <span>{computer.name}</span>
                  <span className="meta">
                    {computer.profile} · {computer.state}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="panel">
          <h2>Host inspect</h2>
          <div className="scroll-list">
            <ul className="item-list">
              {hostUnits.map((unit) => (
                <li key={unit.unitName}>
                  <button
                    type="button"
                    className="item-button"
                    onClick={() => void loadHostUnit(unit.unitName)}
                  >
                    <span>{unit.unitName}</span>
                    <span className="meta">{unit.state}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="detail-panel">
        {selectedComputer ? (
          <>
            <div className="panel-header">
              <div>
                <p className="eyebrow">Computer detail</p>
                <h2>{selectedComputer.name}</h2>
              </div>
              <div className="actions">
                <button
                  type="button"
                  data-testid="computer-action-start"
                  disabled={!selectedComputer.capabilities.canStart || isBusy}
                  onClick={() => void handleComputerAction("start")}
                >
                  Start
                </button>
                <button
                  type="button"
                  data-testid="computer-action-stop"
                  disabled={!selectedComputer.capabilities.canStop || isBusy}
                  onClick={() => void handleComputerAction("stop")}
                >
                  Stop
                </button>
                <button
                  type="button"
                  data-testid="computer-action-restart"
                  disabled={!selectedComputer.capabilities.canRestart || isBusy}
                  onClick={() => void handleComputerAction("restart")}
                >
                  Restart
                </button>
              </div>
            </div>
            <div className="surface-actions">
              {selectedComputer.access.display?.mode === "virtual-display" ? (
                <button
                  type="button"
                  className="surface-link"
                  data-testid="open-monitor-link"
                  disabled={!selectedComputer.capabilities.browserAvailable}
                  onClick={handleOpenBrowserWindow}
                >
                  Open browser
                </button>
              ) : null}
              {selectedComputer.access.console?.mode === "pty" ? (
                <Link
                  className="surface-link surface-link-secondary"
                  data-testid="open-console-link"
                  to="/computers/$name/console"
                  params={{ name: selectedComputer.name }}
                >
                  Open console
                </Link>
              ) : null}
              {selectedComputer.profile === "browser" ? (
                <button
                  type="button"
                  className="surface-link surface-link-secondary"
                  data-testid="create-automation-session"
                  disabled={!selectedComputer.capabilities.automationAvailable || isBusy}
                  onClick={() => void handleCreateAutomationSession()}
                >
                  Create automation session
                </button>
              ) : null}
              {selectedComputer.profile === "browser" ? (
                <button
                  type="button"
                  className="surface-link surface-link-secondary"
                  data-testid="capture-screenshot"
                  disabled={!selectedComputer.capabilities.screenshotAvailable || isBusy}
                  onClick={() => void handleCaptureScreenshot()}
                >
                  Capture screenshot
                </button>
              ) : null}
            </div>
            <dl className="detail-grid">
              <div>
                <dt>Profile</dt>
                <dd>{selectedComputer.profile}</dd>
              </div>
              <div>
                <dt>State</dt>
                <dd data-testid="computer-state">{selectedComputer.state}</dd>
              </div>
              <div>
                <dt>Primary unit</dt>
                <dd>{selectedComputer.status.primaryUnit}</dd>
              </div>
              <div>
                <dt>Network</dt>
                <dd>{selectedComputer.network.mode}</dd>
              </div>
              <div>
                <dt>Storage</dt>
                <dd>{selectedComputer.storage.rootMode}</dd>
              </div>
              <div>
                <dt>Runtime</dt>
                <dd>
                  {selectedComputer.profile === "terminal"
                    ? selectedComputer.runtime.execStart
                    : `${selectedComputer.runtime.browser} · profile ${selectedComputer.runtime.persistentProfile ? "persistent" : "ephemeral"}`}
                </dd>
              </div>
              {selectedComputer.profile === "browser" ? (
                <>
                  <div>
                    <dt>Profile directory</dt>
                    <dd>{selectedComputer.runtime.profileDirectory}</dd>
                  </div>
                  <div>
                    <dt>Automation</dt>
                    <dd>{selectedComputer.runtime.automation.protocol}</dd>
                  </div>
                  <div>
                    <dt>Screenshot</dt>
                    <dd>{selectedComputer.runtime.screenshot.format}</dd>
                  </div>
                </>
              ) : null}
            </dl>
            {selectedComputer.profile === "browser" && automationSession ? (
              <section className="panel">
                <div className="panel-header">
                  <h3>Automation session</h3>
                  <span className="status-pill status-connected">ready</span>
                </div>
                <dl className="detail-grid session-grid">
                  <div>
                    <dt>Protocol</dt>
                    <dd>{automationSession.protocol}</dd>
                  </div>
                  <div>
                    <dt>Connect target</dt>
                    <dd data-testid="automation-connect-url">{automationSession.connect.url}</dd>
                  </div>
                  <div>
                    <dt>Authorization</dt>
                    <dd>{automationSession.authorization.mode}</dd>
                  </div>
                </dl>
              </section>
            ) : null}
            {selectedComputer.profile === "browser" && screenshot ? (
              <section className="panel">
                <div className="panel-header">
                  <h3>Screenshot</h3>
                  <span className="status-pill status-connected">captured</span>
                </div>
                <p className="monitor-copy">
                  Captured at {new Date(screenshot.capturedAt).toLocaleString()}.
                </p>
                <img
                  alt={`${selectedComputer.name} screenshot`}
                  data-testid="browser-screenshot-preview"
                  className="novnc-shell"
                  src={`data:${screenshot.mimeType};base64,${screenshot.dataBase64}`}
                />
              </section>
            ) : null}
          </>
        ) : null}

        {selectedHostUnit ? (
          <>
            <p className="eyebrow">Host unit detail</p>
            <h2>{selectedHostUnit.unitName}</h2>
            <dl className="detail-grid">
              <div>
                <dt>State</dt>
                <dd>{selectedHostUnit.state}</dd>
              </div>
              <div>
                <dt>ExecStart</dt>
                <dd>{selectedHostUnit.execStart}</dd>
              </div>
              <div>
                <dt>Recent logs</dt>
                <dd>{selectedHostUnit.recentLogs.join(" | ")}</dd>
              </div>
            </dl>
          </>
        ) : null}
      </section>
    </main>
  );
}
