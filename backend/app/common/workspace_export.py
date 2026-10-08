"""Whole-workspace export: an admin's async job that writes every entity to one zip in S3.

The job and its bundle live side by side in the attachments bucket under
`exports/<workspace_id>/<export_id>/`: `job.json` is the job's state and
`bundle.zip` is the result. Keeping the job as an object beside its bundle needs
no table, and the bucket's lifecycle rule on `exports/` is the one retention
mechanism for both.

The bundle is a zip of `manifest.json` plus one NDJSON file per entity, the
format `docs/api/export.md` documents under `format_version`. The walk reads
every team in a fixed order and every issue by number through the same
key-bounded reads the CSV export uses, and every other list a page at a time,
so a workspace of any size costs the same per row. Each entity is spooled to
its own file on local disk while the walk runs and zipped once at the end, so
memory stays flat however large the workspace is.

The walk sees what the requester sees: a private team the requester is outside
is listed with `content_included` false and none of its content, the same rule
every read route applies to a workspace admin.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Iterator, Literal, Mapping, Optional

from pydantic import BaseModel, Field
from webbpulse.dynamodb import new_ulid

from app.common.api.dependencies.authz import AuthzContext
from app.common.core.config import settings
from app.common.db.dynamo.base import utc_now

_log = logging.getLogger(__name__)

FORMAT_VERSION = 1
"""The bundle format's version, raised on any change a reader would have to know about."""

EVENT_NAME = "workspace.export"

EXPORT_PREFIX = "exports/"

JOB_FILE = "job.json"

BUNDLE_FILE = "bundle.zip"

RETENTION_DAYS = 7
"""How long a finished bundle is kept, which the bucket's lifecycle rule on `exports/` enforces."""

DOWNLOAD_EXPIRES_IN = 900
"""Seconds the bundle's download link stays valid; a later read of the job mints a fresh one."""

ATTACHMENT_URL_EXPIRES_IN = 6 * 3600
"""Seconds each attachment file's link inside the bundle stays valid after the export finishes."""

STALE_AFTER = timedelta(hours=1)
"""How long a queued or running job blocks a new one before it is presumed lost."""

LIST_LIMIT = 20

READ_CHUNK = 200

ADMIN_ROLES = frozenset({"owner", "admin"})

READY_KIND = "export_ready"
"""The inbox kind that tells the requester the bundle is ready to download."""

FAILED_KIND = "export_failed"
"""The inbox kind that tells the requester the export could not be built."""

ENTITY_FILES: tuple[str, ...] = (
    "teams",
    "members",
    "team_members",
    "statuses",
    "labels",
    "issues",
    "relations",
    "comments",
    "attachments",
    "projects",
    "milestones",
    "project_updates",
    "cycles",
    "views",
    "releases",
)
"""Every NDJSON file in a bundle, in the order the manifest lists them."""

EXPORT_REPOSITORIES: tuple[str, ...] = ("inbox",)
"""What the export writes: only the requester's inbox notice."""

EXPORT_READ_REPOSITORIES: tuple[str, ...] = (
    "workspaces",
    "memberships",
    "users",
    "teams",
    "team_config",
    "issues",
    "relations",
    "comments",
    "attachments",
    "planning",
    "releases",
    "views",
)
"""Everything the export reads, which is every table a bundle has a file for."""

ExportStatus = Literal["queued", "running", "ready", "failed"]


class ExportUnavailable(Exception):
    """Exports are not configured in this environment."""


class ExportInProgress(Exception):
    """An export of this workspace is already queued or running."""


