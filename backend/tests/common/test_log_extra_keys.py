"""Log calls must not pass `extra` keys that collide with LogRecord attributes.

The standard library raises `KeyError` from `makeRecord` when an `extra` key
names an attribute the record already has, so a colliding key turns a log line
into a crash of the code path that emitted it.
"""

import ast
import logging
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[2] / "app"
RESERVED = set(vars(logging.LogRecord("n", 0, "p", 0, "m", None, None))) | {
    "message",
    "asctime",
}


def _colliding_keys() -> list[str]:
    """Return every literal `extra` key under app/ that names a LogRecord attribute."""
    hits: list[str] = []
    for path in sorted(APP_ROOT.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text())):
            if not (isinstance(node, ast.keyword) and node.arg == "extra" and isinstance(node.value, ast.Dict)):
                continue
            for key in node.value.keys:
                if isinstance(key, ast.Constant) and key.value in RESERVED:
                    hits.append(f"{path.relative_to(APP_ROOT)}:{key.lineno} {key.value}")
    return hits


def test_no_log_extra_key_collides_with_a_log_record_attribute() -> None:
    """A reserved key in `extra` crashes the caller, as the cycle sweep once did."""
    assert _colliding_keys() == []
