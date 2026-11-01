"""The devices one person receives native push notifications on.

A device row belongs to a person rather than to a workspace, because one phone
signs in once and hears from every workspace that person is in. Its
`workspace_ids` are the workspaces the app has opened on it, which the badge sums
over. Keeping one owner per token is what stops a phone that changed hands while
offline from showing the previous person's notifications: the claim row names the
owner, and a registration by anyone else removes the earlier owner's device.

Rows live in the `inbox` table under `pushdevice#<user>` and `pushtoken#<device>`,
partitions no inbox read can name, because every function that sends already holds
a grant on that table. They carry the table's TTL and every registration pushes it
out, so a phone that stopped opening the app ages out without a sweep, which also
covers an account deleted from a function that holds no grant here.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta
from typing import Literal

from boto3.dynamodb.conditions import Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import Repository

from app.common.db.dynamo.base import as_item, utc_now

PushPlatform = Literal["ios"]

DEVICE_PREFIX = "pushdevice#"
CLAIM_PREFIX = "pushtoken#"
CLAIM_OWNER = "owner"

DEVICE_RETENTION = timedelta(days=90)
"""How long a device stays registered after the app last opened on it."""

MAX_DEVICES_PER_USER = 20
"""The most devices one person keeps, which bounds a partition and one send's fan out."""

MAX_WORKSPACES_PER_DEVICE = 50
"""The most workspaces one device's badge sums over, which bounds the reads behind one badge."""


def device_partition(user_id: str) -> str:
    """The partition one person's devices live under."""
    return f"{DEVICE_PREFIX}{user_id}"


def device_id_for(token: str) -> str:
    """A stable id for one token, so keys and logs never carry the token itself."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _expiry(moment: datetime) -> int:
    """The epoch second DynamoDB drops a device registered at `moment`."""
    return int((moment + DEVICE_RETENTION).timestamp())


class PushDevice(BaseModel):
    """One registered device: its provider token and the workspaces opened on it."""

    user_id: str
    device_id: str
    platform: PushPlatform
    token: str
    workspace_ids: list[str] = Field(default_factory=list)
    registered_at: datetime


class PushDeviceStore:
    """Reads and writes device rows and their token claims in the `inbox` table."""

    def __init__(self, repository: Repository) -> None:
        """Share the `inbox` table's package repository."""
        self._repository = repository

    def for_user(self, user_id: str) -> list[PushDevice]:
        """Every device one person has registered."""
        if not user_id:
            return []
        page = self._repository.query(Key("ws_user").eq(device_partition(user_id)), limit=MAX_DEVICES_PER_USER + 1)
        return [PushDevice.model_validate(dict(item)) for item in page.items]

    def register(self, user_id: str, platform: PushPlatform, token: str, workspace_id: str) -> PushDevice:
        """Store one device for one person, keeping every workspace opened on it.

        A token last owned by someone else leaves their devices first, and the oldest
        device gives way once a person is at the limit.
        """
        device_id = device_id_for(token)
        claim_key = {"ws_user": f"{CLAIM_PREFIX}{device_id}", "notification_id": CLAIM_OWNER}
        claim = self._repository.get(claim_key)
        previous_owner = str(claim.get("user_id", "")) if claim is not None else ""
        if previous_owner and previous_owner != user_id:
            self._delete_device(previous_owner, device_id)

        devices = self.for_user(user_id)
        existing = next((device for device in devices if device.device_id == device_id), None)
        others = sorted(
            (device for device in devices if device.device_id != device_id),
            key=lambda device: device.registered_at,
        )
        for stale in others[: max(0, len(others) + 1 - MAX_DEVICES_PER_USER)]:
            self.remove(user_id, stale.device_id)

        kept = [known for known in (existing.workspace_ids if existing else []) if known != workspace_id]
        now = utc_now()
        device = PushDevice(
            user_id=user_id,
            device_id=device_id,
            platform=platform,
            token=token,
            workspace_ids=[*kept, workspace_id][-MAX_WORKSPACES_PER_DEVICE:],
            registered_at=now,
        )
        self._store(device)
        self._repository.put({**claim_key, "user_id": user_id, "expires_at": _expiry(now)})
        return device

    def add_workspace(self, device: PushDevice, workspace_id: str) -> PushDevice:
        """Count one more workspace in a device's badge, once a notification arrives from it.

        A person may hear from a workspace before opening it on this phone, and the
        badge should not drop that count on the next send from another workspace.
        """
        if workspace_id in device.workspace_ids:
            return device
        workspace_ids = [*device.workspace_ids, workspace_id][-MAX_WORKSPACES_PER_DEVICE:]
        updated = device.model_copy(update={"workspace_ids": workspace_ids})
        self._store(updated)
        return updated

    def remove(self, user_id: str, device_id: str) -> None:
        """Remove one person's device and the claim on its token."""
        self._delete_device(user_id, device_id)
        claim_key = {"ws_user": f"{CLAIM_PREFIX}{device_id}", "notification_id": CLAIM_OWNER}
        claim = self._repository.get(claim_key)
        if claim is not None and str(claim.get("user_id", "")) == user_id:
            self._repository.delete(claim_key)

    def forget_workspace(self, workspace_id: str, user_id: str) -> None:
        """Take one workspace out of every device's badge, for the purges.

        A device left with no workspace goes too, since nothing can reach it until
        the app registers it again.
        """
        for device in self.for_user(user_id):
            if workspace_id not in device.workspace_ids:
                continue
            remaining = [known for known in device.workspace_ids if known != workspace_id]
            if not remaining:
                self.remove(user_id, device.device_id)
                continue
            self._store(device.model_copy(update={"workspace_ids": remaining}))

    def _store(self, device: PushDevice) -> None:
        """Write one device row, aging out from when the app last registered it."""
        self._repository.put(
            as_item(
                device,
                ws_user=device_partition(device.user_id),
                notification_id=device.device_id,
                expires_at=_expiry(device.registered_at),
            )
        )

    def _delete_device(self, user_id: str, device_id: str) -> None:
        """Delete one device row, leaving its token claim alone."""
        self._repository.delete({"ws_user": device_partition(user_id), "notification_id": device_id})
