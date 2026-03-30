from __future__ import annotations

import json
import os
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Union
from .computer_13 import Computer13Translation, translate_computer_13_action

try:
    from desktop_env.providers.base import Provider, VMManager
except ImportError:  # pragma: no cover - used only when OSWorld is not installed locally.
    class Provider:  # type: ignore[override]
        pass

    class VMManager:  # type: ignore[override]
        pass


@dataclass(frozen=True)
class Locator:
    computer_name: str
    raw: str


class LocatorError(ValueError):
    pass


class ComputerdHttpError(RuntimeError):
    def __init__(self, status: int, reason: str, payload: Any):
        message = payload["error"] if isinstance(payload, dict) and "error" in payload else reason
        super().__init__(f"computerd request failed ({status} {reason}): {message}")
        self.status = status
        self.reason = reason
        self.payload = payload


def parse_locator(path_to_vm: str) -> Locator:
    parsed = urllib.parse.urlparse(path_to_vm)
    if parsed.scheme != "computerd":
        raise LocatorError(
            f'Expected locator scheme "computerd", got "{parsed.scheme or "missing"}".'
        )
    if parsed.netloc != "computer":
        raise LocatorError(f'Expected locator host "computer", got "{parsed.netloc or "missing"}".')

    computer_name = parsed.path.lstrip("/")
    if not computer_name:
        raise LocatorError("Expected a computer name in the locator path.")

    return Locator(computer_name=computer_name, raw=path_to_vm)


class ComputerdProvider(Provider):
    def __init__(
        self,
        region: Optional[str] = None,
        base_url: str = "http://127.0.0.1:3000",
        poll_interval: float = 1.0,
        ready_timeout: float = 60.0,
        guest_ready_command: str = "echo ready",
    ):
        self.region = region
        self.base_url = base_url.rstrip("/")
        self.poll_interval = poll_interval
        self.ready_timeout = ready_timeout
        self.guest_ready_command = guest_ready_command

    def start_emulator(self, path_to_vm: str, *args: Any, **kwargs: Any) -> str:
        del args, kwargs
        locator = parse_locator(path_to_vm)
        detail = self._get_computer(locator.computer_name)
        if detail.get("state") != "running":
            detail = self._request_json("POST", f"/api/computers/{self._quote(locator.computer_name)}/start")
        self._wait_for_running(locator.computer_name)
        self._wait_for_guest_tools(locator.computer_name)
        return locator.raw

    def get_ip_address(self, path_to_vm: str, *args: Any, **kwargs: Any) -> str:
        del args, kwargs
        locator = parse_locator(path_to_vm)
        result = self._request_json(
            "POST",
            f"/api/computers/{self._quote(locator.computer_name)}/guest-command",
            {
                "command": "hostname -I | awk '{print $1}'",
                "shell": True,
                "captureOutput": True,
                "timeoutMs": 15000,
            },
        )
        stdout = result.get("stdout", "")
        for token in stdout.split():
            if token:
                return token
        raise RuntimeError(f'Computer "{locator.computer_name}" did not report an IP address.')

    def save_state(
        self,
        path_to_vm: str,
        snapshot_name: Optional[str] = None,
        *args: Any,
        **kwargs: Any,
    ) -> str:
        del args, kwargs
        locator = parse_locator(path_to_vm)
        name = snapshot_name or "osworld"
        self._request_json(
            "POST",
            f"/api/computers/{self._quote(locator.computer_name)}/snapshots",
            {"name": name},
        )
        return locator.raw

    def revert_to_snapshot(
        self,
        path_to_vm: str,
        snapshot_name: Optional[str] = None,
        *args: Any,
        **kwargs: Any,
    ) -> str:
        del args, kwargs
        locator = parse_locator(path_to_vm)
        payload: Dict[str, Any]
        if snapshot_name is None or snapshot_name == "initial":
            payload = {"target": "initial"}
        else:
            payload = {"target": "snapshot", "snapshotName": snapshot_name}
        self._request_json(
            "POST",
            f"/api/computers/{self._quote(locator.computer_name)}/restore",
            payload,
        )
        self._wait_for_guest_tools(locator.computer_name)
        return locator.raw

    def stop_emulator(self, path_to_vm: str, *args: Any, **kwargs: Any) -> str:
        del args, kwargs
        locator = parse_locator(path_to_vm)
        self._request_json("POST", f"/api/computers/{self._quote(locator.computer_name)}/stop")
        return locator.raw

    def translate_computer_13_action(self, action: Dict[str, Any]) -> Computer13Translation:
        return translate_computer_13_action(action)

    def execute_computer_13_action(
        self,
        path_to_vm: str,
        action: Dict[str, Any],
        screenshot: bool = True,
    ) -> Dict[str, Any]:
        locator = parse_locator(path_to_vm)
        translated = translate_computer_13_action(action)
        if translated.kind != "display":
            return {
                "computerName": locator.computer_name,
                "status": translated.status,
                "message": translated.message,
            }

        return self._request_json(
            "POST",
            f"/api/computers/{self._quote(locator.computer_name)}/display-actions",
            {
                "computerName": locator.computer_name,
                "ops": translated.ops,
                "observe": {
                    "screenshot": screenshot,
                },
            },
        )

    def _wait_for_running(self, computer_name: str) -> None:
        deadline = time.monotonic() + self.ready_timeout
        while time.monotonic() < deadline:
            detail = self._get_computer(computer_name)
            if detail.get("state") == "running":
                return
            time.sleep(self.poll_interval)
        raise TimeoutError(f'Computer "{computer_name}" did not reach running state in time.')

    def _wait_for_guest_tools(self, computer_name: str) -> None:
        deadline = time.monotonic() + self.ready_timeout
        while time.monotonic() < deadline:
            try:
                result = self._request_json(
                    "POST",
                    f"/api/computers/{self._quote(computer_name)}/guest-command",
                    {
                        "command": self.guest_ready_command,
                        "shell": True,
                        "captureOutput": True,
                        "timeoutMs": 5000,
                    },
                )
                if result.get("timedOut") is False and result.get("exitCode") == 0:
                    return
            except ComputerdHttpError as error:
                if error.status not in (404, 409):
                    raise
            time.sleep(self.poll_interval)
        raise TimeoutError(f'Computer "{computer_name}" guest tools did not become ready in time.')

    def _get_computer(self, computer_name: str) -> Dict[str, Any]:
        return self._request_json("GET", f"/api/computers/{self._quote(computer_name)}")

    def _request_json(
        self,
        method: str,
        path: str,
        payload: Optional[Dict[str, Any]] = None,
    ) -> Any:
        data = None
        headers = {"Accept": "application/json"}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request) as response:
                body = response.read().decode("utf-8")
                return json.loads(body) if body else None
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8")
            payload_body: Any
            try:
                payload_body = json.loads(body) if body else None
            except json.JSONDecodeError:
                payload_body = body
            raise ComputerdHttpError(error.code, error.reason, payload_body) from error

    @staticmethod
    def _quote(value: str) -> str:
        return urllib.parse.quote(value, safe="")


