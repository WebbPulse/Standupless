"""The `teams` table: the isolation unit inside a workspace.

Key prefix uniqueness is per workspace, so the indexed attribute is the composite
`workspace_key_prefix` (`<workspace_id>#<KEY>`) rather than the bare prefix: a
bare-prefix index would be a cross-tenant hash key, which design section 2 forbids.
Uniqueness is the same conditional write plus index read the workspace slug uses.

A team's key prefix can change. The retired prefix stays in the same table as an
alias row (`team_id = alias#<KEY>`) carrying the same indexed composite, so the
index that enforces uniqueness also keeps a retired prefix unavailable to every
other team, and a lookup by the old prefix still lands on the team. Issue rows
hold the team id and number, so no issue is rewritten when a prefix changes.

Deleting a team first tombstones its row (`deleting_at`) and drops the indexed
composite, which hides the team from every read and frees its prefix, then the
dependent rows are purged, then the row itself goes.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Literal, Mapping, Sequence

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Repository, TransactionCanceled, new_ulid

from app.common.db.dynamo.base import as_item, build_repository, utc_now
from app.common.db.dynamo.tables import TEAMS

KEY_PREFIX_INDEX = "workspace_key_prefix-index"

KEY_PREFIX_PATTERN = re.compile(r"^[A-Z][A-Z0-9]{1,5}$")

EstimateScale = Literal["off", "fibonacci", "linear", "tshirt"]

ESTIMATE_SCALES: tuple[str, ...] = ("off", "fibonacci", "linear", "tshirt")

DEFAULT_ESTIMATE_SCALE = "off"

ALIAS_PREFIX = "alias#"

INTERNAL_ATTRIBUTES = ("workspace_key_prefix", "deleting_at")


def new_team_id() -> str:
    """A fresh team id, time sortable so a listing reads in creation order."""
    return new_ulid()


def is_valid_key_prefix(key_prefix: str) -> bool:
    """Whether this key prefix is the uppercase form the contract requires."""
    return bool(KEY_PREFIX_PATTERN.match(key_prefix))


def workspace_key_prefix(workspace_id: str, key_prefix: str) -> str:
    """The composite the uniqueness index is keyed by, scoped to one workspace."""
    return f"{workspace_id}#{key_prefix.upper()}"


def alias_id(key_prefix: str) -> str:
    """The sort key of the alias row that holds a retired prefix."""
    return f"{ALIAS_PREFIX}{key_prefix.upper()}"


def _prefix_taken(workspace_id: str, key_prefix: str) -> ConditionFailed:
    """The error every prefix conflict raises."""
    return ConditionFailed(
        TEAMS.suffix,
        "key_prefix is already taken in this workspace",
        {"workspace_id": workspace_id, "key_prefix": key_prefix},
    )


class Team(BaseModel):
    """One team: the unit a guest is granted and an issue key is allocated from."""

    workspace_id: str
    team_id: str = Field(default_factory=new_team_id)
    name: str
    key_prefix: str
    description: str | None = None
    estimate_scale: str = DEFAULT_ESTIMATE_SCALE
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class TeamRepository:
    """Reads and writes `teams` rows, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(TEAMS, repository)

    def get(self, workspace_id: str, team_id: str) -> Team | None:
        """One team of this workspace, or `None`."""
        item = self._get_item(workspace_id, team_id)
        if item is None or "deleting_at" in item:
            return None
        return _as_team(item)

    def get_including_deleting(self, workspace_id: str, team_id: str) -> Team | None:
        """One team row even while its deletion is in progress, so a retry can resume."""
        item = self._get_item(workspace_id, team_id)
        return _as_team(item) if item is not None else None

    def is_deleting(self, workspace_id: str, team_id: str) -> bool:
        """Whether this team is tombstoned and waiting on its purge to finish."""
        item = self._get_item(workspace_id, team_id)
        return item is not None and "deleting_at" in item

    def _get_item(self, workspace_id: str, team_id: str) -> Mapping[str, Any] | None:
        """The raw team row, never an alias row."""
        if not workspace_id or not team_id or team_id.startswith(ALIAS_PREFIX):
            return None
        return self._repository.get({"workspace_id": workspace_id, "team_id": team_id})

    def _prefix_holders(self, workspace_id: str, key_prefix: str) -> list[Mapping[str, Any]]:
        """Every row, team or alias, holding this prefix in this workspace."""
        if not workspace_id or not key_prefix:
            return []
        return list(
            self._repository.iter_query(
                Key("workspace_key_prefix").eq(workspace_key_prefix(workspace_id, key_prefix)),
                index_name=KEY_PREFIX_INDEX,
                max_items=10,
            )
        )

    def get_by_key_prefix(self, workspace_id: str, key_prefix: str) -> Team | None:
        """The team holding this key prefix now or once held it, or `None`.

        A current holder wins over an alias, so a retired prefix only resolves
        through its alias row when no team holds it today.
        """
        holders = self._prefix_holders(workspace_id, key_prefix)
        for item in holders:
            if not str(item.get("team_id", "")).startswith(ALIAS_PREFIX) and "deleting_at" not in item:
                return _as_team(item)
        for item in holders:
            target = item.get("alias_of")
            if target:
                return self.get(workspace_id, str(target))
        return None

    def create(self, team: Team) -> Team:
        """Store a new team, raising `ConditionFailed` when the prefix is taken."""
        if self._prefix_holders(team.workspace_id, team.key_prefix):
            raise _prefix_taken(team.workspace_id, team.key_prefix)
        self._repository.put(
            as_item(team, workspace_key_prefix=workspace_key_prefix(team.workspace_id, team.key_prefix)),
            condition=Attr("team_id").not_exists(),
        )
        return team

    def create_action(self, team: Team) -> dict[str, Any]:
        """A transaction Put for a new team, holding the same uniqueness condition.

        The prefix read stays here rather than becoming a `ConditionCheck`, because
        uniqueness is answered by a global secondary index and a transaction cannot
        condition on one. The conditional put is what makes the row itself unique.
        """
        if self._prefix_holders(team.workspace_id, team.key_prefix):
            raise _prefix_taken(team.workspace_id, team.key_prefix)
        return self._repository.put_action(
            as_item(team, workspace_key_prefix=workspace_key_prefix(team.workspace_id, team.key_prefix)),
            condition=Attr("team_id").not_exists(),
        )

    def transact_write(self, actions: Sequence[Mapping[str, Any]]) -> None:
        """Apply `actions` as one all-or-nothing write through this table's client.

        Actions may name other tables, which is what lets a team, its creator's
        membership and its seeded statuses land together or not at all.
        """
        self._repository.transact_write(actions)

    def update(self, workspace_id: str, team_id: str, **attributes: Any) -> Team | None:
        """Apply `attributes` to one team, or `None` when it does not exist.

        The key prefix is not updatable here: `change_key_prefix` moves it and
        retires the old one as an alias in the same write.
        """
        if team_id.startswith(ALIAS_PREFIX):
            return None
        values = {name: value for name, value in attributes.items() if value is not None}
        values.pop("key_prefix", None)
        values["updated_at"] = utc_now().isoformat()
        key = {"workspace_id": workspace_id, "team_id": team_id}
        condition = Attr("name").exists() & Attr("deleting_at").not_exists()
        try:
            item = self._repository.set_attributes(key, values, condition=condition)
        except ConditionFailed:
            return None
        return _as_team(item) if item is not None else None

    def change_key_prefix(self, workspace_id: str, team_id: str, new_prefix: str) -> Team | None:
        """Move a team to `new_prefix`, keeping the old prefix as an alias of it.

        One transaction updates the team row, writes the alias for the old prefix
        and, when the team is taking back a prefix it retired, deletes that alias.
        Returns `None` when the team does not exist, and raises `ConditionFailed`
        when another team holds or once held `new_prefix`.
        """
        team = self.get(workspace_id, team_id)
        if team is None:
            return None
        new_prefix = new_prefix.upper()
        if new_prefix == team.key_prefix:
            return team

        reclaim = False
        for item in self._prefix_holders(workspace_id, new_prefix):
            if item.get("alias_of") == team_id:
                reclaim = True
                continue
            raise _prefix_taken(workspace_id, new_prefix)

        now = utc_now()
        key = {"workspace_id": workspace_id, "team_id": team_id}
        actions: list[dict[str, Any]] = [
            self._repository.update_action(
                key,
                update_expression="SET #kp = :kp, #wkp = :wkp, #ua = :ua",
                expression_names={"#kp": "key_prefix", "#wkp": "workspace_key_prefix", "#ua": "updated_at"},
                expression_values={
                    ":kp": new_prefix,
                    ":wkp": workspace_key_prefix(workspace_id, new_prefix),
                    ":ua": now.isoformat(),
                },
                condition=Attr("key_prefix").eq(team.key_prefix) & Attr("deleting_at").not_exists(),
            ),
            self._repository.put_action(
                {
                    "workspace_id": workspace_id,
                    "team_id": alias_id(team.key_prefix),
                    "alias_of": team_id,
                    "key_prefix": team.key_prefix,
                    "workspace_key_prefix": workspace_key_prefix(workspace_id, team.key_prefix),
                    "retired_at": now.isoformat(),
                },
                condition=Attr("team_id").not_exists() | Attr("alias_of").eq(team_id),
            ),
        ]
        if reclaim:
            actions.append(
                self._repository.delete_action(
                    {"workspace_id": workspace_id, "team_id": alias_id(new_prefix)},
                    condition=Attr("alias_of").eq(team_id),
                )
            )
        try:
            self._repository.transact_write(actions)
        except TransactionCanceled as exc:
            if not exc.conditional_check_failed:
                raise
            raise _prefix_taken(workspace_id, new_prefix) from exc
        return team.model_copy(update={"key_prefix": new_prefix, "updated_at": now})

    def list_aliases(self, workspace_id: str, team_id: str, *, limit: int = 200) -> list[str]:
        """Every retired prefix that still resolves to this team."""
        if not workspace_id or not team_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("team_id").begins_with(ALIAS_PREFIX),
            filter_expression=Attr("alias_of").eq(team_id),
            max_items=limit,
        )
        return sorted(str(item["key_prefix"]) for item in items)

    def aliases_by_team(self, workspace_id: str, *, limit: int = 500) -> dict[str, list[str]]:
        """Every retired prefix of this workspace, grouped under the team it resolves to."""
        if not workspace_id:
            return {}
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("team_id").begins_with(ALIAS_PREFIX),
            max_items=limit,
        )
        grouped: dict[str, list[str]] = {}
        for item in items:
            target = item.get("alias_of")
            prefix = item.get("key_prefix")
            if target and prefix:
                grouped.setdefault(str(target), []).append(str(prefix))
        return {team_id: sorted(prefixes) for team_id, prefixes in grouped.items()}

    def list_for_workspace(self, workspace_id: str, *, limit: int = 200) -> list[Team]:
        """Every live team of this workspace, oldest first, skipping aliases and tombstones."""
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id),
            filter_expression=Attr("alias_of").not_exists() & Attr("deleting_at").not_exists(),
            max_items=limit,
        )
        return sorted((_as_team(item) for item in items), key=lambda row: row.created_at)

    def mark_deleting(self, workspace_id: str, team_id: str) -> bool:
        """Tombstone a team and free its prefix, reporting whether the row exists.

        Idempotent: a second call on a tombstoned row leaves the first mark in place.
        """
        if self._get_item(workspace_id, team_id) is None:
            return False
        key = {"workspace_id": workspace_id, "team_id": team_id}
        try:
            self._repository.update(
                key,
                update_expression="SET #da = if_not_exists(#da, :now) REMOVE #wkp",
                expression_names={"#da": "deleting_at", "#wkp": "workspace_key_prefix"},
                expression_values={":now": utc_now().isoformat()},
                condition=Attr("team_id").exists(),
            )
        except ConditionFailed:
            return False
        return True

    def delete_aliases(self, workspace_id: str, team_id: str, *, batch: int = 100) -> int:
        """Remove every alias of this team, a page at a time, returning how many went."""
        removed = 0
        while True:
            aliases = self.list_aliases(workspace_id, team_id, limit=batch)
            if not aliases:
                return removed
            removed += self._repository.delete_many(
                [{"workspace_id": workspace_id, "team_id": alias_id(prefix)} for prefix in aliases]
            )

    def delete_tombstoned(self, workspace_id: str, team_id: str) -> bool:
        """Remove a team row only while it is tombstoned, reporting whether it went.

        The last step of a team purge. Conditional on `deleting_at`, so a stray or
        replayed purge message can never remove a live team.
        """
        if not self.is_deleting(workspace_id, team_id):
            return False
        try:
            self._repository.delete(
                {"workspace_id": workspace_id, "team_id": team_id},
                condition=Attr("deleting_at").exists(),
            )
        except ConditionFailed:
            return False
        return True

    def delete(self, workspace_id: str, team_id: str) -> bool:
        """Hard-delete one team row, tombstoned or not, reporting whether one was there."""
        if self._get_item(workspace_id, team_id) is None:
            return False
        self._repository.delete({"workspace_id": workspace_id, "team_id": team_id})
        return True


def _as_team(item: Mapping[str, Any]) -> Team:
    """One stored item as a `Team`, ignoring the index and tombstone attributes."""
    fields = {key: value for key, value in item.items() if key not in INTERNAL_ATTRIBUTES}
    return Team.model_validate(fields)
