from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple


KEY_ALIASES = {
    "alt": "Alt",
    "backspace": "BackSpace",
    "ctrl": "Control",
    "delete": "Delete",
    "down": "ArrowDown",
    "enter": "Enter",
    "esc": "Escape",
    "left": "ArrowLeft",
    "meta": "Meta",
    "pagedown": "PageDown",
    "pageup": "PageUp",
    "right": "ArrowRight",
    "shift": "Shift",
    "space": "Space",
    "super": "Meta",
    "tab": "Tab",
    "up": "ArrowUp",
    "win": "Meta",
}

BUTTON_ALIASES = {
    "left": "left",
    "middle": "middle",
    "right": "right",
}


class Computer13TranslationError(ValueError):
    pass


@dataclass(frozen=True)
class Computer13Translation:
    kind: str
    ops: Optional[List[Dict[str, Any]]] = None
    status: Optional[str] = None
    message: Optional[str] = None


def translate_computer_13_action(action: Dict[str, Any]) -> Computer13Translation:
    action_name = _normalize_action_name(action)

    if action_name == "MOVE_TO":
        x, y = _require_xy(action)
        return Computer13Translation(kind="display", ops=[_move_op(x, y)])

    if action_name in ("CLICK", "LEFT_CLICK", "RIGHT_CLICK", "DOUBLE_CLICK"):
        x, y = _require_xy(action)
        button = _resolve_button(action, default="right" if action_name == "RIGHT_CLICK" else "left")
        clicks = 2 if action_name == "DOUBLE_CLICK" else 1
        return Computer13Translation(kind="display", ops=_build_click_ops(x, y, button, clicks))

    if action_name == "MOUSE_DOWN":
        x, y = _optional_xy(action)
        button = _resolve_button(action, default="left")
        ops: List[Dict[str, Any]] = []
        if x is not None and y is not None:
            ops.append(_move_op(x, y))
        ops.append({"type": "mouse.down", "button": button})
        return Computer13Translation(kind="display", ops=ops)

    if action_name == "MOUSE_UP":
        x, y = _optional_xy(action)
        button = _resolve_button(action, default="left")
        ops = []
        if x is not None and y is not None:
            ops.append(_move_op(x, y))
        ops.append({"type": "mouse.up", "button": button})
        return Computer13Translation(kind="display", ops=ops)

    if action_name == "DRAG_TO":
        return Computer13Translation(kind="display", ops=_build_drag_ops(action))

    if action_name == "SCROLL":
        delta_x, delta_y = _resolve_scroll(action)
        return Computer13Translation(
            kind="display",
            ops=[{"type": "mouse.scroll", "deltaX": delta_x, "deltaY": delta_y}],
        )

    if action_name == "TYPING":
        text = _read_string(action, ("text", "content", "value"))
        return Computer13Translation(kind="display", ops=[{"type": "text.insert", "text": text}])

    if action_name == "PRESS":
        key = _normalize_key(_read_string(action, ("key",)))
        return Computer13Translation(kind="display", ops=[{"type": "key.press", "key": key}])

    if action_name == "KEY_DOWN":
        key = _normalize_key(_read_string(action, ("key",)))
        return Computer13Translation(kind="display", ops=[{"type": "key.down", "key": key}])

    if action_name == "KEY_UP":
        key = _normalize_key(_read_string(action, ("key",)))
        return Computer13Translation(kind="display", ops=[{"type": "key.up", "key": key}])

    if action_name == "HOTKEY":
        keys = _resolve_hotkey_keys(action)
        ops = [{"type": "key.down", "key": key} for key in keys]
        ops.extend({"type": "key.up", "key": key} for key in reversed(keys))
        return Computer13Translation(kind="display", ops=ops)

    if action_name == "WAIT":
        return Computer13Translation(kind="display", ops=[{"type": "wait", "ms": _resolve_wait_ms(action)}])

    if action_name == "DONE":
        return Computer13Translation(kind="control", status="done", message=_optional_message(action))

    if action_name == "FAIL":
        return Computer13Translation(kind="control", status="fail", message=_optional_message(action))

    raise Computer13TranslationError(f'Unsupported computer_13 action "{action_name}".')


def _normalize_action_name(action: Dict[str, Any]) -> str:
    value = action.get("action")
    if not isinstance(value, str) or not value.strip():
        raise Computer13TranslationError('Expected a non-empty "action" field.')
    return value.strip().upper()


def _optional_message(action: Dict[str, Any]) -> Optional[str]:
    for key in ("message", "reason", "text"):
        value = action.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _require_xy(action: Dict[str, Any]) -> Tuple[int, int]:
    x, y = _optional_xy(action)
    if x is None or y is None:
        raise Computer13TranslationError("Expected x and y coordinates.")
    return x, y


def _optional_xy(action: Dict[str, Any]) -> Tuple[Optional[int], Optional[int]]:
    x = _read_optional_coordinate(action, ("x",))
    y = _read_optional_coordinate(action, ("y",))
    if x is None and y is None:
        point = action.get("position")
        if isinstance(point, (list, tuple)) and len(point) == 2:
            return _to_int(point[0], "position[0]"), _to_int(point[1], "position[1]")
    return x, y


