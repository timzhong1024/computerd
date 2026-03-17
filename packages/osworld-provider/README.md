# OSWorld Provider

`packages/osworld-provider` provides:

- a Python `ComputerdProvider` and `ComputerdVMManager` for OSWorld integration
- a `computer_13` translation layer that converts OSWorld-style actions into `computerd` display ops

## computer_13 Translation

The translation entrypoint is `translate_computer_13_action(action)` in [src/computerd_osworld_provider/computer_13.py](/Users/timzhong/computerd/packages/osworld-provider/src/computerd_osworld_provider/computer_13.py).

It returns one of two results:

- `kind="display"`: the action was translated into `computerd` `ops[]`
- `kind="control"`: the action is a rollout control signal such as `DONE` or `FAIL`

`ComputerdProvider.execute_computer_13_action(...)` uses the same translator and, for display actions, sends the translated ops to `POST /api/computers/:name/display-actions`.

## Mapping Table

| computer_13 action | Expected fields | computerd translation | Notes |
| --- | --- | --- | --- |
| `MOVE_TO` | `x`, `y` | `mouse.move` | Direct mapping |
| `CLICK` | `x`, `y`, optional `button` | `mouse.move` + `mouse.down` + `mouse.up` | Defaults to left button |
| `LEFT_CLICK` | `x`, `y` | same as `CLICK(left)` | Alias |
| `RIGHT_CLICK` | `x`, `y` | `mouse.move` + `mouse.down(right)` + `mouse.up(right)` | Alias |
| `DOUBLE_CLICK` | `x`, `y` | click + `wait(75ms)` + click | Synthesized in adapter |
| `MOUSE_DOWN` | optional `x`, `y`, optional `button` | optional `mouse.move` + `mouse.down` | Defaults to left button |
| `MOUSE_UP` | optional `x`, `y`, optional `button` | optional `mouse.move` + `mouse.up` | Defaults to left button |
| `DRAG_TO` | `start_x`, `start_y`, `end_x`, `end_y` | `move(start)` + `down(left)` + interpolated `move` steps + `up(left)` | Path interpolation uses 20px steps |
| `SCROLL` | `deltaX`/`deltaY`, or `dx`/`dy`, or `clicks` | `mouse.scroll` | `clicks` maps to `deltaY` |
| `TYPING` | `text`, `content`, or `value` | `text.insert` | Uses guest text insertion, not per-key typing |
| `PRESS` | `key` | `key.press` | Key aliases normalized |
| `KEY_DOWN` | `key` | `key.down` | Key aliases normalized |
| `KEY_UP` | `key` | `key.up` | Key aliases normalized |
| `HOTKEY` | `keys`, or `key` like `ctrl+c` | ordered `key.down` then reverse `key.up` | Adapter expands combo |
| `WAIT` | `ms`, or `seconds`, or `duration`, or `time` | `wait` | Seconds-like fields are converted to ms |
| `DONE` | optional `message`, `reason`, or `text` | control result | Not sent to `/display-actions` |
| `FAIL` | optional `message`, `reason`, or `text` | control result | Not sent to `/display-actions` |

## Coordinate and Key Rules

- Coordinates are rounded to integer pixels before translation.
- `CLICK`-family actions require explicit coordinates.
- `MOUSE_DOWN` and `MOUSE_UP` may omit coordinates. If coordinates are present, the adapter inserts a `mouse.move` first.
- `DRAG_TO` currently requires explicit start and end coordinates. It does not yet support "drag from current cursor position".
- Supported button names are `left`, `middle`, and `right`.

Key aliases currently normalized by the adapter include:

- `ctrl` -> `Control`
- `shift` -> `Shift`
- `alt` -> `Alt`
- `enter` -> `Enter`
- `esc` -> `Escape`
- `tab` -> `Tab`
- arrow keys like `left`, `right`, `up`, `down` -> `ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`
- `win` / `super` / `meta` -> `Meta`

Unknown keys are passed through as-is.

## Examples

Click:

```python
translate_computer_13_action(
    {
        "action": "CLICK",
        "x": 640,
        "y": 360,
    }
)
```

Result:

```python
Computer13Translation(
    kind="display",
    ops=[
        {"type": "mouse.move", "x": 640, "y": 360},
        {"type": "mouse.down", "button": "left"},
        {"type": "mouse.up", "button": "left"},
    ],
)
```

Hotkey:

```python
translate_computer_13_action(
    {
        "action": "HOTKEY",
        "keys": ["ctrl", "c"],
    }
)
```

Result:

```python
Computer13Translation(
    kind="display",
    ops=[
        {"type": "key.down", "key": "Control"},
        {"type": "key.down", "key": "c"},
        {"type": "key.up", "key": "c"},
        {"type": "key.up", "key": "Control"},
    ],
)
```

Done signal:

```python
translate_computer_13_action(
    {
        "action": "DONE",
        "message": "task complete",
    }
)
```

Result:

```python
Computer13Translation(
    kind="control",
    status="done",
    message="task complete",
)
```

## Current Limits

- No direct support yet for more recent UITARS/JEDI-style box or tool-call actions.
- No explicit `DRAG_FROM_CURRENT` stateful action.
- No separate high-level `click(count=2)` primitive in `computerd`; double click is synthesized in the adapter.
- `DONE` and `FAIL` are only adapter-level signals. They are not persisted or reported to the `computerd` server as task state.
