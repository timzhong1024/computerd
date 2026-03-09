import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import {
  parseComputerDetail,
  parseComputerSummaries,
  parseHostUnitDetail,
  parseHostUnitSummaries,
  type ComputerDetail,
  type ComputerSummary,
  type HostUnitDetail,
  type HostUnitSummary,
} from "@computerd/core";
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
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [form, setForm] = useState({
    name: "",
    profile: "terminal",
    execStart: "/usr/bin/bash -lc 'echo ready && sleep infinity'",
    workingDirectory: "",
    browser: "chromium",
    startUrl: "https://example.com",
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
                browser: form.browser as "chromium" | "chrome" | "firefox",
                persistentProfile: true,
                startUrl: form.startUrl,
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
      await refreshInventory();
    } catch (caughtError) {
      setError(formatError(caughtError));
    } finally {
      setIsBusy(false);
    }
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
                    <option value="chrome">chrome</option>
                    <option value="firefox">firefox</option>
                  </select>
                </label>
                <label>
                  Start URL
                  <input
                    name="startUrl"
                    value={form.startUrl}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, startUrl: event.target.value }))
                    }
                    required
                  />
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
                <Link
                  className="surface-link"
                  data-testid="open-monitor-link"
                  to="/computers/$name/monitor"
                  params={{ name: selectedComputer.name }}
                >
                  Open monitor
                </Link>
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
                    : `${selectedComputer.runtime.browser} -> ${selectedComputer.runtime.startUrl ?? "about:blank"}`}
                </dd>
              </div>
            </dl>
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
