"""Issue import from CSV: the dry run, and the async job that writes a team's issues a page at a time.

The job and its source file live side by side in the attachments bucket under
`imports/<workspace_id>/<import_id>/`: `job.json` is the job's state and
`source.csv` is the file as uploaded. Keeping the job as an object beside its
file needs no table, and the bucket's lifecycle rule on `imports/` retires both.

A job walks the file in pages of `PAGE_SIZE` rows. Each page is one queue
message carrying the cursor it starts at, and a message whose cursor is not the
job's current one is dropped, so a redelivered or duplicated message never
writes a page twice. Each row's issue id is derived from the import id and the
row's line, so a page that failed halfway and runs again finds the issues it
already wrote and skips them.

Every imported issue carries `import_batch_id`, which the notify consumer, the
GitHub sync stream consumer and the webhook fan-out read as "stay quiet", so a
5000-row import sends no 5000 notifications. Rollups and search still index
the rows.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Literal, Mapping, Optional

from fastapi import HTTPException
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, new_ulid

from app.common.api.dependencies.authz import AuthzContext
from app.common.core.config import settings
from app.common.core.constants import ISSUE_BODY_MAX_BYTES
from app.common.csv_import import (
    CsvRejected,
    ParsedCsv,
    RawRow,
    RowProblem,
    parse_csv,
    read_rows,
    resolve_mapping,
    status_category,
)
from app.common.db.dynamo.base import utc_now

_log = logging.getLogger(__name__)

EVENT_NAME = "issue.import"

IMPORT_PREFIX = "imports/"

JOB_FILE = "job.json"

SOURCE_FILE = "source.csv"

PAGE_SIZE = 100
"""Rows written per queue message, small enough to finish well inside one invocation."""

MAX_PAGE_ATTEMPTS = 3
"""How many times one page may start before the job is marked failed."""

STALE_AFTER = timedelta(minutes=15)
"""How long a queued or running job may go without progress before it is presumed lost."""

LIST_LIMIT = 20

MAX_PROBLEMS = 500
"""Row problems kept on a job, so a file of bad rows cannot grow the job object without bound."""

PREVIEW_PROBLEMS = 200

PREVIEW_ROWS = 10

READY_KIND = "import_ready"
"""The inbox kind that tells the requester the import finished."""

FAILED_KIND = "import_failed"
"""The inbox kind that tells the requester the import stopped."""

LABEL_COLORS: tuple[str, ...] = (
    "#5e6ad2",
    "#26b5ce",
    "#0f783c",
    "#4cb782",
    "#f2c94c",
    "#f2994a",
    "#eb5757",
    "#bb87fc",
    "#95a2b3",
    "#6b6f76",
)
"""Colours a created label is given, picked by its name so a re-run picks the same one."""

IMPORT_REPOSITORIES: tuple[str, ...] = (
    "issues",
    "counters",
    "activity",
    "team_config",
    "subscriptions",
    "inbox",
)
"""What the import job writes: the issues, their keys, activity and subscriptions, new labels and the notice."""

IMPORT_READ_REPOSITORIES: tuple[str, ...] = ("workspaces", "memberships", "users", "teams")
"""What the import job only reads: the team, its members and their accounts."""

ImportStatus = Literal["queued", "running", "completed", "failed"]


class ImportUnavailable(Exception):
    """Imports are not configured in this environment."""


class ImportInProgress(Exception):
    """An import into this workspace is already queued or running."""


class PageRetriesExhausted(Exception):
    """A page started too many times without finishing."""


class ImportJob(BaseModel):
    """One import: who asked, into which team, how the file maps, and how far it has got."""

    import_id: str
    workspace_id: str
    team_id: str
    preset: str
    mapping: dict[str, Optional[str]]
    file_name: str = ""
    status: ImportStatus = "queued"
    requested_by: str
    requester_role: str
    source: str = "web"
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    total_rows: int = 0
    cursor: int = 0
    page_attempts: int = 0
    created_count: int = 0
    skipped_count: int = 0
    labels_created: int = 0
    problems: list[RowProblem] = Field(default_factory=list)
    problems_truncated: bool = False
    error: Optional[str] = None

    def is_active(self, now: datetime) -> bool:
        """Whether this job still blocks a new one: queued or running, and not presumed lost."""
        return self.status in ("queued", "running") and now - self.updated_at < STALE_AFTER


@dataclass
class TeamLookup:
    """One team's statuses, labels and assignable people, read once per page or preview."""

    team: Any
    default_status: Any
    status_by_name: dict[str, Any]
    status_by_category: dict[str, Any]
    labels: dict[str, Any]
    by_email: dict[str, str]
    by_name: dict[str, Optional[str]]
    assignable: dict[str, bool] = field(default_factory=dict)


