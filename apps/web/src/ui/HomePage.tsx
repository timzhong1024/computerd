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
import { deleteRequest, formatError, getJson, postJson } from "../transport/http";

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
    profile: "host",
    command: "/bin/sh -i",
    workingDirectory: "",
    browser: "chromium",
    image: "ubuntu:24.04",
    vmSourceKind: "qcow2",
    baseImagePath: "/var/lib/images/ubuntu-cloud.qcow2",
    isoPath: "/var/lib/images/ubuntu.iso",
    diskSizeGiB: "32",
    cloudInitEnabled: true,
    cloudInitUser: "ubuntu",
    cloudInitPassword: "",
    cloudInitSshAuthorizedKey: "",
    vmNicMacAddress: "",
    vmIpv4Mode: "disabled",
    vmIpv4Address: "",
    vmIpv4PrefixLength: "24",
    vmIpv6Mode: "disabled",
    vmIpv6Address: "",
    vmIpv6PrefixLength: "64",
    consoleEnabled: true,
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

      if (
        selectedItem?.kind === "computer" &&
        nextComputers.some((computer) => computer.name === selectedItem.name)
      ) {
        await loadComputer(selectedItem.name);
        return;
      }

      if (
        selectedItem?.kind === "host-unit" &&
        nextHostUnits.some((hostUnit) => hostUnit.unitName === selectedItem.unitName)
      ) {
        await loadHostUnit(selectedItem.unitName);
        return;
      }

      if (nextComputers[0] !== undefined) {
        await loadComputer(nextComputers[0].name);
        return;
      }

      if (nextHostUnits[0] !== undefined) {
        await loadHostUnit(nextHostUnits[0].unitName);
        return;
      }

      setSelectedItem(null);
      setSelectedComputer(null);
      setSelectedHostUnit(null);
      setAutomationSession(null);
      setScreenshot(null);
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
        form.profile === "host"
          ? {
              name: form.name,
              profile: "host" as const,
              access: form.consoleEnabled
                ? {
                    console: {
                      mode: "pty" as const,
                      writable: true,
                    },
                    logs: true,
                  }
                : {
                    logs: true,
                  },
              runtime: {
                ...(form.command.length > 0 ? { command: form.command } : {}),
                ...(form.workingDirectory.length > 0
                  ? { workingDirectory: form.workingDirectory }
                  : {}),
              },
            }
          : form.profile === "container"
            ? {
                name: form.name,
                profile: "container" as const,
                access: form.consoleEnabled
                  ? {
                      console: {
                        mode: "pty" as const,
                        writable: true,
                      },
                      logs: true,
                    }
                  : {
                      logs: true,
                    },
                runtime: {
                  provider: "docker" as const,
                  image: form.image,
                  ...(form.command.length > 0 ? { command: form.command } : {}),
                  ...(form.workingDirectory.length > 0
                    ? { workingDirectory: form.workingDirectory }
                    : {}),
                },
              }
            : form.profile === "browser"
              ? {
                  name: form.name,
                  profile: "browser" as const,
                  runtime: {
                    browser: form.browser as "chromium",
                    persistentProfile: true,
                  },
                }
              : {
                  name: form.name,
                  profile: "vm" as const,
                  access: {
                    ...(form.consoleEnabled
                      ? {
                          console: {
                            mode: "pty" as const,
                            writable: true,
                          },
                        }
                      : {}),
                    display: {
                      mode: "vnc" as const,
                    },
                    logs: true,
                  },
                  runtime: {
                    hypervisor: "qemu" as const,
                    nics: [
                      {
                        name: "primary",
                        ...(form.vmNicMacAddress.trim().length > 0
                          ? { macAddress: form.vmNicMacAddress.trim() }
                          : {}),
                        ipv4:
                          form.vmIpv4Mode === "static"
                            ? {
                                type: "static" as const,
                                address: form.vmIpv4Address.trim(),
                                prefixLength: Number(form.vmIpv4PrefixLength),
                              }
                            : { type: form.vmIpv4Mode as "disabled" | "dhcp" },
                        ipv6:
                          form.vmIpv6Mode === "static"
                            ? {
                                type: "static" as const,
                                address: form.vmIpv6Address.trim(),
                                prefixLength: Number(form.vmIpv6PrefixLength),
                              }
                            : {
                                type: form.vmIpv6Mode as "disabled" | "dhcp" | "slaac",
                              },
                      },
                    ],
                    source:
                      form.vmSourceKind === "qcow2"
                        ? {
                            kind: "qcow2" as const,
                            baseImagePath: form.baseImagePath,
                            cloudInit: form.cloudInitEnabled
                              ? {
                                  user: form.cloudInitUser,
                                  ...(form.cloudInitPassword.length > 0
                                    ? { password: form.cloudInitPassword }
                                    : {}),
                                  ...(form.cloudInitSshAuthorizedKey.length > 0
                                    ? {
                                        sshAuthorizedKeys: [form.cloudInitSshAuthorizedKey],
                                      }
                                    : {}),
                                }
                              : {
                                  enabled: false as const,
                                },
                          }
                        : {
                            kind: "iso" as const,
                            isoPath: form.isoPath,
                            ...(form.diskSizeGiB.length > 0
                              ? { diskSizeGiB: Number(form.diskSizeGiB) }
                              : {}),
                          },
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

  async function handleDeleteComputer() {
    if (selectedComputer === null) {
      return;
    }

    setIsBusy(true);
    setError(null);

    try {
      await deleteRequest(`/api/computers/${encodeURIComponent(selectedComputer.name)}`);
      setSelectedItem(null);
      setSelectedComputer(null);
      setSelectedHostUnit(null);
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

  function handleOpenMonitorWindow() {
    if (
      selectedComputer === null ||
      (selectedComputer.profile !== "browser" && selectedComputer.profile !== "vm")
    ) {
      return;
    }

    const viewport =
      selectedComputer.profile === "browser"
        ? selectedComputer.runtime.display.viewport
        : selectedComputer.runtime.displayViewport;
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

    const popup = window.open(url, `computerd-monitor-${selectedComputer.name}`, features);
    if (popup === null) {
      window.location.assign(url);
      return;
    }

    popup.focus();
  }

  const isSelectedComputerBroken = selectedComputer?.state === "broken";

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
                placeholder="lab-host"
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
                <option value="host">host</option>
                <option value="browser">browser</option>
                <option value="container">container</option>
                <option value="vm">vm</option>
              </select>
            </label>

            <label>
              Console
              <input
                name="consoleEnabled"
                type="checkbox"
                checked={form.consoleEnabled}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    consoleEnabled: event.target.checked,
                  }))
                }
              />
            </label>

            {form.profile === "host" ? (
              <>
                <label>
                  Command
                  <input
                    name="command"
                    value={form.command}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, command: event.target.value }))
                    }
                    required={!form.consoleEnabled}
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
            ) : form.profile === "container" ? (
              <>
                <label>
                  Image
                  <input
                    name="image"
                    value={form.image}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, image: event.target.value }))
                    }
                    required
                  />
                </label>
                <label>
                  Command
                  <input
                    name="command"
                    value={form.command}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, command: event.target.value }))
                    }
                    required={!form.consoleEnabled}
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
            ) : form.profile === "browser" ? (
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
            ) : (
              <>
                <label>
                  Source
                  <select
                    name="vmSourceKind"
                    value={form.vmSourceKind}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, vmSourceKind: event.target.value }))
                    }
                  >
                    <option value="qcow2">qcow2</option>
                    <option value="iso">iso</option>
                  </select>
                </label>
                {form.vmSourceKind === "qcow2" ? (
                  <>
                    <label>
                      Base qcow2 image
                      <input
                        name="baseImagePath"
                        value={form.baseImagePath}
                        onChange={(event) =>
                          setForm((current) => ({ ...current, baseImagePath: event.target.value }))
                        }
                        required
                      />
                    </label>
                    <label>
                      Cloud-init enabled
                      <input
                        name="cloudInitEnabled"
                        type="checkbox"
                        checked={form.cloudInitEnabled}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            cloudInitEnabled: event.target.checked,
                          }))
                        }
                      />
                    </label>
                    <label>
                      Cloud-init user
                      <input
                        name="cloudInitUser"
                        value={form.cloudInitUser}
                        onChange={(event) =>
                          setForm((current) => ({ ...current, cloudInitUser: event.target.value }))
                        }
                        required={form.cloudInitEnabled}
                        disabled={!form.cloudInitEnabled}
                      />
                    </label>
                    <label>
                      Cloud-init password
                      <input
                        name="cloudInitPassword"
                        value={form.cloudInitPassword}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            cloudInitPassword: event.target.value,
                          }))
                        }
                        placeholder="optional"
                        disabled={!form.cloudInitEnabled}
                      />
                    </label>
                    <label>
                      SSH authorized key
                      <input
                        name="cloudInitSshAuthorizedKey"
                        value={form.cloudInitSshAuthorizedKey}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            cloudInitSshAuthorizedKey: event.target.value,
                          }))
                        }
                        placeholder="ssh-ed25519 AAAA..."
                        disabled={!form.cloudInitEnabled}
                      />
                    </label>
                    <label>
                      Primary NIC MAC
                      <input
                        name="vmNicMacAddress"
                        value={form.vmNicMacAddress}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            vmNicMacAddress: event.target.value,
                          }))
                        }
                        placeholder="auto-generated"
                      />
                    </label>
                    <label>
                      IPv4 mode
                      <select
                        name="vmIpv4Mode"
                        value={form.vmIpv4Mode}
                        onChange={(event) =>
                          setForm((current) => ({ ...current, vmIpv4Mode: event.target.value }))
                        }
                      >
                        <option value="disabled">disabled</option>
                        <option value="dhcp">dhcp</option>
                        <option value="static">static</option>
                      </select>
                    </label>
                    <label>
                      IPv4 address
                      <input
                        name="vmIpv4Address"
                        value={form.vmIpv4Address}
                        onChange={(event) =>
                          setForm((current) => ({ ...current, vmIpv4Address: event.target.value }))
                        }
                        placeholder="192.168.250.10"
                        disabled={form.vmIpv4Mode !== "static"}
                      />
                    </label>
                    <label>
                      IPv4 prefix
                      <input
                        name="vmIpv4PrefixLength"
                        type="number"
                        min="1"
                        max="32"
                        value={form.vmIpv4PrefixLength}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            vmIpv4PrefixLength: event.target.value,
                          }))
                        }
                        disabled={form.vmIpv4Mode !== "static"}
                      />
                    </label>
                    <label>
                      IPv6 mode
                      <select
                        name="vmIpv6Mode"
                        value={form.vmIpv6Mode}
                        onChange={(event) =>
                          setForm((current) => ({ ...current, vmIpv6Mode: event.target.value }))
                        }
                      >
                        <option value="disabled">disabled</option>
                        <option value="dhcp">dhcp</option>
                        <option value="slaac">slaac</option>
                        <option value="static">static</option>
                      </select>
                    </label>
                    <label>
                      IPv6 address
                      <input
                        name="vmIpv6Address"
                        value={form.vmIpv6Address}
                        onChange={(event) =>
                          setForm((current) => ({ ...current, vmIpv6Address: event.target.value }))
                        }
                        placeholder="fd00::10"
                        disabled={form.vmIpv6Mode !== "static"}
                      />
                    </label>
                    <label>
                      IPv6 prefix
                      <input
                        name="vmIpv6PrefixLength"
                        type="number"
                        min="1"
                        max="128"
                        value={form.vmIpv6PrefixLength}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            vmIpv6PrefixLength: event.target.value,
                          }))
                        }
                        disabled={form.vmIpv6Mode !== "static"}
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label>
                      Install ISO
                      <input
                        name="isoPath"
                        value={form.isoPath}
                        onChange={(event) =>
                          setForm((current) => ({ ...current, isoPath: event.target.value }))
                        }
                        required
                      />
                    </label>
                    <label>
                      Disk size (GiB)
                      <input
                        name="diskSizeGiB"
                        type="number"
                        min="1"
                        value={form.diskSizeGiB}
                        onChange={(event) =>
                          setForm((current) => ({ ...current, diskSizeGiB: event.target.value }))
                        }
                      />
                    </label>
                  </>
                )}
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
                {!isSelectedComputerBroken ? (
                  <button
                    type="button"
                    data-testid="computer-action-delete"
                    disabled={isBusy}
                    onClick={() => void handleDeleteComputer()}
                  >
                    Delete
                  </button>
                ) : null}
              </div>
            </div>
            <div className="surface-actions">
              {!isSelectedComputerBroken &&
              (selectedComputer.access.display?.mode === "virtual-display" ||
                selectedComputer.access.display?.mode === "vnc") ? (
                <button
                  type="button"
                  className="surface-link"
                  data-testid="open-monitor-link"
                  disabled={selectedComputer.state !== "running"}
                  onClick={handleOpenMonitorWindow}
                >
                  Open monitor
                </button>
              ) : null}
              {!isSelectedComputerBroken && selectedComputer.access.console?.mode === "pty" ? (
                <Link
                  className="surface-link surface-link-secondary"
                  data-testid="open-console-link"
                  to="/computers/$name/console"
                  params={{ name: selectedComputer.name }}
                >
                  Open console
                </Link>
              ) : null}
              {!isSelectedComputerBroken && selectedComputer.profile === "container" ? (
                <Link
                  className="surface-link surface-link-secondary"
                  data-testid="open-exec-link"
                  to="/computers/$name/exec"
                  params={{ name: selectedComputer.name }}
                >
                  Exec shell
                </Link>
              ) : null}
              {!isSelectedComputerBroken && selectedComputer.profile === "browser" ? (
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
              {!isSelectedComputerBroken && selectedComputer.profile === "browser" ? (
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
                  {selectedComputer.profile === "host"
                    ? (selectedComputer.runtime.command ?? "[default shell]")
                    : selectedComputer.profile === "container"
                      ? `${selectedComputer.runtime.provider} · ${selectedComputer.runtime.image}`
                      : selectedComputer.profile === "vm"
                        ? `${selectedComputer.runtime.hypervisor} · ${selectedComputer.runtime.source.kind}`
                        : `${selectedComputer.runtime.browser} · profile ${selectedComputer.runtime.persistentProfile ? "persistent" : "ephemeral"}`}
                </dd>
              </div>
              {selectedComputer.profile === "container" ? (
                <>
                  <div>
                    <dt>Container id</dt>
                    <dd>{selectedComputer.runtime.containerId}</dd>
                  </div>
                  <div>
                    <dt>Container name</dt>
                    <dd>{selectedComputer.runtime.containerName}</dd>
                  </div>
                </>
              ) : null}
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
              {selectedComputer.profile === "vm" ? (
                <>
                  <div>
                    <dt>Disk image</dt>
                    <dd>{selectedComputer.runtime.diskImagePath}</dd>
                  </div>
                  <div>
                    <dt>Bridge</dt>
                    <dd>{selectedComputer.runtime.bridge}</dd>
                  </div>
                  <div>
                    <dt>Network mode</dt>
                    <dd>{selectedComputer.network.mode}</dd>
                  </div>
                  <div>
                    <dt>Cloud-init</dt>
                    <dd>
                      {selectedComputer.runtime.source.kind === "qcow2" &&
                      selectedComputer.runtime.source.cloudInit.enabled === false
                        ? "disabled"
                        : "enabled"}
                    </dd>
                  </div>
                  {selectedComputer.runtime.nics[0] ? (
                    <div>
                      <dt>Primary NIC</dt>
                      <dd>
                        {selectedComputer.runtime.nics[0].name} ·{" "}
                        {selectedComputer.runtime.nics[0].macAddress} · auto apply{" "}
                        {selectedComputer.runtime.nics[0].ipConfigApplied ? "yes" : "no"}
                        {selectedComputer.runtime.nics[0].ipv4 ? (
                          <>
                            {" "}
                            · IPv4{" "}
                            {selectedComputer.runtime.nics[0].ipv4.type === "static"
                              ? `${selectedComputer.runtime.nics[0].ipv4.address}/${selectedComputer.runtime.nics[0].ipv4.prefixLength}`
                              : selectedComputer.runtime.nics[0].ipv4.type}
                          </>
                        ) : null}
                        {selectedComputer.runtime.nics[0].ipv6 ? (
                          <>
                            {" "}
                            · IPv6{" "}
                            {selectedComputer.runtime.nics[0].ipv6.type === "static"
                              ? `${selectedComputer.runtime.nics[0].ipv6.address}/${selectedComputer.runtime.nics[0].ipv6.prefixLength}`
                              : selectedComputer.runtime.nics[0].ipv6.type}
                          </>
                        ) : null}
                      </dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>VNC</dt>
                    <dd>
                      display {selectedComputer.runtime.vncDisplay} · port{" "}
                      {selectedComputer.runtime.vncPort}
                    </dd>
                  </div>
                  <div>
                    <dt>Serial socket</dt>
                    <dd>{selectedComputer.runtime.serialSocketPath}</dd>
                  </div>
                  <div>
                    <dt>Machine</dt>
                    <dd>{selectedComputer.runtime.machine}</dd>
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