class ComputerdVMManager(VMManager):
    def __init__(self, registry_path: Optional[Union[str, os.PathLike[str]]] = None):
        self.registry_path = Path(
            registry_path
            if registry_path is not None
            else Path(tempfile.gettempdir()) / "computerd-osworld-provider-registry.json"
        )

    def initialize_registry(self, locators: Optional[List[str]] = None) -> List[str]:
        state = self._load_state()
        for locator in locators or []:
            parsed = parse_locator(locator)
            state.setdefault(parsed.raw, {"occupied_by": None})
        self._save_state(state)
        return sorted(state)

    def add_vm(self, path_to_vm: str) -> str:
        locator = parse_locator(path_to_vm)
        state = self._load_state()
        state.setdefault(locator.raw, {"occupied_by": None})
        self._save_state(state)
        return locator.raw

    def delete_vm(self, path_to_vm: str) -> None:
        locator = parse_locator(path_to_vm)
        state = self._load_state()
        state.pop(locator.raw, None)
        self._save_state(state)

    def occupy_vm(self, path_to_vm: str, owner_pid: Optional[int] = None) -> str:
        locator = parse_locator(path_to_vm)
        state = self._load_state()
        entry = state.setdefault(locator.raw, {"occupied_by": None})
        occupied_by = entry.get("occupied_by")
        if occupied_by not in (None, owner_pid) and _process_exists(int(occupied_by)):
            raise RuntimeError(f'VM "{locator.raw}" is already occupied by pid {occupied_by}.')
        entry["occupied_by"] = owner_pid if owner_pid is not None else os.getpid()
        self._save_state(state)
        return locator.raw

    def release_vm(self, path_to_vm: str, owner_pid: Optional[int] = None) -> None:
        locator = parse_locator(path_to_vm)
        state = self._load_state()
        entry = state.get(locator.raw)
        if entry is None:
            return
        occupied_by = entry.get("occupied_by")
        if owner_pid is None or occupied_by in (None, owner_pid):
            entry["occupied_by"] = None
            self._save_state(state)

    def list_free_vms(self) -> List[str]:
        state = self._load_state()
        self._clean_stale_owners(state)
        self._save_state(state)
        return sorted(locator for locator, entry in state.items() if entry.get("occupied_by") is None)

    def check_and_clean(self) -> List[str]:
        state = self._load_state()
        cleaned = self._clean_stale_owners(state)
        self._save_state(state)
        return cleaned

    def get_vm_path(self, path_to_vm: str) -> str:
        return parse_locator(path_to_vm).raw

    def _load_state(self) -> Dict[str, Dict[str, Any]]:
        try:
            payload = json.loads(self.registry_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        if not isinstance(payload, dict):
            return {}
        return {
            locator: entry if isinstance(entry, dict) else {"occupied_by": None}
            for locator, entry in payload.items()
        }

    def _save_state(self, state: Dict[str, Dict[str, Any]]) -> None:
        self.registry_path.parent.mkdir(parents=True, exist_ok=True)
        self.registry_path.write_text(f"{json.dumps(state, indent=2, sort_keys=True)}\n", encoding="utf-8")

    def _clean_stale_owners(self, state: Dict[str, Dict[str, Any]]) -> List[str]:
        cleaned: List[str] = []
        for locator, entry in state.items():
            occupied_by = entry.get("occupied_by")
            if occupied_by is None:
                continue
            try:
                pid = int(occupied_by)
            except (TypeError, ValueError):
                entry["occupied_by"] = None
                cleaned.append(locator)
                continue
            if not _process_exists(pid):
                entry["occupied_by"] = None
                cleaned.append(locator)
        return cleaned


def _process_exists(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True
