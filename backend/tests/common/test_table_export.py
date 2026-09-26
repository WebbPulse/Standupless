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


COMPOSITE_PARTITIONS = {
    "activity": "ws_issue",
    "comments": "ws_issue",
    "inbox": "ws_user",
    "search_index": "ws_team",
    "attachments": "ws_issue",
    "subscriptions": "ws_issue",
    "reactions": "ws_target",
}
"""Tables whose partition key is the workspace joined to something narrower.

`activity`, `comments`, `attachments` and `subscriptions` partition per issue rather than per
workspace, because an issue's history, its thread and its files are what grow
without bound and a workspace-wide partition would make one busy workspace a hot
partition. A thread is also read one issue at a time, so the partition is exactly
the unit of the read. `reactions` partitions per target instead, so an issue's
reactions and a comment's are read the same way and neither needs the other's id.
`inbox` partitions per recipient, which is also what keeps one member's
notifications unreachable from another member's key. `search_index` partitions per
team, which is what stops a search crossing a team boundary at the storage
layer rather than in a filter.

The workspace is still the first segment of every composite, so the tenancy
invariant holds; it is the key's shape that differs, which is why the check below
reads the composite rather than exempting it.
"""


def test_every_declared_table_is_workspace_partitioned_or_named_why_not() -> None:
    """The tenancy invariant: a product table partitions by workspace.

    `users` and `workspaces` are keyed by their own id because they are the two
    things a workspace is defined in terms of, and `idempotency` carries the
    workspace inside its key because the claim has no tenant partition of its own.
    A composite partition counts as long as it is named here and starts with `ws_`,
    which is what keeps a new table from quietly opting out of the invariant.

    The credential-partitioned tables are no longer this product's. API keys and
    share tokens live in the identity package's own `api-keys` and `share-tokens`
    tables, which are partitioned by the credential hash for the same reason and
    keep the invariant a layer up through their workspace-first tenant indexes.
    """
    exempt = {"users", "workspaces", "idempotency"}
    for spec in TABLES:
        if spec.suffix in exempt:
            continue
        expected = COMPOSITE_PARTITIONS.get(spec.suffix)
        if expected is not None:
            assert spec.partition_key.name == expected, (
                f"{spec.suffix} partitions by {spec.partition_key.name}, not the declared {expected}"
            )
            assert expected.startswith("ws_"), f"{spec.suffix} composite partition must start with the workspace"
            continue
        assert spec.partition_key.name == "workspace_id", (
            f"{spec.suffix} partitions by {spec.partition_key.name}, not the workspace"
        )