@dataclass
class ResolvedRow:
    """One row as the issue it becomes, with every problem found on the way."""

    line: int
    title: str
    body: Optional[str]
    status_id: str
    status_name: str
    source_status: str
    priority: str
    assignee_id: Optional[str]
    label_names: list[str]
    estimate: Optional[str]
    due_date: Optional[str]
    external_ref: Optional[str]
    created_at: Optional[datetime]
    problems: list[RowProblem]

    @property
    def importable(self) -> bool:
        """Whether no error stops this row from becoming an issue."""
        return not any(problem.severity == "error" for problem in self.problems)


@dataclass
class Preview:
    """What an import of one file would do, computed without writing anything."""

    headers: list[str]
    mapping: dict[str, Optional[str]]
    total_rows: int
    importable_rows: int
    problems: list[RowProblem]
    problems_truncated: bool
    rows: list[ResolvedRow]
    new_labels: list[str]
    statuses: list[tuple[str, str, int]]


def bucket() -> str:
    """The bucket imports are kept in, raising `ImportUnavailable` when none is set."""
    name = settings.ATTACHMENTS_BUCKET.strip()
    if not name:
        raise ImportUnavailable("Issue imports are not configured for this environment")
    return name


def _s3() -> Any:
    """An S3 client in the configured region."""
    import boto3

    return boto3.client("s3", region_name=settings.AWS_REGION or None)


def job_prefix(workspace_id: str) -> str:
    """The key prefix every import into one workspace shares."""
    return f"{IMPORT_PREFIX}{workspace_id}/"


def job_key(workspace_id: str, import_id: str) -> str:
    """The key of one import's job object."""
    return f"{job_prefix(workspace_id)}{import_id}/{JOB_FILE}"


def source_key(workspace_id: str, import_id: str) -> str:
    """The key of one import's uploaded file."""
    return f"{job_prefix(workspace_id)}{import_id}/{SOURCE_FILE}"


def save_job(job: ImportJob) -> ImportJob:
    """Write one job object, replacing what was there and stamping its progress time."""
    job.updated_at = utc_now()
    _s3().put_object(
        Bucket=bucket(),
        Key=job_key(job.workspace_id, job.import_id),
        Body=job.model_dump_json().encode(),
        ContentType="application/json",
    )
    return job


def load_job(workspace_id: str, import_id: str) -> ImportJob | None:
    """One job, or `None` when it does not exist or belongs to another workspace."""
    from botocore.exceptions import ClientError

    if not workspace_id or not import_id or "/" in import_id:
        return None
    try:
        body = _s3().get_object(Bucket=bucket(), Key=job_key(workspace_id, import_id))["Body"].read()
    except ClientError:
        return None
    job = ImportJob.model_validate_json(body)
    return job if job.workspace_id == workspace_id else None


def list_jobs(workspace_id: str, *, limit: int = LIST_LIMIT) -> list[ImportJob]:
    """A workspace's most recent imports, newest first, by their ULID keys."""
    client = _s3()
    keys: list[str] = []
    for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket(), Prefix=job_prefix(workspace_id)):
        keys.extend(
            str(entry["Key"]) for entry in page.get("Contents", []) if str(entry["Key"]).endswith(f"/{JOB_FILE}")
        )
    jobs: list[ImportJob] = []
    for key in sorted(keys, reverse=True)[:limit]:
        import_id = key[len(job_prefix(workspace_id)) :].split("/", 1)[0]
        job = load_job(workspace_id, import_id)
        if job is not None:
            jobs.append(job)
    return jobs


def _save_source(workspace_id: str, import_id: str, text: str) -> None:
    """Keep the uploaded file beside its job for the pages to read."""
    _s3().put_object(
        Bucket=bucket(),
        Key=source_key(workspace_id, import_id),
        Body=text.encode("utf-8"),
        ContentType="text/csv",
    )


