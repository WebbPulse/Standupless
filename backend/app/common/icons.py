"""Custom icons for workspaces, teams and people, stored beside the attachments.

An icon is one image object in the attachments bucket under `icons/`, and the row
it belongs to carries only its key. The key doubles as the public path: a read
model answers `{api}/api/<key>`, and the icon route redirects that path to a
short presigned GET, so rendering an icon costs no AWS call and no credential.

The last segment of every key is a random id, which makes a URL unguessable in
the way a hosted avatar URL is, and replacing an icon mints a new id, so a cached
redirect never shows the old picture under the new key.

Uploads are two calls. The presign call signs a PUT bounded to one allowed image
type and the declared size, under the owner's prefix and a fresh id. The commit
call reads the first bytes back, checks the type, size and magic number, stores
the key on the row and deletes every other object under the owner's prefix,
which also sweeps any upload that was presigned and never committed.
"""

from __future__ import annotations

import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Optional

from fastapi import HTTPException, status
from pydantic import BaseModel, Field
from webbpulse.storage import presigned_get, presigned_put

from app.common.core.config import settings
from app.common.db.dynamo.base import utc_now

ICON_CONTENT_TYPES: dict[str, tuple[bytes, ...]] = {
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/gif": (b"GIF87a", b"GIF89a"),
    "image/webp": (b"RIFF",),
}
"""Every image type an icon may be, with the leading bytes a real file of it starts with.

SVG is left out on purpose: it carries script, and sanitising it is a parser this
service would have to keep safe forever for a format few people pick for an avatar.
"""

MAX_ICON_BYTES = 2 * 1024 * 1024
"""The largest icon accepted, which comfortably holds a 1024 pixel square photo."""

UPLOAD_EXPIRES_IN = 600
"""Seconds a signed icon PUT stays usable, enough for a slow connection and no more."""

SERVE_EXPIRES_IN = 3600
"""Seconds one presigned icon GET stays valid."""

REDIRECT_MAX_AGE = 3000
"""How long a browser may reuse an icon redirect, safely inside `SERVE_EXPIRES_IN`."""

SNIFF_BYTES = 32
"""How many leading bytes the commit reads back to check the magic number."""

_ID = r"[A-Za-z0-9_-]{1,64}"

ICON_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{22}$")
"""The shape `new_icon_id` produces, so a commit can refuse anything else before S3."""

ICON_KEY_PATTERN = re.compile(rf"^icons/(?:workspace/{_ID}|team/{_ID}/{_ID}|user/{_ID})/[A-Za-z0-9_-]{{22}}$")
"""Every key an icon can live under, and nothing else in the bucket."""


class IconUploadCreate(BaseModel):
    """The body an icon presign call takes: the image type and its exact size."""

    content_type: str = Field(min_length=1, max_length=100)
    size_bytes: int = Field(gt=0)


class IconUploadRead(BaseModel):
    """The signed PUT for one icon and the headers it must be sent with."""

    upload_id: str
    url: str
    headers: dict[str, str]
    max_bytes: int
    expires_at: datetime


class IconCommit(BaseModel):
    """The body an icon commit takes: the upload id the presign call returned."""

    upload_id: str = Field(min_length=1, max_length=64)


@dataclass(frozen=True)
class IconOwner:
    """Whose icon is being written, as the key prefix every one of its objects shares."""

    prefix: str

    def key_for(self, upload_id: str) -> str:
        """The object key one upload id names under this owner."""
        return f"{self.prefix}{upload_id}"


def workspace_owner(workspace_id: str) -> IconOwner:
    """The icon owner for one workspace's logo."""
    return IconOwner(f"icons/workspace/{workspace_id}/")


def team_owner(workspace_id: str, team_id: str) -> IconOwner:
    """The icon owner for one team's icon."""
    return IconOwner(f"icons/team/{workspace_id}/{team_id}/")


def workspace_teams_prefix(workspace_id: str) -> str:
    """The prefix every team icon in one workspace shares, for the workspace purge."""
    return f"icons/team/{workspace_id}/"


def user_owner(user_id: str) -> IconOwner:
    """The icon owner for one person's avatar."""
    return IconOwner(f"icons/user/{user_id}/")


def icon_url(key: Optional[str]) -> Optional[str]:
    """The absolute URL a client renders an icon from, or `None` when none is set."""
    if not key:
        return None
    return f"{settings.api_base_url}/api/{key}"


def new_icon_id() -> str:
    """A fresh, unguessable icon id, 22 URL safe characters."""
    return secrets.token_urlsafe(16)


def unprocessable(message: str, error_code: str = "VALIDATION_ERROR") -> HTTPException:
    """A 422 in the product's error shape."""
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail={"error_code": error_code, "message": message},
    )


def icons_bucket() -> str:
    """The bucket icons live in, or a 422 when this function was deployed without one."""
    bucket = settings.ATTACHMENTS_BUCKET.strip()
    if not bucket:
        raise unprocessable("Icon uploads are not configured for this environment")
    return bucket


def normalized_type(content_type: str) -> str:
    """A content type without parameters, lowercased."""
    return content_type.split(";", 1)[0].strip().lower()


