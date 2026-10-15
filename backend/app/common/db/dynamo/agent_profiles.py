"""The `agent_profiles` table: each person's private, versioned agent guidance.

Every row lives in the owner's own `user_id` partition, so a read is always a key
condition on one person and nothing here can list another person's rows. Three row
kinds share the partition, told apart by the `profile_key` prefix:

- `profile#<name>`: the head, naming the latest version and its counts.
- `version#<name>#<number>`: one kept version's metadata and the envelope fields
  its sealed manifest opens with.
- `chunk#<name>#<number>#<index>`: one slice of that version's sealed manifest.

The repository stores and reads rows only. Sealing, validation and pruning policy
live in `app.common.agent_profiles`, which is the one caller.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Mapping, Optional

from boto3.dynamodb.conditions import Attr, Key
from webbpulse.dynamodb import Repository

from app.common.db.dynamo.base import build_repository, delete_partition
from app.common.db.dynamo.tables import AGENT_PROFILES

VERSION_DIGITS = 6
"""Zero padding on version numbers, so the sort key orders versions numerically."""


def head_key(name: str) -> str:
    """The sort key of one profile's head row."""
    return f"profile#{name}"


def version_key(name: str, version: int) -> str:
    """The sort key of one version's metadata row."""
    return f"version#{name}#{version:0{VERSION_DIGITS}d}"


def chunk_prefix(name: str, version: int) -> str:
    """The sort key prefix every chunk of one version shares."""
    return f"chunk#{name}#{version:0{VERSION_DIGITS}d}#"


def chunk_key(name: str, version: int, index: int) -> str:
    """The sort key of one chunk of a version's sealed manifest."""
    return f"{chunk_prefix(name, version)}{index:04d}"


def _parse_time(raw: Any) -> datetime:
    """A stored ISO 8601 timestamp as an aware datetime."""
    return datetime.fromisoformat(str(raw))


@dataclass(frozen=True)
class ProfileHead:
    """One profile as its owner lists it: the latest version and what it holds."""

    user_id: str
    name: str
    latest_version: int
    file_count: int
    total_bytes: int
    note: str
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_item(cls, item: Mapping[str, Any]) -> "ProfileHead":
        """A head read back from its stored row."""
        return cls(
            user_id=str(item["user_id"]),
            name=str(item["name"]),
            latest_version=int(item["latest_version"]),
            file_count=int(item.get("file_count", 0)),
            total_bytes=int(item.get("total_bytes", 0)),
            note=str(item.get("note", "")),
            created_at=_parse_time(item["created_at"]),
            updated_at=_parse_time(item["updated_at"]),
        )

    def as_item(self) -> dict[str, Any]:
        """The stored row for this head."""
        return {
            "user_id": self.user_id,
            "profile_key": head_key(self.name),
            "name": self.name,
            "latest_version": self.latest_version,
            "file_count": self.file_count,
            "total_bytes": self.total_bytes,
            "note": self.note,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }


@dataclass(frozen=True)
class ProfileVersion:
    """One kept version: its counts, the digest of its contents and the envelope that opens it."""

    user_id: str
    name: str
    version: int
    note: str
    file_count: int
    total_bytes: int
    digest: str
    source: str
    created_at: datetime
    chunk_count: int
    nonce: str
    wrapped_key: str
    scheme: str

    @classmethod
    def from_item(cls, item: Mapping[str, Any]) -> "ProfileVersion":
        """A version read back from its stored row."""
        return cls(
            user_id=str(item["user_id"]),
            name=str(item["name"]),
            version=int(item["version"]),
            note=str(item.get("note", "")),
            file_count=int(item.get("file_count", 0)),
            total_bytes=int(item.get("total_bytes", 0)),
            digest=str(item.get("digest", "")),
            source=str(item.get("source", "")),
            created_at=_parse_time(item["created_at"]),
            chunk_count=int(item.get("chunk_count", 0)),
            nonce=str(item.get("nonce", "")),
            wrapped_key=str(item.get("wrapped_key", "")),
            scheme=str(item.get("scheme", "")),
        )

    def as_item(self) -> dict[str, Any]:
        """The stored row for this version."""
        return {
            "user_id": self.user_id,
            "profile_key": version_key(self.name, self.version),
            "name": self.name,
            "version": self.version,
            "note": self.note,
            "file_count": self.file_count,
            "total_bytes": self.total_bytes,
            "digest": self.digest,
            "source": self.source,
            "created_at": self.created_at.isoformat(),
            "chunk_count": self.chunk_count,
            "nonce": self.nonce,
            "wrapped_key": self.wrapped_key,
            "scheme": self.scheme,
        }