def _load_source(workspace_id: str, import_id: str) -> str:
    """The uploaded file of one import."""
    body = _s3().get_object(Bucket=bucket(), Key=source_key(workspace_id, import_id))["Body"].read()
    return bytes(body).decode("utf-8")


def load_lookup(repositories: Any, workspace_id: str, team_id: str) -> TeamLookup:
    """Read what resolving rows needs from one team: its statuses, labels and members."""
    from app.common.issue_rules import default_status

    team = repositories.teams.get(workspace_id, team_id)
    if team is None:
        raise CsvRejected("The team no longer exists")
    statuses = repositories.team_config.list_statuses(workspace_id, team_id, include_hidden=False)
    by_name: dict[str, Any] = {}
    by_category: dict[str, Any] = {}
    for row in sorted(statuses, key=lambda status: status.position):
        by_name.setdefault(row.name.strip().lower(), row)
        by_category.setdefault(row.category, row)
    labels = {
        row.name.strip().lower(): row
        for row in repositories.team_config.list_labels(workspace_id, team_id, include_hidden=False)
        if not row.is_group
    }
    members = repositories.memberships.list_members(workspace_id, limit=100_000)
    ids = [member.user_id for member in members]
    users: dict[str, Any] = {}
    for start in range(0, len(ids), 100):
        users.update(repositories.users.get_many(ids[start : start + 100]))
    by_email: dict[str, str] = {}
    by_display: dict[str, Optional[str]] = {}
    for user_id in ids:
        user = users.get(user_id)
        if user is None:
            continue
        if user.email:
            by_email[user.email.strip().lower()] = user_id
        name = (user.display_name or "").strip().lower()
        if name:
            by_display[name] = None if name in by_display and by_display[name] != user_id else user_id
    return TeamLookup(
        team=team,
        default_status=default_status(repositories, workspace_id, team_id),
        status_by_name=by_name,
        status_by_category=by_category,
        labels=labels,
        by_email=by_email,
        by_name=by_display,
    )


def _assignable(repositories: Any, lookup: TeamLookup, workspace_id: str, user_id: str) -> bool:
    """Whether one member may hold an issue in the team, asked once per person."""
    from app.common.issue_rules import check_assignee

    if user_id not in lookup.assignable:
        try:
            check_assignee(repositories, workspace_id, lookup.team.team_id, user_id)
            lookup.assignable[user_id] = True
        except HTTPException:
            lookup.assignable[user_id] = False
    return lookup.assignable[user_id]


def _cap_body(text: Optional[str]) -> tuple[Optional[str], bool]:
    """A description held to the size an issue body takes, and whether it was cut."""
    if not text:
        return None, False
    encoded = text.encode("utf-8")
    if len(encoded) <= ISSUE_BODY_MAX_BYTES:
        return text, False
    return encoded[:ISSUE_BODY_MAX_BYTES].decode("utf-8", errors="ignore"), True


def resolve_row(repositories: Any, lookup: TeamLookup, workspace_id: str, raw: RawRow) -> ResolvedRow:
    """Turn one row's raw values into the team's statuses, members, labels and estimate scale."""
    from app.common.issue_rules import check_estimate

    problems = list(raw.problems)
    line = raw.line

    status = lookup.default_status
    if raw.status:
        named = lookup.status_by_name.get(raw.status.strip().lower())
        category = status_category(raw.status)
        if named is not None:
            status = named
        elif category is not None and category in lookup.status_by_category:
            status = lookup.status_by_category[category]
        else:
            problems.append(
                RowProblem(row=line, field="status", message=f"Unknown status {raw.status!r}, put in {status.name}")
            )

    assignee_id: Optional[str] = None
    if raw.assignee:
        wanted = raw.assignee.strip().lower()
        candidate = lookup.by_email.get(wanted) or lookup.by_name.get(wanted)
        if candidate is None:
            problems.append(
                RowProblem(row=line, field="assignee", message=f"No member matches {raw.assignee!r}, left unassigned")
            )
        elif not _assignable(repositories, lookup, workspace_id, candidate):
            problems.append(
                RowProblem(row=line, field="assignee", message=f"{raw.assignee} cannot see this team, left unassigned")
            )
        else:
            assignee_id = candidate

    estimate: Optional[str] = None
    if raw.estimate:
        try:
            estimate = check_estimate(raw.estimate, lookup.team)
        except HTTPException:
            problems.append(
                RowProblem(
                    row=line,
                    field="estimate",
                    message=f"Estimate {raw.estimate!r} is not on this team's scale, left empty",
                )
            )

    body, cut = _cap_body(raw.description)
    if cut:
        problems.append(RowProblem(row=line, field="description", message="The description was cut to fit"))

    return ResolvedRow(
        line=line,
        title=raw.title,
        body=body,
        status_id=status.status_id,
        status_name=status.name,
        source_status=raw.status,
        priority=raw.priority,
        assignee_id=assignee_id,
        label_names=list(raw.labels),
        estimate=estimate,
        due_date=raw.due_date,
        external_ref=raw.source_key,
        created_at=raw.created_at,
        problems=problems,
    )