class ExportJob(BaseModel):
    """One export: who asked, what state it is in, and what it produced."""

    export_id: str
    workspace_id: str
    status: ExportStatus = "queued"
    format_version: int = FORMAT_VERSION
    requested_by: str
    requester_role: str
    team_ids: list[str] = Field(default_factory=list)
    private_team_ids: list[str] = Field(default_factory=list)
    emails_masked: bool = False
    created_at: datetime = Field(default_factory=utc_now)
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    size_bytes: int = 0
    counts: dict[str, int] = Field(default_factory=dict)
    error: Optional[str] = None

    def context(self) -> AuthzContext:
        """The requester as authorization saw them when they asked."""
        return AuthzContext(
            workspace_id=self.workspace_id,
            user_id=self.requested_by,
            role=self.requester_role,
            team_ids=tuple(self.team_ids),
            private_team_ids=tuple(self.private_team_ids),
        )

    def is_active(self, now: datetime) -> bool:
        """Whether this job still blocks a new one: queued or running, and not presumed lost."""
        return self.status in ("queued", "running") and now - self.created_at < STALE_AFTER


@dataclass(frozen=True)
class Download:
    """A presigned link to one finished bundle."""

    url: str
    expires_at: datetime


def bucket() -> str:
    """The bucket exports are written to, raising `ExportUnavailable` when none is set."""
    name = settings.ATTACHMENTS_BUCKET.strip()
    if not name:
        raise ExportUnavailable("Workspace exports are not configured for this environment")
    return name


def _s3() -> Any:
    """An S3 client in the configured region."""
    import boto3

    return boto3.client("s3", region_name=settings.AWS_REGION or None)


def job_prefix(workspace_id: str) -> str:
    """The key prefix every export of one workspace shares."""
    return f"{EXPORT_PREFIX}{workspace_id}/"


def job_key(workspace_id: str, export_id: str) -> str:
    """The key of one export's job object."""
    return f"{job_prefix(workspace_id)}{export_id}/{JOB_FILE}"


def bundle_key(workspace_id: str, export_id: str) -> str:
    """The key of one export's bundle."""
    return f"{job_prefix(workspace_id)}{export_id}/{BUNDLE_FILE}"


def save_job(job: ExportJob) -> ExportJob:
    """Write one job object, replacing what was there."""
    _s3().put_object(
        Bucket=bucket(),
        Key=job_key(job.workspace_id, job.export_id),
        Body=job.model_dump_json().encode(),
        ContentType="application/json",
    )
    return job


def load_job(workspace_id: str, export_id: str) -> ExportJob | None:
    """One job, or `None` when it does not exist or belongs to another workspace."""
    from botocore.exceptions import ClientError

    if not workspace_id or not export_id or "/" in export_id:
        return None
    try:
        body = _s3().get_object(Bucket=bucket(), Key=job_key(workspace_id, export_id))["Body"].read()
    except ClientError:
        return None
    job = ExportJob.model_validate_json(body)
    return job if job.workspace_id == workspace_id else None


def list_jobs(workspace_id: str, *, limit: int = LIST_LIMIT) -> list[ExportJob]:
    """A workspace's most recent exports, newest first.

    Export ids are ULIDs, so the keys list in creation order and the newest are
    the last ones listed.
    """
    client = _s3()
    keys: list[str] = []
    for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket(), Prefix=job_prefix(workspace_id)):
        keys.extend(
            str(entry["Key"]) for entry in page.get("Contents", []) if str(entry["Key"]).endswith(f"/{JOB_FILE}")
        )
    jobs: list[ExportJob] = []
    for key in sorted(keys, reverse=True)[:limit]:
        export_id = key[len(job_prefix(workspace_id)) :].split("/", 1)[0]
        job = load_job(workspace_id, export_id)
        if job is not None:
            jobs.append(job)
    return jobs


def download_for(job: ExportJob) -> Download | None:
    """A fresh short-lived link to a finished bundle, or `None` while it is not ready."""
    from webbpulse.storage import presigned_get

    if job.status != "ready":
        return None
    download = presigned_get(
        bucket(),
        bundle_key(job.workspace_id, job.export_id),
        DOWNLOAD_EXPIRES_IN,
        response_content_type="application/zip",
        response_content_disposition=f'attachment; filename="standupless-export-{job.export_id}.zip"',
        region_name=settings.AWS_REGION,
    )
    return Download(url=download.url, expires_at=utc_now() + timedelta(seconds=download.expires_in))


