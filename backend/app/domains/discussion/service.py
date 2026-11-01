"""Decisions a discussion write needs that a schema cannot make on its own.

Every route here starts from an issue, because the team is not in the path and
the team is what visibility is decided against. `load_visible_issue` is that one
entry point, so a comment, a reaction and an attachment in a team the caller is
outside are all indistinguishable from ones that never existed.

The visibility and authorship rules live in `app.common.discussion_rules`, so
the MCP tools meet the same rule as these routes, and are re-exported here for
the routes that already import them from this module. The upload helpers live in
`app.common.attachment_uploads` for the same reason.
"""

from __future__ import annotations

from app.common.attachment_uploads import attachments_bucket, object_exists, unknown_upload, unprocessable
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