def preview_import(
    repositories: Any,
    workspace_id: str,
    team_id: str,
    preset: str,
    text: str,
    overrides: Optional[Mapping[str, Optional[str]]] = None,
) -> Preview:
    """Read a whole file against one team and say what an import would do, writing nothing."""
    parsed = parse_csv(text)
    mapping = resolve_mapping(parsed.headers, preset, overrides)
    lookup = load_lookup(repositories, workspace_id, team_id)
    resolved = [resolve_row(repositories, lookup, workspace_id, raw) for raw in read_rows(parsed, mapping)]
    problems = [problem for row in resolved for problem in row.problems]
    new_labels: dict[str, str] = {}
    statuses: dict[tuple[str, str], int] = {}
    for row in resolved:
        if not row.importable:
            continue
        for name in row.label_names:
            if name.lower() not in lookup.labels:
                new_labels.setdefault(name.lower(), name)
        pair = (row.source_status, row.status_name)
        statuses[pair] = statuses.get(pair, 0) + 1
    return Preview(
        headers=list(parsed.headers),
        mapping=mapping,
        total_rows=len(resolved),
        importable_rows=sum(1 for row in resolved if row.importable),
        problems=problems[:PREVIEW_PROBLEMS],
        problems_truncated=len(problems) > PREVIEW_PROBLEMS,
        rows=resolved[:PREVIEW_ROWS],
        new_labels=sorted(new_labels.values(), key=str.lower),
        statuses=[(source, name, count) for (source, name), count in sorted(statuses.items())],
    )


def start_import(
    repositories: Any,
    context: AuthzContext,
    team_id: str,
    preset: str,
    text: str,
    overrides: Optional[Mapping[str, Optional[str]]] = None,
    file_name: str = "",
) -> ImportJob:
    """Queue an import of one file into one team, or run it inline where no queue exists.

    The file is read and mapped up front, so a file that cannot be imported is
    refused with `CsvRejected` before any job exists. Refuses with
    `ImportInProgress` while another import into the workspace is active, and with
    `ImportUnavailable` when the bucket is unset or a deployed environment has no
    queue.
    """
    from app.common.issue_rules import require_team_member

    bucket()
    queue_url = settings.ISSUE_IMPORT_QUEUE_URL.strip()
    if not queue_url and settings.is_production:
        raise ImportUnavailable("Issue imports are not configured for this environment")
    require_team_member(repositories, context, team_id)
    parsed = parse_csv(text)
    mapping = resolve_mapping(parsed.headers, preset, overrides)
    now = utc_now()
    if any(job.is_active(now) for job in list_jobs(context.workspace_id, limit=3)):
        raise ImportInProgress("An import into this workspace is already running")
    import_id = new_ulid()
    _save_source(context.workspace_id, import_id, text)
    job = save_job(
        ImportJob(
            import_id=import_id,
            workspace_id=context.workspace_id,
            team_id=team_id,
            preset=preset,
            mapping=mapping,
            file_name=file_name[:200],
            requested_by=context.user_id,
            requester_role=context.role,
            source=context.source,
            created_at=now,
            total_rows=len(parsed.rows),
        )
    )
    if queue_url:
        enqueue_page(job.workspace_id, job.import_id, 0)
        return job
    return run_inline(repositories, job.workspace_id, job.import_id) or job