def _build_click_ops(x: int, y: int, button: str, clicks: int) -> List[Dict[str, Any]]:
    ops: List[Dict[str, Any]] = [_move_op(x, y)]
    for index in range(clicks):
        ops.append({"type": "mouse.down", "button": button})
        ops.append({"type": "mouse.up", "button": button})
        if index + 1 < clicks:
            ops.append({"type": "wait", "ms": 75})
    return ops


def _build_drag_ops(action: Dict[str, Any]) -> List[Dict[str, Any]]:
    start_x = _read_optional_coordinate(action, ("start_x", "from_x", "x1"))
    start_y = _read_optional_coordinate(action, ("start_y", "from_y", "y1"))
    end_x = _read_optional_coordinate(action, ("end_x", "to_x", "x2", "x"))
    end_y = _read_optional_coordinate(action, ("end_y", "to_y", "y2", "y"))
    if start_x is None or start_y is None or end_x is None or end_y is None:
        raise Computer13TranslationError(
            "Expected drag action to define start and end coordinates.",
        )

    ops: List[Dict[str, Any]] = [_move_op(start_x, start_y), {"type": "mouse.down", "button": "left"}]
    for move_x, move_y in _interpolate_path(start_x, start_y, end_x, end_y):
        ops.append(_move_op(move_x, move_y))
    ops.append({"type": "mouse.up", "button": "left"})
    return ops


def _interpolate_path(start_x: int, start_y: int, end_x: int, end_y: int, step_px: int = 20) -> List[Tuple[int, int]]:
    dx = end_x - start_x
    dy = end_y - start_y
    distance = max(abs(dx), abs(dy))
    if distance == 0:
        return [(end_x, end_y)]

    segments = max(1, distance // step_px)
    points: List[Tuple[int, int]] = []
    for index in range(1, segments + 1):
        ratio = index / segments
        points.append((round(start_x + dx * ratio), round(start_y + dy * ratio)))
    if points[-1] != (end_x, end_y):
        points.append((end_x, end_y))
    return points


def _resolve_button(action: Dict[str, Any], default: str) -> str:
    value = action.get("button", default)
    if not isinstance(value, str):
        raise Computer13TranslationError("Expected mouse button to be a string.")
    normalized = BUTTON_ALIASES.get(value.strip().lower())
    if normalized is None:
        raise Computer13TranslationError(f'Unsupported mouse button "{value}".')
    return normalized


def _resolve_hotkey_keys(action: Dict[str, Any]) -> List[str]:
    keys = action.get("keys")
    if isinstance(keys, Sequence) and not isinstance(keys, (str, bytes)):
        normalized = [_normalize_key(_ensure_string(key, "keys[]")) for key in keys]
        if normalized:
            return normalized

    key = action.get("key")
    if isinstance(key, str) and key.strip():
        return [_normalize_key(part) for part in key.replace("+", " ").split()]

    raise Computer13TranslationError('Expected HOTKEY action to include "keys" or "key".')


def _resolve_scroll(action: Dict[str, Any]) -> Tuple[int, int]:
    if "deltaX" in action or "deltaY" in action:
        return (
            _to_int(action.get("deltaX", 0), "deltaX"),
            _to_int(action.get("deltaY", 0), "deltaY"),
        )
    if "dx" in action or "dy" in action:
        return (_to_int(action.get("dx", 0), "dx"), _to_int(action.get("dy", 0), "dy"))
    if "clicks" in action:
        return (0, _to_int(action["clicks"], "clicks"))
    raise Computer13TranslationError(
        'Expected SCROLL action to include deltaX/deltaY, dx/dy, or clicks.',
    )


def _resolve_wait_ms(action: Dict[str, Any]) -> int:
    if "ms" in action:
        return _positive_ms(action["ms"], "ms")
    for key in ("seconds", "duration", "time"):
        if key in action:
            value = action[key]
            if isinstance(value, (int, float)):
                return max(0, round(float(value) * 1000))
            raise Computer13TranslationError(f'Expected "{key}" to be numeric.')
    raise Computer13TranslationError('Expected WAIT action to include "ms", "seconds", "duration", or "time".')


def _move_op(x: int, y: int) -> Dict[str, Any]:
    return {"type": "mouse.move", "x": x, "y": y}


def _read_string(action: Dict[str, Any], keys: Sequence[str]) -> str:
    for key in keys:
        value = action.get(key)
        if isinstance(value, str) and value:
            return value
    raise Computer13TranslationError(f"Expected one of {', '.join(keys)} to be a non-empty string.")


def _read_optional_coordinate(action: Dict[str, Any], keys: Sequence[str]) -> Optional[int]:
    for key in keys:
        if key in action:
            return _to_int(action[key], key)
    return None


def _normalize_key(value: str) -> str:
    key = value.strip()
    if not key:
        raise Computer13TranslationError("Expected key to be non-empty.")
    return KEY_ALIASES.get(key.lower(), key)


def _positive_ms(value: Any, label: str) -> int:
    ms = _to_int(value, label)
    if ms < 0:
        raise Computer13TranslationError(f'Expected "{label}" to be non-negative.')
    return ms


def _ensure_string(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise Computer13TranslationError(f'Expected "{label}" to be a string.')
    return value


def _to_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise Computer13TranslationError(f'Expected "{label}" to be numeric.')
    return round(float(value))