def masks_emails(role: str, include_emails: bool) -> bool:
    """Whether a bundle for this requester carries masked member emails.

    Only a workspace owner or admin may see addresses, and even they may ask for
    a bundle without them to share it more widely.
    """
    return not (include_emails and role in ADMIN_ROLES)


def mask_email(email: str) -> str:
    """An address reduced to its first character and its domain, such as `t***@example.com`."""
    local, at, domain = email.partition("@")
    if not at:
        return "***"
    return f"{local[:1]}***@{domain}"


def start_export(context: AuthzContext, *, include_emails: bool = True) -> ExportJob:
    """Queue an export of the caller's workspace, or build it inline where no queue exists.

    Refuses with `ExportInProgress` while another export of the workspace is
    queued or running, and with `ExportUnavailable` when the bucket is unset, or
    when a deployed environment has no queue, since building inline there would
    run inside a request's time limit and outside the export function's grants.
    """
    bucket()
    queue_url = settings.WORKSPACE_EXPORT_QUEUE_URL.strip()
    if not queue_url and settings.is_production:
        raise ExportUnavailable("Workspace exports are not configured for this environment")
    now = utc_now()
    if any(job.is_active(now) for job in list_jobs(context.workspace_id, limit=3)):
        raise ExportInProgress("An export of this workspace is already running")
    job = save_job(
        ExportJob(
            export_id=new_ulid(),
            workspace_id=context.workspace_id,
            requested_by=context.user_id,
            requester_role=context.role,
            team_ids=list(context.team_ids),
            private_team_ids=list(context.private_team_ids),
            emails_masked=masks_emails(context.role, include_emails),
            created_at=now,
        )
    )
    if queue_url:
        from webbpulse.events import EventEnvelope, enqueue

        enqueue(
            queue_url,
            EventEnvelope(
                name=EVENT_NAME,
                payload={"workspace_id": job.workspace_id, "export_id": job.export_id},
                scope=job.workspace_id,
            ),
        )
        return job
    from app.common.api.dependencies.repositories import build_bundle

    bundle = build_bundle(
        (*EXPORT_REPOSITORIES, *EXPORT_READ_REPOSITORIES), name="workspace-export", read_only=EXPORT_READ_REPOSITORIES
    )
    return run_export(bundle, job.workspace_id, job.export_id) or job


def run_export(repositories: Any, workspace_id: str, export_id: str) -> ExportJob | None:
    """Build one queued export, upload it and tell the requester, reporting the finished job.

    A job already finished is left alone, so a redelivered message builds nothing
    twice. A failure marks the job failed and tells the requester rather than
    raising, because a retry would rebuild a whole workspace for an error that is
    usually not transient.
    """
    job = load_job(workspace_id, export_id)
    if job is None or job.status in ("ready", "failed"):
        return job
    job = save_job(job.model_copy(update={"status": "running", "started_at": utc_now()}))
    try:
        with tempfile.TemporaryDirectory(prefix="export-") as scratch:
            archive, counts = build_bundle_file(repositories, job, scratch)
            size = os.path.getsize(archive)
            _s3().upload_file(
                archive,
                bucket(),
                bundle_key(workspace_id, export_id),
                ExtraArgs={"ContentType": "application/zip"},
            )
    except Exception as exc:
        _log.exception(
            "A workspace export failed.", extra={"event": "workspace.export.failed", "export_id": export_id}
        )
        failed = save_job(
            job.model_copy(
                update={"status": "failed", "finished_at": utc_now(), "error": type(exc).__name__}
            )
        )
        notify(repositories, failed)
        return failed
    finished = utc_now()
    ready = save_job(
        job.model_copy(
            update={
                "status": "ready",
                "finished_at": finished,
                "expires_at": finished + timedelta(days=RETENTION_DAYS),
                "size_bytes": size,
                "counts": counts,
            }
        )
    )
    notify(repositories, ready)
    return ready