def enqueue_page(workspace_id: str, import_id: str, cursor: int) -> None:
    """Queue the page of one import that starts at `cursor`."""
    from webbpulse.events import EventEnvelope, enqueue

    enqueue(
        settings.ISSUE_IMPORT_QUEUE_URL.strip(),
        EventEnvelope(
            name=EVENT_NAME,
            payload={"workspace_id": workspace_id, "import_id": import_id, "cursor": cursor},
            scope=workspace_id,
        ),
    )


def run_inline(repositories: Any, workspace_id: str, import_id: str) -> ImportJob | None:
    """Run every page of one import in this process, for environments with no queue."""
    job = load_job(workspace_id, import_id)
    while job is not None and job.status in ("queued", "running"):
        cursor = job.cursor
        try:
            job = run_page(repositories, workspace_id, import_id, cursor)
        except Exception as exc:
            _log.exception("An issue import failed.", extra={"event": "issue.import.failed", "import_id": import_id})
            current = load_job(workspace_id, import_id)
            return fail(repositories, current, exc) if current is not None else None
        if job is not None and job.cursor == cursor and job.status == "running":
            break
    return job


def handle_page(repositories: Any, workspace_id: str, import_id: str, cursor: int) -> ImportJob | None:
    """Run one queued page and queue the next, letting a failure raise so the queue retries it.

    A page that has started `MAX_PAGE_ATTEMPTS` times without finishing marks the
    job failed instead, so a row that always breaks cannot cycle forever.
    """
    job = load_job(workspace_id, import_id)
    if job is None or job.status not in ("queued", "running") or job.cursor != cursor:
        return job
    if job.page_attempts >= MAX_PAGE_ATTEMPTS:
        return fail(repositories, job, PageRetriesExhausted())
    job = run_page(repositories, workspace_id, import_id, cursor)
    if job is not None and job.status == "running" and job.cursor > cursor:
        enqueue_page(workspace_id, import_id, job.cursor)
    return job


def fail(repositories: Any, job: ImportJob, exc: BaseException) -> ImportJob:
    """Mark a job failed and tell the requester."""
    failed = save_job(
        job.model_copy(update={"status": "failed", "finished_at": utc_now(), "error": type(exc).__name__})
    )
    notify(repositories, failed)
    return failed


def row_issue_id(import_id: str, line: int) -> str:
    """The issue id one row of one import always becomes, so a re-run page finds what it wrote.

    It keeps the import id's time part, so issues still sort by when they were
    made, and fills the rest from a digest of the import and the line.
    """
    alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    digest = int.from_bytes(hashlib.sha256(f"{import_id}:{line}".encode()).digest()[:10], "big")
    tail = "".join(alphabet[(digest >> (5 * index)) & 31] for index in range(16))
    return f"{import_id[:10]}{tail}"


def label_color(name: str) -> str:
    """The colour a created label gets, the same for the same name every time."""
    digest = hashlib.sha256(name.lower().encode()).digest()
    return LABEL_COLORS[digest[0] % len(LABEL_COLORS)]


def _ensure_labels(repositories: Any, job: ImportJob, lookup: TeamLookup, rows: list[ResolvedRow]) -> int:
    """Create the labels a page names that the team lacks, answering how many were made."""
    from app.common.api.schemas.teams import LabelCreate
    from app.common.labels import create_label

    made = 0
    for row in rows:
        if not row.importable:
            continue
        for name in row.label_names:
            if name.lower() in lookup.labels:
                continue
            label = create_label(
                repositories, job.workspace_id, job.team_id, LabelCreate(name=name, color=label_color(name))
            )
            lookup.labels[name.lower()] = label
            made += 1
    return made


def _label_ids(lookup: TeamLookup, row: ResolvedRow) -> list[str]:
    """The ids of the labels one row names, in its order, once each."""
    wanted = (lookup.labels.get(name.lower()) for name in row.label_names)
    return list(dict.fromkeys(label.label_id for label in wanted if label is not None))