def presign_icon(owner: IconOwner, payload: IconUploadCreate) -> IconUploadRead:
    """Sign one bounded icon PUT under the owner's prefix, or refuse the type or size."""
    content_type = normalized_type(payload.content_type)
    if content_type not in ICON_CONTENT_TYPES:
        raise unprocessable("Icons must be PNG, JPEG, GIF or WebP images", "UNSUPPORTED_MEDIA_TYPE")
    if payload.size_bytes > MAX_ICON_BYTES:
        raise unprocessable(f"Icons are limited to {MAX_ICON_BYTES} bytes", "UPLOAD_TOO_LARGE")
    upload_id = new_icon_id()
    upload = presigned_put(
        icons_bucket(),
        owner.key_for(upload_id),
        content_type,
        payload.size_bytes,
        expires_in=UPLOAD_EXPIRES_IN,
        region_name=settings.AWS_REGION or None,
    )
    return IconUploadRead(
        upload_id=upload_id,
        url=upload.url,
        headers=upload.headers,
        max_bytes=upload.max_bytes,
        expires_at=utc_now() + timedelta(seconds=UPLOAD_EXPIRES_IN),
    )


def _client() -> Any:
    """An S3 client in the function's region."""
    import boto3

    return boto3.client("s3", region_name=settings.AWS_REGION or None)


def _matches_magic(content_type: str, head: bytes) -> bool:
    """Whether the leading bytes are what a file of this type starts with."""
    if content_type == "image/webp":
        return head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    return any(head.startswith(magic) for magic in ICON_CONTENT_TYPES.get(content_type, ()))


def verify_upload(owner: IconOwner, upload_id: str) -> str:
    """Check one uploaded icon and return its key, deleting it when it fails a check.

    A missing object is a 409, since the PUT has not landed. An object of the wrong
    type, over the cap, or whose bytes are not the image it claims is a 422, and
    is removed so a rejected file never lingers under the owner's prefix.
    """
    from botocore.exceptions import ClientError

    if not ICON_ID_PATTERN.match(upload_id):
        raise unprocessable("Unknown icon upload", "UNKNOWN_UPLOAD")
    bucket = icons_bucket()
    key = owner.key_for(upload_id)
    try:
        response = _client().get_object(Bucket=bucket, Key=key, Range=f"bytes=0-{SNIFF_BYTES - 1}")
    except ClientError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error_code": "UPLOAD_MISSING", "message": "The icon has not finished uploading"},
        ) from None
    head = response["Body"].read()
    content_type = normalized_type(str(response.get("ContentType") or ""))
    total = _total_size(response, len(head))
    problem = None
    if content_type not in ICON_CONTENT_TYPES:
        problem = unprocessable("Icons must be PNG, JPEG, GIF or WebP images", "UNSUPPORTED_MEDIA_TYPE")
    elif total > MAX_ICON_BYTES:
        problem = unprocessable(f"Icons are limited to {MAX_ICON_BYTES} bytes", "UPLOAD_TOO_LARGE")
    elif not _matches_magic(content_type, head):
        problem = unprocessable("The file is not a valid image", "INVALID_IMAGE")
    if problem is not None:
        delete_icon_objects(owner.prefix, keep=None, only=key)
        raise problem
    return key


def _total_size(response: dict[str, Any], fallback: int) -> int:
    """The whole object's size from a ranged read's `Content-Range`, or what was read."""
    content_range = str(response.get("ContentRange") or "")
    _, _, total = content_range.rpartition("/")
    if total.isdigit():
        return int(total)
    length = response.get("ContentLength")
    return int(length) if isinstance(length, int) else fallback


def delete_icon_objects(prefix: str, *, keep: Optional[str] = None, only: Optional[str] = None) -> int:
    """Delete every version of every icon object under a prefix, returning how many went.

    The bucket is versioned and keeps the newest noncurrent version, so a plain
    delete would only hide an icon; every version and delete marker goes instead.
    `keep` spares the icon just committed, and `only` narrows the sweep to one key.
    Raises when S3 refuses a delete, so a purge step is retried rather than
    reporting a cleanup that did not happen.
    """
    if not prefix.startswith("icons/") or not prefix.endswith("/"):
        raise ValueError(f"Refusing to delete outside an icon prefix: {prefix!r}")
    bucket = settings.ATTACHMENTS_BUCKET.strip()
    if not bucket:
        return 0
    client = _client()
    targets: list[dict[str, str]] = []
    pages = client.get_paginator("list_object_versions").paginate(Bucket=bucket, Prefix=only or prefix)
    for page in pages:
        for entry in [*page.get("Versions", []), *page.get("DeleteMarkers", [])]:
            key = str(entry.get("Key"))
            if key == keep or (only is not None and key != only):
                continue
            targets.append({"Key": key, "VersionId": str(entry.get("VersionId"))})
    for start in range(0, len(targets), 1000):
        response = client.delete_objects(
            Bucket=bucket, Delete={"Objects": targets[start : start + 1000], "Quiet": True}
        )
        errors = response.get("Errors") or []
        if errors:
            raise RuntimeError(f"S3 refused {len(errors)} icon object deletes.")
    return len(targets)


def parse_icon_path(path: str) -> Optional[str]:
    """The object key a public icon path names, or `None` when it is not an icon path."""
    key = f"icons/{path}"
    return key if ICON_KEY_PATTERN.match(key) else None


def presigned_icon_url(key: str) -> str:
    """A short presigned GET for one icon object."""
    return presigned_get(
        icons_bucket(),
        key,
        expires_in=SERVE_EXPIRES_IN,
        region_name=settings.AWS_REGION or None,
    ).url
