"""Export the DynamoDB table specs to terraform/dynamodb_tables.json.

Run from backend/ whenever app/common/db/dynamo/tables.py changes:
    uv run python scripts/export_dynamo_tables.py

`tests/common/db/test_dynamo_tables_json_up_to_date.py` fails until the regenerated
file is committed, so Terraform never drifts from the application's specs.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.common.db.dynamo.tables import export_table_definitions  # noqa: E402

TARGET = BACKEND_DIR.parent / "terraform" / "dynamodb_tables.json"


def render() -> str:
    """Render the table definitions as the JSON text written to the target file."""
    return json.dumps(export_table_definitions(), indent=2, sort_keys=True) + "\n"


def main() -> int:
    """Write the rendered table definitions to the Terraform JSON file and return 0."""
    TARGET.write_text(render(), encoding="utf-8")
    print(f"wrote {TARGET} ({TARGET.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
