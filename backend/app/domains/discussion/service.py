"""Decisions a discussion write needs that a schema cannot make on its own.

Every route here starts from an issue, because the team is not in the path and
the team is what visibility is decided against. `load_visible_issue` is that one
entry point, so a comment, a reaction and an attachment in a team the caller is
outside are all indistinguishable from ones that never existed.

The visibility and authorship rules live in `app.common.discussion_rules`, so
the MCP tools meet the same rule as these routes, and are re-exported here for
the routes that already import them from this module.
"""

from __future__ import annotations

from fastapi import HTTPException, status

from app.common.core.config import settings
from app.common.discussion_rules import (
    FORBIDDEN,
    NOT_FOUND,
    conflict,
    forbidden,
    is_team_admin,
    load_visible_issue,
    may_delete_comment,
    may_edit_comment,
    not_found,
    require_team_member,
    team_role,
)

__all__ = [
    "FORBIDDEN",
    "NOT_FOUND",
    "attachments_bucket",
    "conflict",
    "delete_objects",
    "forbidden",
    "is_team_admin",
    "load_visible_issue",
    "may_delete_comment",
    "may_edit_comment",
    "not_found",
    "object_exists",
    "require_team_member",
    "team_role",
    "unknown_upload",
    "unprocessable",
]


def unprocessable(message: str, error_code: str = "VALIDATION_ERROR") -> HTTPException:
    """A 422 carrying one of the contract's own error codes.

    The code is a parameter because M3 adds `UNSUPPORTED_MEDIA_TYPE` and
    `UPLOAD_TOO_LARGE` beside the platform envelope's own, and a client
    distinguishes them by code rather than by message.
    """
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail={"error_code": error_code, "message": message},
    )


def unknown_upload() -> HTTPException:
    """The 404 a commit naming a ticket this caller did not mint gets.

    One answer for an absent ticket, an expired one and one minted for another
    caller or another issue, so a commit cannot be used to probe for tickets.
    """
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"error_code": "UNKNOWN_UPLOAD", "message": "No such upload"},
    )


def attachments_bucket() -> str:
    """The bucket attachments are presigned against, or a 422 when none is set.

    Fails closed rather than guessing a name: a function deployed without the
    bucket or without its IAM grant refuses to sign, instead of handing out a URL
    that S3 rejects after the client has read the whole file.
    """
    bucket = settings.ATTACHMENTS_BUCKET.strip()
    if not bucket:
        raise unprocessable("File uploads are not configured for this environment")
    return bucket


def object_exists(bucket: str, key: str) -> bool:
    """Whether one object is really in the bucket.

    The commit route's guard, so recording an attachment for an upload that never
    happened is a 409 rather than a row pointing at nothing. `webbpulse.storage`
    presigns but does not read, and a `HeadObject` is the one S3 call this service
    makes itself; anything beyond it belongs upstream rather than here.

    Any error that is not a plain absence is treated as absence too, because the
    only use of this answer is whether to record a row, and recording one on an
    inconclusive read is the worse failure.
    """
    import boto3
    from botocore.exceptions import ClientError

    client = boto3.client("s3", region_name=settings.AWS_REGION or None)
    try:
        client.head_object(Bucket=bucket, Key=key)
    except ClientError:
        return False
    return True


def delete_objects(bucket: str, keys: list[str]) -> None:
    """Delete every version of some attachment objects, raising when S3 refuses one.

    The team purge's one S3 write. Every version goes, delete markers included,
    because the bucket is versioned and its lifecycle keeps the newest noncurrent
    version, so a plain delete would only hide the file. It raises rather than
    reporting, so the rows pointing at a refused object stay and a redelivery
    retries the pair.
    """
    if not keys:
        return
    import boto3

    client = boto3.client("s3", region_name=settings.AWS_REGION or None)
    wanted = set(keys)
    targets: list[dict[str, str]] = []
    for key in sorted(wanted):
        pages = client.get_paginator("list_object_versions").paginate(Bucket=bucket, Prefix=key)
        for page in pages:
            for entry in [*page.get("Versions", []), *page.get("DeleteMarkers", [])]:
                if entry.get("Key") == key:
                    targets.append({"Key": key, "VersionId": str(entry.get("VersionId"))})
    for start in range(0, len(targets), 1000):
        response = client.delete_objects(
            Bucket=bucket,
            Delete={"Objects": targets[start : start + 1000], "Quiet": True},
        )
        errors = response.get("Errors") or []
        if errors:
            raise RuntimeError(f"S3 refused {len(errors)} attachment object deletes.")
