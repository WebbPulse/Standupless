"""`terraform/dynamodb_tables.json` is generated, so it cannot drift from the code.

The exported file is what Terraform provisions the tables from, and it is written
by hand nowhere. If this fails, run the exporter rather than editing the JSON.
"""

from __future__ import annotations

import json
from pathlib import Path

from app.common.db.dynamo.tables import EXPORTED_TABLES, TABLES, export_table_definitions

EXPORTED = Path(__file__).resolve().parents[2].parent / "terraform" / "dynamodb_tables.json"


def test_the_exported_tables_match_the_declarations() -> None:
    """The committed JSON is exactly what the exporter renders today."""
    if not EXPORTED.exists():
        import pytest

        pytest.skip("terraform/dynamodb_tables.json is not present")

    assert json.loads(EXPORTED.read_text()) == export_table_definitions(), (
        "The table declarations changed. Regenerate with uv run python scripts/export_dynamo_tables.py"
    )


def test_the_rate_limits_table_is_exported_but_owned_by_no_repository() -> None:
    """The rate limiter owns its table, so no bundle declares it and Terraform still builds it."""
    suffixes = {spec.suffix for spec in TABLES}
    exported = {spec.suffix for spec in EXPORTED_TABLES}

    assert "rate-limits" not in suffixes
    assert "rate-limits" in exported


def test_every_declared_table_is_workspace_partitioned_or_named_why_not() -> None:
    """The tenancy invariant: a product table partitions by workspace.

    `users` and `workspaces` are keyed by their own id because they are the two
    things a workspace is defined in terms of, and `idempotency` carries the
    workspace inside its key because the claim has no tenant partition of its own.
    """
    exempt = {"users", "workspaces", "idempotency"}
    for spec in TABLES:
        if spec.suffix in exempt:
            continue
        assert spec.partition_key.name == "workspace_id", (
            f"{spec.suffix} partitions by {spec.partition_key.name}, not the workspace"
        )