def _write_issue(repositories: Any, job: ImportJob, lookup: TeamLookup, row: ResolvedRow) -> bool:
    """Write one row as an issue unless an earlier run already did, answering whether it was new."""
    from app.common.db.dynamo.activity import build_activity
    from app.common.db.dynamo.issues import Issue, issue_key
    from app.common.sla import apply_sla

    issue_id = row_issue_id(job.import_id, row.line)
    if repositories.issues.get(job.workspace_id, issue_id) is not None:
        return False
    number = repositories.counters.allocate_issue_number(job.workspace_id, job.team_id)
    now = utc_now()
    issue = Issue(
        workspace_id=job.workspace_id,
        issue_id=issue_id,
        team_id=job.team_id,
        key=issue_key(lookup.team.key_prefix, number),
        number=number,
        title=row.title,
        body=row.body,
        status_id=row.status_id,
        priority=row.priority,
        assignee_id=row.assignee_id,
        label_ids=_label_ids(lookup, row),
        estimate=row.estimate,
        due_date=row.due_date,
        created_by=job.requested_by,
        created_at=min(row.created_at, now) if row.created_at is not None else now,
        updated_at=now,
        updated_by=job.requested_by,
        updated_source=job.source,
        external_ref=row.external_ref,
        import_batch_id=job.import_id,
    )
    apply_sla(repositories, None, issue)
    try:
        created = repositories.issues.create(issue)
    except ConditionFailed:
        return False
    repositories.activity.record(
        build_activity(job.workspace_id, job.team_id, created.issue_id, job.requested_by, "created", source=job.source)
    )
    if created.assignee_id:
        repositories.subscriptions.subscribe(
            job.workspace_id, created.issue_id, job.team_id, created.assignee_id, "assignee"
        )
    return True


def run_page(repositories: Any, workspace_id: str, import_id: str, cursor: int) -> ImportJob | None:
    """Write the page of rows that starts at `cursor` and move the cursor past it.

    A finished job, or a cursor that is not the job's current one, writes
    nothing, so a duplicate message is harmless. The last page marks the job
    completed and tells the requester.
    """
    job = load_job(workspace_id, import_id)
    if job is None or job.status not in ("queued", "running") or job.cursor != cursor:
        return job
    job = save_job(
        job.model_copy(
            update={
                "status": "running",
                "started_at": job.started_at or utc_now(),
                "page_attempts": job.page_attempts + 1,
            }
        )
    )
    parsed: ParsedCsv = parse_csv(_load_source(workspace_id, import_id))
    lookup = load_lookup(repositories, workspace_id, job.team_id)
    stop = min(cursor + PAGE_SIZE, len(parsed.rows))
    rows = [
        resolve_row(repositories, lookup, workspace_id, raw) for raw in read_rows(parsed, job.mapping, cursor, stop)
    ]
    labels_made = _ensure_labels(repositories, job, lookup, rows)
    created = skipped = 0
    for row in rows:
        if not row.importable:
            skipped += 1
            continue
        _write_issue(repositories, job, lookup, row)
        created += 1
    problems = [*job.problems, *(problem for row in rows for problem in row.problems)]
    done = stop >= len(parsed.rows)
    updated = save_job(
        job.model_copy(
            update={
                "cursor": stop,
                "page_attempts": 0,
                "created_count": job.created_count + created,
                "skipped_count": job.skipped_count + skipped,
                "labels_created": job.labels_created + labels_made,
                "problems": problems[:MAX_PROBLEMS],
                "problems_truncated": job.problems_truncated or len(problems) > MAX_PROBLEMS,
                "status": "completed" if done else "running",
                "finished_at": utc_now() if done else None,
            }
        )
    )
    if done:
        notify(repositories, updated)
    return updated


def notify(repositories: Any, job: ImportJob) -> bool:
    """Put the finished or failed import in the requester's inbox."""
    from app.common.db.dynamo.inbox import Notification, inbox_partition, instant

    team = repositories.teams.get(job.workspace_id, job.team_id)
    name = team.name if team is not None else "the team"
    now = utc_now()
    completed = job.status == "completed"
    plural = "issue" if job.created_count == 1 else "issues"
    notification = Notification(
        ws_user=inbox_partition(job.workspace_id, job.requested_by),
        notification_id=new_ulid(),
        workspace_id=job.workspace_id,
        kind=READY_KIND if completed else FAILED_KIND,
        issue_key=job.import_id,
        issue_title=(
            f"Imported {job.created_count} {plural} into {name}" if completed else f"The import into {name} failed"
        ),
        team_id="",
        actor_id="",
        actor_name="",
        recipient_id=job.requested_by,
        created_at=now,
        unread_at=instant(now),
    )
    return bool(repositories.inbox.create(notification))
