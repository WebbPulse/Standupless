"""One workspace's chat App installation, bound one to one to an outside team or server.

The Slack App and the Discord App share this shape. A workspace holds at most one
installation, under `<install prefix><outside id>` in its own partition, and the
outside service names its side by that id alone on every request it sends, so a
pointer row in the `_platform` partition, keyed `<pointer prefix><outside id>`,
maps the id back to the one workspace it is bound to. The pointer is only trusted
while the workspace still holds the matching installation, so a pointer a
workspace purge left behind resolves to nothing.
"""

from __future__ import annotations

from typing import Any, Generic, Mapping, TypeVar

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel
from webbpulse.dynamodb import ConditionFailed, Repository

from app.common.db.dynamo.base import as_item, first, utc_now

PLATFORM_PARTITION = "_platform"

Installation = TypeVar("Installation", bound=BaseModel)


class BoundInstallStore(Generic[Installation]):
    """Reads and writes the installation rows of one chat App, every method workspace first.

    A subclass names the row prefixes, the model and the field holding the outside
    id, and keeps its own vocabulary on top.
    """

    install_prefix: str = ""
    pointer_prefix: str = ""
    id_field: str = ""
    model: type[Installation]

    def __init__(self, repository: Repository) -> None:
        """Share the `github` table's package repository."""
        self._repository = repository

    def install_key(self, outside_id: str) -> str:
        """The sort key of one workspace's installation."""
        return f"{self.install_prefix}{outside_id}"

    def pointer_key(self, outside_id: str) -> str:
        """The sort key of the pointer from an outside id to its workspace."""
        return f"{self.pointer_prefix}{outside_id}"

    def _key(self, workspace_id: str, github_key: str) -> dict[str, str]:
        """The primary key of one row."""
        return {"workspace_id": workspace_id, "github_key": github_key}

    def _outside_id(self, installation: BaseModel) -> str:
        """The outside id an installation is bound to."""
        return str(getattr(installation, self.id_field, ""))

    def _rows(self, workspace_id: str) -> list[Mapping[str, Any]]:
        """Every installation row of one workspace, read strongly consistent."""
        if not workspace_id:
            return []
        return list(
            self._repository.iter_query(
                Key("workspace_id").eq(workspace_id) & Key("github_key").begins_with(self.install_prefix),
                max_items=10,
                consistent=True,
            )
        )

    def get(self, workspace_id: str) -> Installation | None:
        """The workspace's installation, or `None`."""
        item = first(self._rows(workspace_id))
        return self.model.model_validate(dict(item)) if item is not None else None

    def bound_workspace(self, outside_id: str) -> str:
        """The workspace an outside id is installed in, or `""` when none holds it now."""
        if not outside_id:
            return ""
        item = self._repository.get(self._key(PLATFORM_PARTITION, self.pointer_key(outside_id)), consistent=True)
        if item is None:
            return ""
        workspace_id = str(item.get("bound_workspace_id", ""))
        installation = self.get(workspace_id)
        if installation is None or self._outside_id(installation) != outside_id:
            return ""
        return workspace_id

    def installation_for(self, outside_id: str) -> Installation | None:
        """The installation an outside id resolves to, or `None`."""
        workspace_id = self.bound_workspace(outside_id)
        return self.get(workspace_id) if workspace_id else None

    def put(self, installation: Installation) -> Installation:
        """Store the workspace's installation, replacing any other outside id it held."""
        workspace_id = str(getattr(installation, "workspace_id"))
        outside_id = self._outside_id(installation)
        for item in self._rows(workspace_id):
            if str(item["github_key"]) != self.install_key(outside_id):
                self._drop(workspace_id, str(item.get(self.id_field, "")))
        self._repository.put(as_item(installation))
        self._repository.put(
            {
                "workspace_id": PLATFORM_PARTITION,
                "github_key": self.pointer_key(outside_id),
                self.id_field: outside_id,
                "bound_workspace_id": workspace_id,
                "updated_at": utc_now().isoformat(),
            }
        )
        return installation

    def _drop(self, workspace_id: str, outside_id: str) -> None:
        """Remove one installation row and its pointer when the pointer still names this workspace."""
        self._repository.delete(self._key(workspace_id, self.install_key(outside_id)))
        pointer = self._key(PLATFORM_PARTITION, self.pointer_key(outside_id))
        try:
            self._repository.delete(pointer, condition=Attr("bound_workspace_id").eq(workspace_id))
        except ConditionFailed:
            return

    def delete(self, workspace_id: str) -> Installation | None:
        """Forget the workspace's installation, answering the row that was removed."""
        current = self.get(workspace_id)
        if current is None:
            return None
        self._drop(workspace_id, self._outside_id(current))
        return current
