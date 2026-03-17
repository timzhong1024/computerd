from __future__ import annotations

import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from computerd_osworld_provider import (
    ComputerdProvider,
    ComputerdVMManager,
    parse_locator,
    translate_computer_13_action,
)


class ProviderTests(unittest.TestCase):
    def test_parse_locator(self) -> None:
        locator = parse_locator("computerd://computer/linux-vm")
        self.assertEqual(locator.computer_name, "linux-vm")

    def test_provider_lifecycle_uses_public_http_api(self) -> None:
        state = FakeComputerdState()
        server = FakeComputerdServer(state)
        provider = ComputerdProvider(base_url=server.base_url, poll_interval=0.01, ready_timeout=1.0)
        locator = "computerd://computer/linux-vm"

        try:
            self.assertEqual(provider.start_emulator(locator), locator)
            self.assertEqual(provider.get_ip_address(locator), "192.168.122.50")
            self.assertEqual(provider.save_state(locator, "checkpoint-1"), locator)
            self.assertEqual(provider.revert_to_snapshot(locator, "checkpoint-1"), locator)
            self.assertEqual(provider.revert_to_snapshot(locator, "initial"), locator)
            self.assertEqual(provider.stop_emulator(locator), locator)
        finally:
            server.close()

        self.assertEqual(
            state.requests,
            [
                ("GET", "/api/computers/linux-vm"),
                ("POST", "/api/computers/linux-vm/start"),
                ("GET", "/api/computers/linux-vm"),
                ("POST", "/api/computers/linux-vm/guest-command"),
                ("POST", "/api/computers/linux-vm/guest-command"),
                ("POST", "/api/computers/linux-vm/snapshots"),
                ("POST", "/api/computers/linux-vm/restore"),
                ("POST", "/api/computers/linux-vm/guest-command"),
                ("POST", "/api/computers/linux-vm/restore"),
                ("POST", "/api/computers/linux-vm/guest-command"),
                ("POST", "/api/computers/linux-vm/stop"),
            ],
        )
        self.assertEqual(state.snapshot_requests, ["checkpoint-1"])
        self.assertEqual(
            state.restore_requests,
            [{"target": "snapshot", "snapshotName": "checkpoint-1"}, {"target": "initial"}],
        )

    def test_provider_executes_translated_computer_13_actions(self) -> None:
        state = FakeComputerdState()
        server = FakeComputerdServer(state)
        provider = ComputerdProvider(base_url=server.base_url, poll_interval=0.01, ready_timeout=1.0)
        locator = "computerd://computer/linux-vm"

        try:
            result = provider.execute_computer_13_action(
                locator,
                {
                    "action": "DOUBLE_CLICK",
                    "x": 640,
                    "y": 360,
                },
                screenshot=False,
            )
        finally:
            server.close()

        self.assertEqual(result["completedOpCount"], 6)
        self.assertEqual(
            state.display_action_requests,
            [
                {
                    "computerName": "linux-vm",
                    "observe": {
                        "screenshot": False,
                    },
                    "ops": [
                        {"type": "mouse.move", "x": 640, "y": 360},
                        {"type": "mouse.down", "button": "left"},
                        {"type": "mouse.up", "button": "left"},
                        {"type": "wait", "ms": 75},
                        {"type": "mouse.down", "button": "left"},
                        {"type": "mouse.up", "button": "left"},
                    ],
                }
            ],
        )