def notify(repositories: Any, job: ExportJob) -> bool:
    """Put the finished export in the requester's inbox."""
    from app.common.db.dynamo.inbox import Notification, inbox_partition, instant

    workspace = repositories.workspaces.get(job.workspace_id)
    name = workspace.name if workspace is not None else "your workspace"
    now = utc_now()
    ready = job.status == "ready"
    notification = Notification(
        ws_user=inbox_partition(job.workspace_id, job.requested_by),
        notification_id=new_ulid(),
        workspace_id=job.workspace_id,
        kind=READY_KIND if ready else FAILED_KIND,
        issue_key=job.export_id,
        issue_title=f"The export of {name} is ready to download" if ready else f"The export of {name} failed",
        team_id="",
        actor_id="",
        actor_name="",
        recipient_id=job.requested_by,
        created_at=now,
        unread_at=instant(now),
    )
    return bool(repositories.inbox.create(notification))


@dataclass
class _Writer:
    """One NDJSON file per entity under a scratch directory, counting the rows written."""

    root: str
    handles: dict[str, Any] = field(default_factory=dict)
    counts: dict[str, int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        """Open every entity file, so an empty entity still ships as an empty file."""
        for name in ENTITY_FILES:
            self.handles[name] = open(os.path.join(self.root, f"{name}.ndjson"), "w", encoding="utf-8")
            self.counts[name] = 0

    def write(self, name: str, row: Mapping[str, Any]) -> None:
        """Append one row to one entity's file."""
        self.handles[name].write(json.dumps(row, ensure_ascii=False, sort_keys=True, default=str))
        self.handles[name].write("\n")
        self.counts[name] += 1

    def close(self) -> None:
        """Flush and close every file."""
        for handle in self.handles.values():
            handle.close()


STORAGE_KEYS = frozenset(
    {"ws_issue", "ws_user", "ws_author", "ws_target", "planning_key", "relation_key", "member_key"}
)
"""Composite key attributes that only exist to index a row, which a reader of the bundle never needs."""


def _dump(model: BaseModel, *drop: str) -> dict[str, Any]:
    """One stored row as plain JSON, without its storage-only attributes."""
    row = model.model_dump(mode="json")
    for name in (*STORAGE_KEYS, *drop):
        row.pop(name, None)
    return row


def _paged(read: Any) -> Iterator[Any]:
    """Every row of a `(rows, last_key)` paged read, one page at a time."""
    start: Mapping[str, Any] | None = None
    while True:
        rows, start = read(start)
        yield from rows
        if not start:
            return


def _page_items(read: Any) -> Iterator[Mapping[str, Any]]:
    """Every item of a `Page` returning read, one page at a time."""
    start: Mapping[str, Any] | None = None
    while True:
        page = read(start)
        yield from page.items
        start = page.last_evaluated_key
        if not start:
            return


def build_bundle_file(repositories: Any, job: ExportJob, scratch: str) -> tuple[str, dict[str, int]]:
    """Write one workspace's bundle into `scratch`, answering with the zip's path and the row counts."""
    entities = os.path.join(scratch, "entities")
    os.makedirs(entities)
    writer = _Writer(entities)
    try:
        attachment_links_expire = _walk(repositories, job, writer)
    finally:
        writer.close()
    workspace = repositories.workspaces.get(job.workspace_id)
    manifest = {
        "format_version": FORMAT_VERSION,
        "export_id": job.export_id,
        "exported_at": utc_now().isoformat(),
        "requested_by": job.requested_by,
        "emails_masked": job.emails_masked,
        "attachment_links_expire_at": attachment_links_expire.isoformat(),
        "workspace": {
            "id": job.workspace_id,
            "name": workspace.name if workspace is not None else "",
            "slug": workspace.slug if workspace is not None else "",
        },
        "files": [{"name": f"{name}.ndjson", "rows": writer.counts[name]} for name in ENTITY_FILES],
    }
    archive = os.path.join(scratch, BUNDLE_FILE)
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr("manifest.json", json.dumps(manifest, indent=2, sort_keys=True))
        for name in ENTITY_FILES:
            bundle.write(os.path.join(entities, f"{name}.ndjson"), f"{name}.ndjson")
    return archive, dict(writer.counts)


def _walk(repositories: Any, job: ExportJob, writer: _Writer) -> datetime:
    """Read every entity of the workspace into `writer`, answering when the attachment links expire."""
    from app.common.issue_keys import current

    workspace_id = job.workspace_id
    context = job.context()
    teams = repositories.teams.list_for_workspace(workspace_id, limit=10_000)
    visible = [team for team in teams if context.can_see_team(team.team_id)]
    visible_ids = {team.team_id for team in visible}
    for team in teams:
        if context.can_find_team(team.team_id):
            writer.write("teams", {**_dump(team), "content_included": team.team_id in visible_ids})

    _members(repositories, job, writer, visible_ids)

    for status in repositories.team_config.list_workspace_statuses(workspace_id, limit=1000):
        writer.write("statuses", _dump(status))
    for label in repositories.team_config.list_workspace_labels(workspace_id, limit=1000):
        writer.write("labels", _dump(label))

    links_expire = utc_now() + timedelta(seconds=ATTACHMENT_URL_EXPIRES_IN)
    relation_ids: set[str] = set()
    for team in visible:
        team_id = team.team_id
        for status in repositories.team_config.list_statuses(workspace_id, team_id, limit=1000):
            if status.team_id == team_id and status.scope != "workspace":
                writer.write("statuses", _dump(status))
        for label in repositories.team_config.list_labels(workspace_id, team_id, limit=1000):
            if label.team_id == team_id and label.scope != "workspace":
                writer.write("labels", _dump(label))
        after = 0
        while True:
            issues = repositories.issues.page_after(workspace_id, team_id, after, limit=READ_CHUNK)
            if not issues:
                break
            for issue in issues:
                _issue(repositories, writer, current(repositories.teams, issue), relation_ids)
            after = issues[-1].number
        for cycle in _paged(
            lambda start, team_id=team_id: repositories.planning.list_cycles(
                workspace_id, team_id, limit=READ_CHUNK, start_key=start
            )
        ):
            writer.write("cycles", _dump(cycle))
        for release in _paged(
            lambda start, team_id=team_id: repositories.releases.list_for_team(
                workspace_id, team_id, limit=READ_CHUNK, start_key=start
            )
        ):
            writer.write("releases", _dump(release))
        for view in repositories.views.list_for_team(workspace_id, team_id, limit=10_000):
            writer.write("views", _dump(view))
    for view in repositories.views.list_personal(workspace_id, job.requested_by, limit=10_000):
        writer.write("views", _dump(view))

    _projects(repositories, job, writer, visible_ids)
    _attachments(repositories, job, writer, visible, links_expire)
    return links_expire


def _members(repositories: Any, job: ExportJob, writer: _Writer, visible_ids: set[str]) -> None:
    """The workspace's members joined with their accounts, and every visible team membership."""
    workspace_id = job.workspace_id
    members = repositories.memberships.list_members(workspace_id, limit=100_000)
    ids = [member.user_id for member in members]
    users: dict[str, Any] = {}
    for start in range(0, len(ids), 100):
        users.update(repositories.users.get_many(ids[start : start + 100]))
    for member in members:
        user = users.get(member.user_id)
        email = user.email if user is not None else ""
        writer.write(
            "members",
            {
                "user_id": member.user_id,
                "role": member.role,
                "joined_at": member.joined_at.isoformat(),
                "display_name": user.display_name if user is not None else "",
                "email": mask_email(email) if job.emails_masked and email else email,
            },
        )
    for membership in repositories.memberships.list_all_team_memberships(workspace_id, limit=1_000_000):
        if membership.team_id in visible_ids:
            writer.write(
                "team_members",
                {
                    "team_id": membership.team_id,
                    "user_id": membership.user_id,
                    "role": membership.role,
                    "joined_at": membership.joined_at.isoformat(),
                },
            )


def _issue(repositories: Any, writer: _Writer, issue: Any, relation_ids: set[str]) -> None:
    """One issue with its relations and its comments."""
    from app.common.db.dynamo.comments import as_comment

    workspace_id = issue.workspace_id
    writer.write("issues", _dump(issue))
    for relation in repositories.relations.list_for_issue(workspace_id, issue.issue_id, limit=10_000):
        if relation.link_id in relation_ids:
            continue
        relation_ids.add(relation.link_id)
        writer.write("relations", _dump(relation))
    for item in _page_items(
        lambda start: repositories.comments.list_for_issue(
            workspace_id, issue.issue_id, limit=READ_CHUNK, start_key=start
        )
    ):
        writer.write("comments", _dump(as_comment(item)))


def _projects(repositories: Any, job: ExportJob, writer: _Writer, visible_ids: set[str]) -> None:
    """Every project in a visible team, with its milestones and updates."""
    workspace_id = job.workspace_id
    for project in repositories.planning.list_projects(workspace_id, max_items=100_000):
        if not any(team_id in visible_ids for team_id in project.team_ids):
            continue
        writer.write("projects", _dump(project))
        for milestone in repositories.planning.list_milestones(workspace_id, project.project_id, max_items=100_000):
            writer.write("milestones", _dump(milestone))
        for update in _paged(
            lambda start, project_id=project.project_id: repositories.planning.list_project_updates(
                workspace_id, project_id, limit=READ_CHUNK, start_key=start
            )
        ):
            writer.write("project_updates", _dump(update))


def _attachments(
    repositories: Any, job: ExportJob, writer: _Writer, visible: list[Any], links_expire: datetime
) -> None:
    """Every attachment's metadata, with a presigned link for each uploaded file.

    Read in a second pass over the issues so the walk above never needs the
    bucket, and files are listed rather than inlined, so the bundle's size is
    the workspace's text and not its uploads.
    """
    from webbpulse.storage import disposition_for, presigned_get

    from app.common.db.dynamo.attachments import Attachment

    workspace_id = job.workspace_id
    for team in visible:
        after = 0
        while True:
            issues = repositories.issues.page_after(workspace_id, team.team_id, after, limit=READ_CHUNK)
            if not issues:
                break
            for issue in issues:
                for item in _page_items(
                    lambda start, issue_id=issue.issue_id: repositories.attachments.list_for_issue(
                        workspace_id, issue_id, limit=READ_CHUNK, start_key=start
                    )
                ):
                    attachment = Attachment.model_validate(dict(item))
                    row = _dump(attachment, "s3_key")
                    if attachment.s3_key:
                        content_type = attachment.content_type or "application/octet-stream"
                        link = presigned_get(
                            bucket(),
                            attachment.s3_key,
                            ATTACHMENT_URL_EXPIRES_IN,
                            response_content_type=content_type,
                            response_content_disposition=disposition_for(content_type, attachment.title),
                            region_name=settings.AWS_REGION,
                        )
                        row["download_url"] = link.url
                        row["download_url_expires_at"] = links_expire.isoformat()
                        row["download_path"] = (
                            f"/api/workspaces/{workspace_id}/attachments/{attachment.attachment_id}"
                            f"/download?issue_id={attachment.issue_id}"
                        )
                    writer.write("attachments", row)
            after = issues[-1].number