class AgentProfileRepository:
    """Reads and writes one person's agent profile rows, every method user first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(AGENT_PROFILES, repository)

    def _prefixed(self, user_id: str, prefix: str) -> list[dict[str, Any]]:
        """Every row of one person's partition under one sort key prefix, in key order."""
        condition = Key("user_id").eq(user_id) & Key("profile_key").begins_with(prefix)
        return list(self._repository.iter_query(condition, consistent=True))

    def list_heads(self, user_id: str) -> list[ProfileHead]:
        """Every profile the person keeps, in name order."""
        return [ProfileHead.from_item(item) for item in self._prefixed(user_id, "profile#")]

    def get_head(self, user_id: str, name: str) -> Optional[ProfileHead]:
        """One profile's head, or None when the person keeps no profile by that name."""
        item = self._repository.get({"user_id": user_id, "profile_key": head_key(name)}, consistent=True)
        return ProfileHead.from_item(item) if item is not None else None

    def put_head(self, head: ProfileHead, *, expected_version: Optional[int]) -> None:
        """Write a head only if the latest version is still the one the caller read.

        `expected_version` None means the profile must not exist yet. Raises
        `ConditionFailed` when another save landed in between.
        """
        if expected_version is None:
            condition = Attr("profile_key").not_exists()
        else:
            condition = Attr("latest_version").eq(expected_version)
        self._repository.put(head.as_item(), condition=condition)

    def list_versions(self, user_id: str, name: str) -> list[ProfileVersion]:
        """Every kept version of one profile, oldest first."""
        return [ProfileVersion.from_item(item) for item in self._prefixed(user_id, f"version#{name}#")]

    def get_version(self, user_id: str, name: str, version: int) -> Optional[ProfileVersion]:
        """One kept version's metadata, or None when it is not kept."""
        item = self._repository.get({"user_id": user_id, "profile_key": version_key(name, version)}, consistent=True)
        return ProfileVersion.from_item(item) if item is not None else None

    def create_version(self, version: ProfileVersion, chunks: list[str]) -> None:
        """Claim a version number with its metadata row, then store its chunks.

        The claim comes first so two saves racing for one number cannot overwrite
        each other's chunks: the loser raises `ConditionFailed` before writing any.
        The version is reachable as the latest only once the head names it, which
        the caller writes after this returns.
        """
        self._repository.put(version.as_item(), condition=Attr("profile_key").not_exists())
        self._repository.put_many(
            [
                {
                    "user_id": version.user_id,
                    "profile_key": chunk_key(version.name, version.version, index),
                    "data": chunk,
                }
                for index, chunk in enumerate(chunks)
            ]
        )

    def read_chunks(self, user_id: str, name: str, version: int) -> list[str]:
        """A version's sealed manifest slices, in order."""
        return [str(item.get("data", "")) for item in self._prefixed(user_id, chunk_prefix(name, version))]

    def delete_version(self, user_id: str, name: str, version: int) -> None:
        """Remove one version's metadata row and every chunk of it."""
        keys = [
            {"user_id": user_id, "profile_key": str(item["profile_key"])}
            for item in self._prefixed(user_id, chunk_prefix(name, version))
        ]
        keys.append({"user_id": user_id, "profile_key": version_key(name, version)})
        self._repository.delete_many(keys)

    def delete_profile(self, user_id: str, name: str) -> int:
        """Remove a profile's head, every kept version and every chunk, answering how many rows went."""
        keys = [
            {"user_id": user_id, "profile_key": str(item["profile_key"])}
            for prefix in (f"chunk#{name}#", f"version#{name}#")
            for item in self._prefixed(user_id, prefix)
        ]
        keys.append({"user_id": user_id, "profile_key": head_key(name)})
        return self._repository.delete_many(keys)

    def delete_for_user(self, user_id: str) -> int:
        """Remove every row the person keeps, for account deletion."""
        return delete_partition(self._repository, AGENT_PROFILES, user_id)