class VMManagerTests(unittest.TestCase):
    def test_registry_tracks_and_releases_locators(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            registry = Path(temp_dir) / "registry.json"
            manager = ComputerdVMManager(registry)
            locator = "computerd://computer/linux-vm"

            self.assertEqual(manager.initialize_registry([locator]), [locator])
            self.assertEqual(manager.add_vm(locator), locator)
            self.assertEqual(manager.list_free_vms(), [locator])
            self.assertEqual(manager.occupy_vm(locator, owner_pid=123456789), locator)
            self.assertEqual(manager.list_free_vms(), [locator])
            self.assertEqual(manager.check_and_clean(), [])
            manager.release_vm(locator)
            self.assertEqual(manager.list_free_vms(), [locator])
            manager.delete_vm(locator)
            self.assertEqual(manager.list_free_vms(), [])


class Computer13TranslationTests(unittest.TestCase):
    def test_translate_hotkey(self) -> None:
        translated = translate_computer_13_action(
            {
                "action": "HOTKEY",
                "keys": ["ctrl", "c"],
            }
        )
        self.assertEqual(translated.kind, "display")
        self.assertEqual(
            translated.ops,
            [
                {"type": "key.down", "key": "Control"},
                {"type": "key.down", "key": "c"},
                {"type": "key.up", "key": "c"},
                {"type": "key.up", "key": "Control"},
            ],
        )

    def test_translate_named_keys_into_computerd_keysym_namespace(self) -> None:
        translated = translate_computer_13_action(
            {
                "action": "HOTKEY",
                "keys": ["shift", "enter", "left", "win"],
            }
        )
        self.assertEqual(translated.kind, "display")
        self.assertEqual(
            translated.ops,
            [
                {"type": "key.down", "key": "Shift"},
                {"type": "key.down", "key": "Enter"},
                {"type": "key.down", "key": "ArrowLeft"},
                {"type": "key.down", "key": "Meta"},
                {"type": "key.up", "key": "Meta"},
                {"type": "key.up", "key": "ArrowLeft"},
                {"type": "key.up", "key": "Enter"},
                {"type": "key.up", "key": "Shift"},
            ],
        )

    def test_translate_drag_to(self) -> None:
        translated = translate_computer_13_action(
            {
                "action": "DRAG_TO",
                "start_x": 10,
                "start_y": 20,
                "end_x": 70,
                "end_y": 80,
            }
        )
        self.assertEqual(translated.kind, "display")
        self.assertIsNotNone(translated.ops)
        self.assertEqual(translated.ops[0], {"type": "mouse.move", "x": 10, "y": 20})
        self.assertEqual(translated.ops[1], {"type": "mouse.down", "button": "left"})
        self.assertEqual(translated.ops[-1], {"type": "mouse.up", "button": "left"})
        self.assertEqual(translated.ops[-2], {"type": "mouse.move", "x": 70, "y": 80})

    def test_translate_done(self) -> None:
        translated = translate_computer_13_action(
            {
                "action": "DONE",
                "message": "task complete",
            }
        )
        self.assertEqual(translated.kind, "control")
        self.assertEqual(translated.status, "done")
        self.assertEqual(translated.message, "task complete")


class FakeComputerdState:
    def __init__(self) -> None:
        self.requests: list[tuple[str, str]] = []
        self.display_action_requests: list[dict[str, object]] = []
        self.restore_requests: list[dict[str, object]] = []
        self.snapshot_requests: list[str] = []
        self.ready_attempts = 0
        self.running = False

    def detail(self) -> dict[str, object]:
        return {
            "name": "linux-vm",
            "profile": "vm",
            "state": "running" if self.running else "stopped",
            "runtime": {
                "displayViewport": {
                    "width": 1440,
                    "height": 900,
                }
            },
        }


class FakeComputerdServer:
    def __init__(self, state: FakeComputerdState) -> None:
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._make_handler(state))
        self.base_url = f"http://127.0.0.1:{self._server.server_address[1]}"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=1.0)

    @staticmethod
    def _make_handler(state: FakeComputerdState):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                path = urlparse(self.path).path
                state.requests.append(("GET", path))
                if path == "/api/computers/linux-vm":
                    self._send_json(200, state.detail())
                    return
                self._send_json(404, {"error": "Not Found"})

            def do_POST(self) -> None:  # noqa: N802
                path = urlparse(self.path).path
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length) or b"null")
                state.requests.append(("POST", path))

                if path == "/api/computers/linux-vm/start":
                    state.running = True
                    self._send_json(200, state.detail())
                    return
                if path == "/api/computers/linux-vm/stop":
                    state.running = False
                    self._send_json(200, state.detail())
                    return
                if path == "/api/computers/linux-vm/snapshots":
                    state.snapshot_requests.append(str(payload["name"]))
                    self._send_json(200, {"name": payload["name"], "createdAt": "2026-03-17T00:00:00Z", "sizeBytes": 1})
                    return
                if path == "/api/computers/linux-vm/restore":
                    state.restore_requests.append(payload)
                    self._send_json(200, state.detail())
                    return
                if path == "/api/computers/linux-vm/guest-command":
                    command = payload["command"]
                    if command == "echo ready":
                        state.ready_attempts += 1
                        self._send_json(
                            200,
                            {
                                "exitCode": 0,
                                "stdout": "ready",
                                "stderr": "",
                                "timedOut": False,
                                "completedAt": "2026-03-17T00:00:00Z",
                            },
                        )
                        return
                    if command == "hostname -I | awk '{print $1}'":
                        self._send_json(
                            200,
                            {
                                "exitCode": 0,
                                "stdout": "192.168.122.50\n",
                                "stderr": "",
                                "timedOut": False,
                                "completedAt": "2026-03-17T00:00:01Z",
                            },
                        )
                        return
                if path == "/api/computers/linux-vm/display-actions":
                    state.display_action_requests.append(payload)
                    self._send_json(
                        200,
                        {
                            "computerName": "linux-vm",
                            "completedOpCount": len(payload["ops"]),
                            "viewport": {
                                "width": 1440,
                                "height": 900,
                            },
                            "capturedAt": "2026-03-18T00:00:00Z",
                        },
                    )
                    return
                self._send_json(404, {"error": "Not Found"})

            def log_message(self, format: str, *args: object) -> None:  # noqa: A003
                del format, args

            def _send_json(self, status: int, payload: object) -> None:
                body = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        return Handler


if __name__ == "__main__":
    unittest.main()
