"""Export the merged OpenAPI document to backend/openapi.json.

Run from backend/ whenever a route, schema or tag changes:
    uv run python scripts/export_openapi.py

Built from Root A, which is the only composition that carries every domain, so the
exported document describes the whole served surface rather than one function's
share of it. `tests/common/test_openapi_export.py` fails until the regenerated file
is committed, so a published document cannot drift from the routes.

The export is deterministic: keys are sorted and the servers block is fixed rather
than read from settings, so running this in two environments produces the same
bytes and a diff only ever means a real surface change.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

TARGET = BACKEND_DIR / "openapi.json"

SERVERS = [
    {"url": "https://api.standupless.dev", "description": "Production"},
    {"url": "https://api.staging.standupless.dev", "description": "Staging"},
]


def document() -> dict[str, Any]:
    """The merged OpenAPI document, with the published servers block attached.

    Root A is imported inside the function rather than at module scope so importing
    this module for its constants does not build every domain's router.
    """
    from app.common.composition.app import app

    schema = dict(app.openapi())
    schema["servers"] = SERVERS
    return schema


def render() -> str:
    """Render the document as the JSON text written to the target file."""
    return json.dumps(document(), indent=2, sort_keys=True) + "\n"


def main() -> int:
    """Write the rendered document to the export file and return 0."""
    TARGET.write_text(render(), encoding="utf-8")
    print(f"wrote {TARGET} ({TARGET.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
