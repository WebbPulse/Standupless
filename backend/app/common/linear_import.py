"""Import from a Linear workspace through Linear's API, a page at a time on the issue import queue.

A Linear import is an `ImportJob` of kind `linear`, so it shares the CSV
importer's job object, queue, page retries, stale job detection and inbox notice.
What differs is the source: instead of a stored file, each queue message reads
one page of one Linear connection and writes what it found. The job walks a
fixed list of phases, per mapped team its cycles, its projects with their
milestones and updates, its issues with their comments, and then a second walk
over the issues for sub-issue and relation links, and finally the workspace's
initiatives and the dependencies between its projects. `phase_index` and
`after` say where it is, and `cursor` counts the steps so the queue's
duplicate guard works unchanged.

Every row an import writes gets an id derived from the workspace and the Linear
id, with the Linear creation time as its time part, so a step that runs twice,
and a later import of the same Linear workspace, finds the rows already written
and updates them rather than writing them again. Each issue's `external_ref`
carries its Linear identifier and URL.

The personal API key the admin pasted is sealed beside the job in `key.json`,
bound to the workspace and import, and is the only copy kept. It is opened in
memory for each step, deleted when the job completes, fails or is cancelled,
and never written to the job, a log, an audit row or any imported data. A key
left behind by a job that was lost goes with the bucket's lifecycle rule on
`imports/`.

People are matched to members by email. A comment or project update whose author
is not a member is written under a `linear:<name>` placeholder, and no account
or invite is ever created.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Optional

from fastapi import HTTPException
from pydantic import BaseModel
from webbpulse.dynamodb import ConditionFailed

from app.common.core.config import settings
from app.common.core.constants import ISSUE_BODY_MAX_BYTES
from app.common.csv_import import RowProblem, parse_datetime
from app.common.date_resolution import DateEdge, DateResolution, snap
from app.common.db.dynamo.base import utc_now
from app.common.linear_api import (
    CYCLES_QUERY,
    INITIATIVES_QUERY,
    ISSUE_COMMENTS_QUERY,
    ISSUE_LINKS_QUERY,
    ISSUES_QUERY,
    PROJECT_MILESTONES_QUERY,
    PROJECT_RELATIONS_QUERY,
    PROJECT_UPDATES_QUERY,
    PROJECTS_QUERY,
    LinearAuthFailed,
    LinearClient,
    LinearError,
    LinearRateLimited,
    Page,
)

_log = logging.getLogger(__name__)

KEY_FILE = "key.json"

KEY_INFO = b"standupless.linear-import-key.v1"

SEAL_PURPOSE = "linear_import_key"

LINEAR_AUTHOR_PREFIX = "linear:"
"""The author id prefix of a comment or update whose Linear author matched no member."""

PRESET = "linear_api"

TEAM_PHASES: tuple[str, ...] = ("cycles", "projects", "issues", "links")
"""What one mapped team's walk reads, in order: what issues point at comes before the issues."""

COUNT_NAMES: tuple[str, ...] = (
    "issues_created",
    "issues_updated",
    "comments",
    "labels",
    "cycles",
    "projects",
    "milestones",
    "project_updates",
    "initiatives",
    "sub_issues",
    "relations",
    "project_relations",
)
"""The tallies a Linear import keeps, which the status read and the summary show."""

PRIORITY_BY_NUMBER: dict[int, str] = {0: "none", 1: "urgent", 2: "high", 3: "medium", 4: "low"}

CATEGORY_BY_STATE_TYPE: dict[str, str] = {
    "triage": "backlog",
    "backlog": "backlog",
    "unstarted": "unstarted",
    "started": "started",
    "completed": "completed",
    "canceled": "cancelled",
    "cancelled": "cancelled",
}
"""Linear's workflow state types as the status categories a Standupless team groups its statuses in."""

PROJECT_STATUS_BY_TYPE: dict[str, str] = {
    "backlog": "backlog",
    "planned": "planned",
    "started": "in_progress",
    "paused": "paused",
    "completed": "completed",
    "canceled": "canceled",
    "cancelled": "canceled",
}

HEALTH_BY_LINEAR: dict[str, str] = {"ontrack": "on_track", "atrisk": "at_risk", "offtrack": "off_track"}

INITIATIVE_STATUSES = frozenset({"planned", "active", "completed"})

RELATION_TYPES: dict[str, str] = {"blocks": "blocks", "related": "relates_to", "duplicate": "duplicate_of"}
"""Linear's issue relation types as Standupless link types. Linear's `similar` has no counterpart."""

TRANSIENT_CODES = frozenset({"unreachable", "unavailable"})
"""Linear failures a page retry can fix, which an optional phase passes on rather than skips."""

PROJECT_DEPENDENCY_TYPES = frozenset({"dependency", "blocks"})
"""The Linear project relation types that are a dependency between two projects."""

WORKSPACE_PHASES: tuple[str, ...] = ("initiatives", "project_relations")
"""What the import reads once for the workspace after every team: dependencies need every project written."""

CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


class LinearTeamMapping(BaseModel):
    """One Linear team an import reads and the Standupless team it writes into."""

    linear_team_id: str
    linear_key: str = ""
    name: str = ""
    team_id: str


class KeyGone(Exception):
    """The sealed key of a running import is missing, so the import cannot go on."""


def _cipher() -> Any:
    """The cipher import keys are sealed with, keyed from the environment master key."""
    from webbpulse.identity.crypto import SecretMasterKeyCipher
    from webbpulse.security import expand_key

    master = settings.WEBHOOK_SIGNING_KEY
    if not master:
        raise KeyGone()
    return SecretMasterKeyCipher(expand_key(hashlib.sha256(master.encode()).digest(), KEY_INFO, 32))


def can_seal() -> bool:
    """Whether this environment has the master key a pasted Linear key is sealed with."""
    return bool(settings.WEBHOOK_SIGNING_KEY)


def _bound_to(workspace_id: str, import_id: str) -> str:
    """What a sealed key is bound to, so a copy beside another import never opens."""
    return f"{workspace_id}:{import_id}"


def key_key(workspace_id: str, import_id: str) -> str:
    """The object key of one import's sealed Linear key."""
    from app.common.issue_import import job_prefix

    return f"{job_prefix(workspace_id)}{import_id}/{KEY_FILE}"


def seal_key(workspace_id: str, import_id: str, api_key: str, *, purpose: str = SEAL_PURPOSE) -> None:
    """Seal one import's key and keep it beside the job, the only copy that outlives the request.

    Another API importer passes its own `purpose`, so a token sealed for one
    source never opens as another's.
    """
    from app.common.issue_import import _s3, bucket

    sealed = _cipher().seal(api_key.encode(), user_id=_bound_to(workspace_id, import_id), purpose=purpose)
    body = {
        "ciphertext": sealed.ciphertext,
        "nonce": sealed.nonce,
        "wrapped_key": sealed.wrapped_key,
        "scheme": sealed.scheme,
    }
    _s3().put_object(
        Bucket=bucket(),
        Key=key_key(workspace_id, import_id),
        Body=json.dumps(body).encode(),
        ContentType="application/json",
    )


def open_key(workspace_id: str, import_id: str, *, purpose: str = SEAL_PURPOSE) -> str:
    """The plaintext key of one running import, raising `KeyGone` when it was deleted or will not open."""
    from botocore.exceptions import ClientError
    from webbpulse.identity.crypto import EnvelopeDecryptionFailed, SealedSecret

    from app.common.issue_import import _s3, bucket

    try:
        raw = _s3().get_object(Bucket=bucket(), Key=key_key(workspace_id, import_id))["Body"].read()
        stored = json.loads(raw)
        sealed = SealedSecret(
            ciphertext=stored["ciphertext"],
            nonce=stored["nonce"],
            wrapped_key=stored["wrapped_key"],
            scheme=stored["scheme"],
        )
        plaintext = _cipher().open(sealed, user_id=_bound_to(workspace_id, import_id), purpose=purpose)
    except (ClientError, EnvelopeDecryptionFailed, KeyError, ValueError, TypeError):
        raise KeyGone() from None
    return bytes(plaintext).decode()


def delete_key(workspace_id: str, import_id: str) -> None:
    """Delete one import's sealed key, which a finished, failed or cancelled job no longer needs."""
    from botocore.exceptions import ClientError

    from app.common.issue_import import _s3, bucket

    try:
        _s3().delete_object(Bucket=bucket(), Key=key_key(workspace_id, import_id))
    except ClientError:
        _log.warning(
            "The sealed key of an import could not be deleted.",
            extra={"event": "issue.import.key_delete_failed", "import_id": import_id},
        )


ClientFactory = Callable[[str], LinearClient]


def _default_client(api_key: str) -> LinearClient:
    """A Linear client for one key against the configured endpoint."""
    return LinearClient(api_key=api_key)


client_factory: ClientFactory = _default_client
"""How a step builds its Linear client, which the tests point at a fake Linear server."""


class UnknownLinearTeam(Exception):
    """A chosen Linear team is not one the key can read, or was chosen twice."""


def read_teams(api_key: str) -> list[dict[str, Any]]:
    """Every Linear team the key can read, raising `LinearAuthFailed` when Linear refuses the key."""
    from app.common.linear_api import list_teams

    return list_teams(client_factory(api_key))


def team_mappings(api_key: str, choices: list[tuple[str, str]]) -> list[LinearTeamMapping]:
    """Check each chosen Linear team against what the key can read, keeping its key and name for the job.

    `choices` pairs a Linear team id with the Standupless team id it goes into.
    Raises `UnknownLinearTeam` for a team the key cannot read or one chosen twice.
    """
    readable = {team["id"]: team for team in read_teams(api_key)}
    mappings: list[LinearTeamMapping] = []
    seen: set[str] = set()
    for linear_team_id, team_id in choices:
        team = readable.get(linear_team_id)
        if team is None or linear_team_id in seen:
            raise UnknownLinearTeam(linear_team_id)
        seen.add(linear_team_id)
        mappings.append(
            LinearTeamMapping(linear_team_id=linear_team_id, linear_key=team["key"], name=team["name"], team_id=team_id)
        )
    return mappings


def phases(job: Any) -> list[tuple[str, Optional[int]]]:
    """Every phase of one job in order: each mapped team's walk, then the workspace's initiatives and dependencies."""
    steps: list[tuple[str, Optional[int]]] = [
        (phase, index) for index in range(len(job.linear_teams)) for phase in TEAM_PHASES
    ]
    steps.extend((phase, None) for phase in WORKSPACE_PHASES)
    return steps


def linear_row_id(workspace_id: str, kind: str, linear_id: str, created_at: Any = None) -> str:
    """The id one Linear record always becomes in one workspace, so a re-run finds what it wrote.

    The time part is the record's Linear creation time, so imported rows sort as
    they did in Linear, and the rest is a digest of the workspace, kind and Linear id.
    """
    when = _instant(created_at)
    millis = int(when.timestamp() * 1000) if when is not None else 0
    head = "".join(CROCKFORD[(millis >> (5 * (9 - index))) & 31] for index in range(10))
    digest = int.from_bytes(hashlib.sha256(f"{workspace_id}:{kind}:{linear_id}".encode()).digest()[:10], "big")
    tail = "".join(CROCKFORD[(digest >> (5 * index)) & 31] for index in range(16))
    return f"{head}{tail}"


def _instant(value: Any) -> Optional[datetime]:
    """A Linear timestamp as an aware datetime, or `None` when there is none."""
    if isinstance(value, datetime):
        return value
    if not value:
        return None
    return parse_datetime(str(value))


def _date(value: Any) -> Optional[str]:
    """A Linear date or timestamp as `YYYY-MM-DD`, or `None`."""
    if not value:
        return None
    text = str(value)
    if re.match(r"^\d{4}-\d{2}-\d{2}", text):
        return text[:10]
    return None


LINEAR_RESOLUTIONS: dict[str, DateResolution] = {
    "month": "month",
    "quarter": "quarter",
    "halfYear": "half",
    "year": "year",
}
"""Linear's date resolutions under the names Standupless stores them by."""


def _coarse_date(node: dict[str, Any], date_field: str, resolution_field: str, edge: DateEdge) -> dict[str, Any]:
    """One Linear project date and its resolution as row fields, the date moved to its period's edge."""
    value = _date(node.get(date_field))
    name = "start_date" if edge == "start" else "target_date"
    resolution = LINEAR_RESOLUTIONS.get(str(node.get(resolution_field) or "")) if value else None
    if value and resolution:
        try:
            value = snap(value, resolution, edge)
        except ValueError:
            resolution = None
    return {name: value, f"{name}_resolution": resolution}


def _ref(value: Any) -> Optional[dict[str, Any]]:
    """A nested Linear object, or `None` when the field was null."""
    return value if isinstance(value, dict) and value.get("id") else None


def _email(value: Any) -> str:
    """The lower cased email of a nested Linear user, or empty."""
    if not isinstance(value, dict):
        return ""
    return str(value.get("email") or "").strip().lower()


def _cap(text: Optional[str]) -> tuple[Optional[str], bool]:
    """A markdown body held to the size an issue or comment takes, and whether it was cut."""
    if not text:
        return None, False
    encoded = text.encode("utf-8")
    if len(encoded) <= ISSUE_BODY_MAX_BYTES:
        return text, False
    return encoded[:ISSUE_BODY_MAX_BYTES].decode("utf-8", errors="ignore"), True


def _health(value: Any) -> Optional[str]:
    """A Linear health value as a Standupless one, or `None`."""
    if not value:
        return None
    return HEALTH_BY_LINEAR.get(str(value).replace("_", "").lower())


def _priority(value: Any) -> str:
    """A Linear priority number as a Standupless priority."""
    try:
        return PRIORITY_BY_NUMBER.get(int(value), "none")
    except (TypeError, ValueError):
        return "none"


@dataclass
class StepResult:
    """What one step wrote: tallies to add, problems found, and where the connection goes next."""

    counts: dict[str, int] = field(default_factory=dict)
    problems: list[RowProblem] = field(default_factory=list)
    next_after: Optional[str] = None

    def add(self, name: str, amount: int = 1) -> None:
        """Add to one tally."""
        self.counts[name] = self.counts.get(name, 0) + amount

    def warn(self, field_name: str, message: str) -> None:
        """Note one value that could not be carried over."""
        self.problems.append(RowProblem(row=0, field=field_name, message=message))


@dataclass
class TeamContext:
    """One mapped team as a step writes into it: its statuses, labels and members."""

    team_id: str
    lookup: Any
    groups: dict[str, Any] = field(default_factory=dict)
    labels: dict[tuple[str, str], Any] = field(default_factory=dict)


def _team_context(repositories: Any, workspace_id: str, team_id: str) -> TeamContext:
    """Read one team's statuses, members and whole label set, groups included."""
    from app.common.issue_import import load_lookup

    context = TeamContext(team_id=team_id, lookup=load_lookup(repositories, workspace_id, team_id))
    _read_labels(repositories, workspace_id, context)
    return context


def _read_labels(repositories: Any, workspace_id: str, context: TeamContext) -> None:
    """Index a team's labels by group name and label name, and its groups by name."""
    rows = repositories.team_config.list_labels(workspace_id, context.team_id, include_hidden=False)
    groups = {row.label_id: row for row in rows if row.is_group}
    context.groups = {row.name.strip().lower(): row for row in groups.values()}
    context.labels = {}
    for row in rows:
        if row.is_group:
            continue
        parent = groups.get(row.parent_id) if row.parent_id else None
        group_name = parent.name.strip().lower() if parent is not None else ""
        context.labels.setdefault((group_name, row.name.strip().lower()), row)


def _color(value: Any, name: str) -> str:
    """A Linear label colour when it is `#rrggbb`, else the importer's colour for the name."""
    from app.common.issue_import import label_color

    text = str(value or "").strip()
    return text.lower() if COLOR.match(text) else label_color(name)


def _ensure_label(
    repositories: Any, workspace_id: str, context: TeamContext, node: dict[str, Any], result: StepResult
) -> Optional[str]:
    """The id of the team label one Linear label maps to, creating it and its group when missing."""
    from app.common.api.schemas.teams import LabelCreate
    from app.common.labels import create_label

    name = str(node.get("name") or "").strip()[:60]
    if not name:
        return None
    parent = _ref(node.get("parent"))
    group_name = str(parent.get("name") or "").strip()[:60] if parent else ""
    group_id: Optional[str] = None
    if group_name:
        group = context.groups.get(group_name.lower())
        if group is None:
            try:
                group = create_label(
                    repositories,
                    workspace_id,
                    context.team_id,
                    LabelCreate(
                        name=group_name,
                        color=_color(parent.get("color") if parent else None, group_name),
                        is_group=True,
                    ),
                )
                result.add("labels")
            except HTTPException as exc:
                if exc.status_code not in (409, 422):
                    raise
                _read_labels(repositories, workspace_id, context)
                group = context.groups.get(group_name.lower())
            if group is not None:
                context.groups[group_name.lower()] = group
        if group is None:
            group_name = ""
        else:
            group_id = group.label_id
    found = context.labels.get((group_name.lower(), name.lower()))
    if found is not None:
        return found.label_id
    try:
        label = create_label(
            repositories,
            workspace_id,
            context.team_id,
            LabelCreate(name=name, color=_color(node.get("color"), name), parent_id=group_id),
        )
        result.add("labels")
    except HTTPException as exc:
        if exc.status_code not in (409, 422):
            raise
        _read_labels(repositories, workspace_id, context)
        label = context.labels.get((group_name.lower(), name.lower()))
        if label is None:
            result.warn("labels", f"The label {name!r} clashes with another label of the team, left off")
            return None
    context.labels[(group_name.lower(), name.lower())] = label
    return label.label_id


def _status(context: TeamContext, state: Any) -> Any:
    """The team status a Linear workflow state maps to: the same name, else the same type, else the default."""
    lookup = context.lookup
    if not isinstance(state, dict):
        return lookup.default_status
    named = lookup.status_by_name.get(str(state.get("name") or "").strip().lower())
    if named is not None:
        return named
    category = CATEGORY_BY_STATE_TYPE.get(str(state.get("type") or "").lower())
    if category is not None and category in lookup.status_by_category:
        return lookup.status_by_category[category]
    return lookup.default_status


def _member(context: TeamContext, user: Any) -> Optional[str]:
    """The member a Linear user is, matched by email, or `None`."""
    email = _email(user)
    return context.lookup.by_email.get(email) if email else None


def _author(context: TeamContext, user: Any) -> str:
    """Who a comment or update is written as: the matching member, else a `linear:<name>` placeholder."""
    member = _member(context, user)
    if member is not None:
        return member
    name = str(user.get("name") or "").strip() if isinstance(user, dict) else ""
    return f"{LINEAR_AUTHOR_PREFIX}{(name or 'Linear user')[:80]}"


def _people(repositories: Any, workspace_id: str) -> dict[str, str]:
    """Every member's user id by lower cased email, for the phases that are not per team."""
    members = repositories.memberships.list_members(workspace_id, limit=100_000)
    ids = [member.user_id for member in members]
    users: dict[str, Any] = {}
    for start in range(0, len(ids), 100):
        users.update(repositories.users.get_many(ids[start : start + 100]))
    return {str(user.email).strip().lower(): user_id for user_id, user in users.items() if user.email}


def run_step(repositories: Any, job: Any, client: LinearClient) -> StepResult:
    """Read and write the page of the phase the job is at."""
    steps = phases(job)
    phase, index = steps[job.phase_index]
    if phase == "initiatives":
        return _initiatives_step(repositories, job, client)
    if phase == "project_relations":
        return _project_relations_step(repositories, job, client)
    mapping = job.linear_teams[index]
    context = _team_context(repositories, job.workspace_id, mapping.team_id)
    handlers = {
        "cycles": _cycles_step,
        "projects": _projects_step,
        "issues": _issues_step,
        "links": _links_step,
    }
    return handlers[phase](repositories, job, client, mapping, context)


def _page(
    client: LinearClient, query: str, path: tuple[str, ...], variables: dict[str, Any], after: Optional[str]
) -> Page:
    """One page of a connection from where the job left off."""
    return client.page(query, path, {**variables, "after": after})


def _cycles_step(
    repositories: Any, job: Any, client: LinearClient, mapping: LinearTeamMapping, context: TeamContext
) -> StepResult:
    """Write one page of a Linear team's cycles as the mapped team's cycles."""
    from app.common.db.dynamo.planning import Cycle, cycle_key

    result = StepResult()
    page = _page(client, CYCLES_QUERY, ("team", "cycles"), {"team": mapping.linear_team_id}, job.after)
    for node in page.nodes:
        start, end = _date(node.get("startsAt")), _date(node.get("endsAt"))
        if not start or not end:
            continue
        cycle_id = linear_row_id(job.workspace_id, "cycle", str(node["id"]), node.get("createdAt"))
        number = node.get("number")
        name = str(node.get("name") or "").strip() or (f"Cycle {number}" if number is not None else "Cycle")
        existing = repositories.planning.get_cycle(job.workspace_id, mapping.team_id, cycle_id)
        fields = {
            "name": name[:120],
            "start_date": start,
            "end_date": end,
            "goal": (str(node.get("description") or "").strip() or None),
            "import_batch_id": job.import_id,
            "updated_at": utc_now(),
        }
        if existing is None:
            cycle = Cycle(
                workspace_id=job.workspace_id,
                planning_key=cycle_key(mapping.team_id, cycle_id),
                cycle_id=cycle_id,
                team_id=mapping.team_id,
                created_by=job.requested_by,
                created_at=_instant(node.get("createdAt")) or utc_now(),
                **fields,
            )
            try:
                repositories.planning.create_cycle(cycle)
            except ConditionFailed:
                continue
        else:
            repositories.planning.replace_cycle(existing.model_copy(update=fields), keep_import_batch=True)
        result.add("cycles")
    result.next_after = page.end_cursor if page.has_next else None
    return result


def _projects_step(
    repositories: Any, job: Any, client: LinearClient, mapping: LinearTeamMapping, context: TeamContext
) -> StepResult:
    """Write one page of a Linear team's projects, each with its milestones and updates."""
    result = StepResult()
    page = _page(client, PROJECTS_QUERY, ("team", "projects"), {"team": mapping.linear_team_id}, job.after)
    for node in page.nodes:
        _write_project(repositories, job, client, mapping, context, node, result)
    result.next_after = page.end_cursor if page.has_next else None
    return result


def _rest(
    client: LinearClient, query: str, path: tuple[str, ...], variables: dict[str, Any], connection: Any
) -> list[dict[str, Any]]:
    """Every node of a nested connection: the first page Linear sent inline, then the rest page by page."""
    first = Page.of(connection)
    nodes = list(first.nodes)
    after = first.end_cursor if first.has_next else None
    while after:
        page = client.page(query, path, {**variables, "after": after})
        nodes.extend(page.nodes)
        after = page.end_cursor if page.has_next else None
    return nodes


def _write_project(
    repositories: Any,
    job: Any,
    client: LinearClient,
    mapping: LinearTeamMapping,
    context: TeamContext,
    node: dict[str, Any],
    result: StepResult,
) -> None:
    """Write one Linear project, adding the mapped team to it when another team's walk wrote it first."""
    from app.common.db.dynamo.planning import Project, project_key

    project_id = linear_row_id(job.workspace_id, "project", str(node["id"]), node.get("createdAt"))
    updates = _rest(
        client,
        PROJECT_UPDATES_QUERY,
        ("project", "projectUpdates"),
        {"project": str(node["id"])},
        node.get("projectUpdates"),
    )
    milestones = _rest(
        client,
        PROJECT_MILESTONES_QUERY,
        ("project", "projectMilestones"),
        {"project": str(node["id"])},
        node.get("projectMilestones"),
    )
    newest = max(updates, key=lambda update: str(update.get("createdAt") or ""), default=None)
    description, _ = _cap(str(node.get("content") or node.get("description") or "").strip() or None)
    status_node = node.get("status") if isinstance(node.get("status"), dict) else {}
    status = PROJECT_STATUS_BY_TYPE.get(str(status_node.get("type") or "").lower(), "backlog")
    lead = _member(context, node.get("lead"))
    fields: dict[str, Any] = {
        "name": str(node.get("name") or "Untitled project").strip()[:120] or "Untitled project",
        "description": description,
        "lead_id": lead,
        **_coarse_date(node, "startDate", "startDateResolution", "start"),
        **_coarse_date(node, "targetDate", "targetDateResolution", "end"),
        "status": status,
        "priority": _priority(node.get("priority")),
        "health": _health(node.get("health")) or (_health(newest.get("health")) if newest else None),
        "last_update_at": _instant(newest.get("createdAt")) if newest else None,
        "import_batch_id": job.import_id,
        "updated_at": utc_now(),
    }
    existing = repositories.planning.get_project(job.workspace_id, project_id)
    if existing is None:
        project = Project(
            workspace_id=job.workspace_id,
            planning_key=project_key(project_id),
            project_id=project_id,
            team_ids=[mapping.team_id],
            created_by=job.requested_by,
            created_at=_instant(node.get("createdAt")) or utc_now(),
            **fields,
        )
        try:
            repositories.planning.create_project(project)
        except ConditionFailed:
            existing = repositories.planning.get_project(job.workspace_id, project_id)
    if existing is not None:
        team_ids = list(dict.fromkeys([*existing.team_ids, mapping.team_id]))
        repositories.planning.replace_project(
            existing.model_copy(update={**fields, "team_ids": team_ids}), keep_import_batch=True
        )
    result.add("projects")
    _write_milestones(repositories, job, project_id, milestones, result)
    for update in updates:
        _write_project_update(repositories, job, context, project_id, update, result)


def _write_milestones(
    repositories: Any, job: Any, project_id: str, nodes: list[dict[str, Any]], result: StepResult
) -> None:
    """Write one project's milestones in Linear's order, a new one going after those already there."""
    from app.common.db.dynamo.planning import ProjectMilestone, milestone_key
    from app.common.milestone_writes import MILESTONES_MAX, sort_order_after

    def order(node: dict[str, Any]) -> float:
        """Linear's sort order of one milestone."""
        try:
            return float(node.get("sortOrder") or 0)
        except (TypeError, ValueError):
            return 0.0

    stored = repositories.planning.list_milestones(job.workspace_id, project_id)
    room = MILESTONES_MAX - len(stored)
    last = max((row.sort_order for row in stored), default=None)
    for node in sorted(nodes, key=order):
        milestone_id = linear_row_id(job.workspace_id, "milestone", str(node["id"]), node.get("createdAt"))
        description, _ = _cap(str(node.get("description") or "").strip() or None)
        fields = {
            "name": str(node.get("name") or "Milestone").strip()[:120] or "Milestone",
            "description": description,
            "target_date": _date(node.get("targetDate")),
            "import_batch_id": job.import_id,
            "updated_at": utc_now(),
        }
        existing = repositories.planning.get_milestone(job.workspace_id, project_id, milestone_id)
        if existing is None:
            if room <= 0:
                result.warn("milestones", "A project holds at most 100 milestones, the rest were left out")
                break
            room -= 1
            last = sort_order_after(last)
            try:
                repositories.planning.create_milestone(
                    ProjectMilestone(
                        workspace_id=job.workspace_id,
                        planning_key=milestone_key(project_id, milestone_id),
                        milestone_id=milestone_id,
                        project_id=project_id,
                        sort_order=last,
                        created_by=job.requested_by,
                        created_at=_instant(node.get("createdAt")) or utc_now(),
                        **fields,
                    )
                )
            except ConditionFailed:
                continue
        else:
            repositories.planning.replace_milestone(existing.model_copy(update=fields), keep_import_batch=True)
        result.add("milestones")


def _write_project_update(
    repositories: Any, job: Any, context: TeamContext, project_id: str, node: dict[str, Any], result: StepResult
) -> None:
    """Write one Linear project update with its health, author and time."""
    from app.common.db.dynamo.planning import ProjectUpdateRow, project_update_key

    body, _ = _cap(str(node.get("body") or "").strip() or None)
    if not body:
        return
    update_id = linear_row_id(job.workspace_id, "project_update", str(node["id"]), node.get("createdAt"))
    created = _instant(node.get("createdAt")) or utc_now()
    row = ProjectUpdateRow(
        workspace_id=job.workspace_id,
        planning_key=project_update_key(project_id, update_id),
        update_id=update_id,
        project_id=project_id,
        body=body,
        health=_health(node.get("health")) or "on_track",
        author_id=_author(context, node.get("user")),
        source=job.source,
        created_at=created,
        updated_at=created,
        import_batch_id=job.import_id,
    )
    if repositories.planning.get_project_update(job.workspace_id, project_id, update_id) is None:
        try:
            repositories.planning.create_project_update(row)
        except ConditionFailed:
            return
    else:
        repositories.planning.replace_project_update(row, keep_import_batch=True)
    result.add("project_updates")


def _issues_step(
    repositories: Any, job: Any, client: LinearClient, mapping: LinearTeamMapping, context: TeamContext
) -> StepResult:
    """Write one page of a Linear team's issues, each with its labels, comments and attachment links."""
    result = StepResult()
    page = _page(client, ISSUES_QUERY, ("team", "issues"), {"team": mapping.linear_team_id}, job.after)
    known: dict[tuple[str, str], bool] = {}
    for node in page.nodes:
        issue_id = _write_issue(repositories, job, mapping, context, node, known, result)
        if issue_id is None:
            continue
        comments = _rest(
            client, ISSUE_COMMENTS_QUERY, ("issue", "comments"), {"issue": str(node["id"])}, node.get("comments")
        )
        for comment in sorted(comments, key=lambda item: str(item.get("createdAt") or "")):
            _write_comment(repositories, job, context, issue_id, comment, result)
    result.next_after = page.end_cursor if page.has_next else None
    return result


def _planning_ref(
    repositories: Any,
    job: Any,
    mapping: LinearTeamMapping,
    kind: str,
    ref: Any,
    known: dict[tuple[str, str], bool],
    project_id: Optional[str] = None,
) -> Optional[str]:
    """The id of the imported cycle, project or milestone a Linear issue points at, when it was imported."""
    node = _ref(ref)
    if node is None:
        return None
    row_id = linear_row_id(job.workspace_id, kind, str(node["id"]), node.get("createdAt"))
    cache_key = (kind, row_id)
    if cache_key not in known:
        if kind == "cycle":
            found = repositories.planning.get_cycle(job.workspace_id, mapping.team_id, row_id)
        elif kind == "project":
            found = repositories.planning.get_project(job.workspace_id, row_id)
        else:
            found = repositories.planning.get_milestone(job.workspace_id, project_id, row_id) if project_id else None
        known[cache_key] = found is not None
    return row_id if known[cache_key] else None


def _issue_body(node: dict[str, Any]) -> tuple[Optional[str], bool]:
    """The issue's description with its attachments appended as links."""
    text = str(node.get("description") or "").strip()
    links = []
    for attachment in Page.of(node.get("attachments")).nodes:
        url = str(attachment.get("url") or "").strip()
        if not url.startswith(("https://", "http://")):
            continue
        title = str(attachment.get("title") or "").strip().replace("[", "(").replace("]", ")") or url
        links.append(f"- [{title}]({url})")
    if links:
        text = "\n\n".join(part for part in (text, "**Attachments**\n" + "\n".join(links)) if part)
    return _cap(text or None)


def _estimate(context: TeamContext, value: Any, identifier: str, result: StepResult) -> Optional[str]:
    """A Linear estimate on the team's scale, or `None` with a warning when the scale has no such value.

    Linear stores a t-shirt estimate as its points, so a team on the t-shirt scale
    gets the size those points stand for.
    """
    from app.common.estimates import TSHIRT_POINTS
    from app.common.issue_rules import check_estimate

    if value is None or value == "":
        return None
    try:
        number = float(value)
        text = str(int(number)) if number.is_integer() else str(number)
    except (TypeError, ValueError):
        text = str(value)
    if context.lookup.team.estimate_scale == "tshirt":
        sizes = {str(points): size for size, points in TSHIRT_POINTS.items()}
        text = sizes.get(text, text)
    try:
        return check_estimate(text, context.lookup.team)
    except HTTPException:
        result.warn("estimate", f"{identifier}: estimate {text} is not on the team's scale, left empty")
        return None


def _write_issue(
    repositories: Any,
    job: Any,
    mapping: LinearTeamMapping,
    context: TeamContext,
    node: dict[str, Any],
    known: dict[tuple[str, str], bool],
    result: StepResult,
) -> Optional[str]:
    """Write or update one Linear issue in the mapped team, answering its id, or `None` when it was left out."""
    from app.common.db.dynamo.activity import build_activity
    from app.common.db.dynamo.issues import Issue, issue_key
    from app.common.issue_import import _assignable
    from app.common.sla import apply_sla

    identifier = str(node.get("identifier") or node.get("id"))
    title = str(node.get("title") or "").strip()[:500]
    if not title:
        result.warn("title", f"{identifier}: no title, left out")
        return None
    issue_id = linear_row_id(job.workspace_id, "issue", str(node["id"]), node.get("createdAt"))
    body, cut = _issue_body(node)
    if cut:
        result.warn("description", f"{identifier}: the description was cut to fit")
    assignee = _member(context, node.get("assignee"))
    if node.get("assignee") and assignee is None:
        result.warn("assignee", f"{identifier}: the assignee is not a member, left unassigned")
    elif assignee is not None and not _assignable(repositories, context.lookup, job.workspace_id, assignee):
        result.warn("assignee", f"{identifier}: the assignee cannot see this team, left unassigned")
        assignee = None
    label_ids = []
    for label in Page.of(node.get("labels")).nodes:
        label_id = _ensure_label(repositories, job.workspace_id, context, label, result)
        if label_id is not None:
            label_ids.append(label_id)
    project_id = _planning_ref(repositories, job, mapping, "project", node.get("project"), known)
    url = str(node.get("url") or "").strip()
    fields: dict[str, Any] = {
        "title": title,
        "body": body,
        "status_id": _status(context, node.get("state")).status_id,
        "priority": _priority(node.get("priority")),
        "assignee_id": assignee,
        "label_ids": list(dict.fromkeys(label_ids)),
        "estimate": _estimate(context, node.get("estimate"), identifier, result),
        "due_date": _date(node.get("dueDate")),
        "cycle_id": _planning_ref(repositories, job, mapping, "cycle", node.get("cycle"), known),
        "project_id": project_id,
        "project_milestone_id": _planning_ref(
            repositories, job, mapping, "milestone", node.get("projectMilestone"), known, project_id
        ),
        "external_ref": f"{identifier} {url}".strip()[:500],
        "import_batch_id": job.import_id,
    }
    now = utc_now()
    existing = repositories.issues.get(job.workspace_id, issue_id)
    if existing is not None:
        if existing.team_id != mapping.team_id:
            result.warn("team", f"{identifier}: imported before into another team, left there")
            return issue_id
        updated = existing.model_copy(
            update={**fields, "updated_at": now, "updated_by": job.requested_by, "updated_source": job.source}
        )
        repositories.issues.replace(updated, keep_import_batch=True)
        result.add("issues_updated")
        return issue_id
    creator = _member(context, node.get("creator")) or job.requested_by
    number = repositories.counters.allocate_issue_number(job.workspace_id, mapping.team_id)
    created_at = _instant(node.get("createdAt"))
    issue = Issue(
        workspace_id=job.workspace_id,
        issue_id=issue_id,
        team_id=mapping.team_id,
        key=issue_key(context.lookup.team.key_prefix, number),
        number=number,
        created_by=creator,
        created_at=min(created_at, now) if created_at is not None else now,
        updated_at=now,
        updated_by=job.requested_by,
        updated_source=job.source,
        **fields,
    )
    apply_sla(repositories, None, issue)
    try:
        created = repositories.issues.create(issue)
    except ConditionFailed:
        return issue_id
    repositories.activity.record(
        build_activity(job.workspace_id, mapping.team_id, issue_id, creator, "created", source=job.source)
    )
    if created.assignee_id:
        repositories.subscriptions.subscribe(
            job.workspace_id, issue_id, mapping.team_id, created.assignee_id, "assignee"
        )
    result.add("issues_created")
    return issue_id


def _write_comment(
    repositories: Any, job: Any, context: TeamContext, issue_id: str, node: dict[str, Any], result: StepResult
) -> None:
    """Write or update one Linear comment with its author, time and thread parent."""
    from app.common.db.dynamo.comments import build_comment

    body, _ = _cap(str(node.get("body") or "").strip() or None)
    if not body:
        return
    comment_id = linear_row_id(job.workspace_id, "comment", str(node["id"]), node.get("createdAt"))
    parent = _ref(node.get("parent"))
    parent_id = None
    if parent:
        parent_id = linear_row_id(job.workspace_id, "comment", str(parent["id"]), parent.get("createdAt"))
    comment = build_comment(
        job.workspace_id,
        issue_id,
        context.team_id,
        _author(context, node.get("user")),
        body,
        parent_comment_id=parent_id,
        source=job.source,
    ).model_copy(
        update={
            "comment_id": comment_id,
            "created_at": _instant(node.get("createdAt")) or utc_now(),
            "import_batch_id": job.import_id,
        }
    )
    existing = repositories.comments.get(job.workspace_id, issue_id, comment_id)
    if existing is None:
        try:
            repositories.comments.create(comment)
        except ConditionFailed:
            return
    elif existing.body != body or existing.author_id != comment.author_id:
        repositories.comments.replace_imported(comment)
    result.add("comments")


def _links_step(
    repositories: Any, job: Any, client: LinearClient, mapping: LinearTeamMapping, context: TeamContext
) -> StepResult:
    """Link one page of a Linear team's issues to their parents and related issues, now every issue is written."""
    from app.common.issue_rules import check_parent
    from app.common.relation_effects import blocked_side, recount_blocked, recount_relations

    result = StepResult()
    page = _page(client, ISSUE_LINKS_QUERY, ("team", "issues"), {"team": mapping.linear_team_id}, job.after)
    for node in page.nodes:
        issue_id = linear_row_id(job.workspace_id, "issue", str(node["id"]), node.get("createdAt"))
        issue = repositories.issues.get(job.workspace_id, issue_id)
        if issue is None:
            continue
        parent = _ref(node.get("parent"))
        if parent is not None and not issue.parent_id:
            parent_id = linear_row_id(job.workspace_id, "issue", str(parent["id"]), parent.get("createdAt"))
            try:
                check_parent(repositories, job.workspace_id, issue.team_id, issue_id, parent_id)
            except HTTPException:
                result.warn("parent", f"{issue.key}: the Linear parent cannot be its parent here, left without one")
            else:
                if repositories.issues.link_imported_parent(job.workspace_id, issue_id, parent_id, job.import_id):
                    result.add("sub_issues")
        for relation in Page.of(node.get("relations")).nodes:
            link_type = RELATION_TYPES.get(str(relation.get("type") or "").lower())
            target = _ref(relation.get("relatedIssue"))
            if link_type is None or target is None:
                continue
            target_id = linear_row_id(job.workspace_id, "issue", str(target["id"]), target.get("createdAt"))
            if target_id == issue_id or repositories.issues.get(job.workspace_id, target_id) is None:
                continue
            if repositories.relations.get(job.workspace_id, issue_id, link_type, target_id) is not None:
                continue
            link = repositories.relations.link(
                job.workspace_id, issue_id, link_type, target_id, job.requested_by, import_batch_id=job.import_id
            )
            blocked = blocked_side(link)
            if blocked is not None:
                recount_blocked(repositories, job.workspace_id, blocked)
            recount_relations(repositories, job.workspace_id, issue_id)
            recount_relations(repositories, job.workspace_id, target_id)
            result.add("relations")
    result.next_after = page.end_cursor if page.has_next else None
    return result


def _initiatives_step(repositories: Any, job: Any, client: LinearClient) -> StepResult:
    """Write one page of the Linear workspace's initiatives and put their imported projects in them."""
    from app.common.db.dynamo.planning import Initiative, initiative_key

    result = StepResult()
    page = _page(client, INITIATIVES_QUERY, ("initiatives",), {}, job.after)
    people = _people(repositories, job.workspace_id) if page.nodes else {}
    for node in page.nodes:
        initiative_id = linear_row_id(job.workspace_id, "initiative", str(node["id"]), node.get("createdAt"))
        status = str(node.get("status") or "planned").strip().lower()
        description, _ = _cap(str(node.get("description") or "").strip() or None)
        fields: dict[str, Any] = {
            "name": str(node.get("name") or "Untitled initiative").strip()[:120] or "Untitled initiative",
            "description": description,
            "owner_id": people.get(_email(node.get("owner"))),
            "status": status if status in INITIATIVE_STATUSES else "planned",
            "target_date": _date(node.get("targetDate")),
            "import_batch_id": job.import_id,
            "updated_at": utc_now(),
        }
        existing = repositories.planning.get_initiative(job.workspace_id, initiative_id)
        if existing is None:
            try:
                repositories.planning.create_initiative(
                    Initiative(
                        workspace_id=job.workspace_id,
                        planning_key=initiative_key(initiative_id),
                        initiative_id=initiative_id,
                        created_by=job.requested_by,
                        created_at=_instant(node.get("createdAt")) or utc_now(),
                        **fields,
                    )
                )
            except ConditionFailed:
                continue
        else:
            repositories.planning.replace_initiative(existing.model_copy(update=fields), keep_import_batch=True)
        result.add("initiatives")
        for project in Page.of(node.get("projects")).nodes:
            project_id = linear_row_id(job.workspace_id, "project", str(project["id"]), project.get("createdAt"))
            row = repositories.planning.get_project(job.workspace_id, project_id)
            if row is None or row.initiative_id == initiative_id:
                continue
            repositories.planning.replace_project(
                row.model_copy(update={"initiative_id": initiative_id, "import_batch_id": job.import_id}),
                keep_import_batch=True,
            )
    result.next_after = page.end_cursor if page.has_next else None
    return result


def _dependency_ends(node: dict[str, Any]) -> Optional[tuple[dict[str, Any], dict[str, Any]]]:
    """The blocking and the blocked Linear project of one dependency, or `None` when it is not one.

    Linear anchors each end of a dependency at a project's start or end. The
    project whose start waits on the other's end is the blocked one; any other
    pairing reads as `project` blocking `relatedProject`.
    """
    if str(node.get("type") or "").strip().lower() not in PROJECT_DEPENDENCY_TYPES:
        return None
    project, related = _ref(node.get("project")), _ref(node.get("relatedProject"))
    if project is None or related is None:
        return None
    anchor = str(node.get("anchorType") or "").strip().lower()
    related_anchor = str(node.get("relatedAnchorType") or "").strip().lower()
    if anchor == "start" and related_anchor == "end":
        return related, project
    return project, related


def _project_relations_step(repositories: Any, job: Any, client: LinearClient) -> StepResult:
    """Write one page of the Linear workspace's project dependencies as blocks links between imported projects.

    A dependency is kept only when both projects were imported. One already
    stored is left as it is, and one that would make projects wait on each other
    is left out with a warning, the same rule a dependency drawn by hand follows.
    The phase is fail-soft: a query Linear rejects, such as a field its schema
    no longer has, ends the phase with a warning and the import still completes.
    A refused key, a rate limit and a transient failure are raised as usual.
    """
    from app.common.db.dynamo.planning import ProjectRelation, project_relation_key
    from app.common.project_relations import would_loop

    result = StepResult()
    try:
        page = _page(client, PROJECT_RELATIONS_QUERY, ("projectRelations",), {}, job.after)
    except (LinearAuthFailed, LinearRateLimited):
        raise
    except LinearError as exc:
        if exc.code in TRANSIENT_CODES:
            raise
        _log.warning(
            "Linear rejected the project dependencies query, so the import goes on without them.",
            extra={
                "event": "issue.import.linear_project_relations_skipped",
                "import_id": job.import_id,
                "code": exc.code,
            },
        )
        result.warn("project_relations", f"Linear would not list project dependencies ({exc.code}), left out")
        return result
    relations = repositories.planning.list_project_relations(job.workspace_id) if page.nodes else []
    for node in page.nodes:
        ends = _dependency_ends(node)
        if ends is None:
            continue
        blocker_id, blocked_id = (
            linear_row_id(job.workspace_id, "project", str(end["id"]), end.get("createdAt")) for end in ends
        )
        if blocker_id == blocked_id:
            continue
        blocker = repositories.planning.get_project(job.workspace_id, blocker_id)
        blocked = repositories.planning.get_project(job.workspace_id, blocked_id)
        if blocker is None or blocked is None:
            continue
        if any(row.project_id == blocker_id and row.target_project_id == blocked_id for row in relations):
            continue
        if would_loop(relations, blocker_id, blocked_id):
            result.warn(
                "project_relations",
                f"{blocker.name} blocking {blocked.name} would make the projects wait on each other, left out",
            )
            continue
        relation = ProjectRelation(
            workspace_id=job.workspace_id,
            planning_key=project_relation_key(blocker_id, blocked_id),
            relation_id=linear_row_id(job.workspace_id, "project_relation", str(node["id"]), node.get("createdAt")),
            project_id=blocker_id,
            target_project_id=blocked_id,
            created_by=job.requested_by,
            created_at=_instant(node.get("createdAt")) or utc_now(),
        )
        try:
            repositories.planning.create_project_relation(relation)
        except ConditionFailed:
            continue
        relations.append(relation)
        result.add("project_relations")
    result.next_after = page.end_cursor if page.has_next else None
    return result


def run_linear_page(repositories: Any, job: Any) -> Any:
    """Run the step the job is at and move it on, completing it after the last phase.

    The job is read again before its progress is saved, so a cancel that landed
    while the step ran is kept rather than overwritten. A refused key fails the job
    at once, since no retry can fix it.
    """
    from app.common.issue_import import MAX_PROBLEMS, fail, load_job, notify, save_job

    try:
        api_key = open_key(job.workspace_id, job.import_id)
    except KeyGone as exc:
        return fail(repositories, job, exc)
    try:
        result = run_step(repositories, job, client_factory(api_key))
    except LinearAuthFailed as exc:
        return fail(repositories, job, exc)
    current = load_job(job.workspace_id, job.import_id)
    if current is not None and current.status not in ("queued", "running"):
        delete_key(job.workspace_id, job.import_id)
        return current
    counts = dict(job.counts)
    for name, amount in result.counts.items():
        counts[name] = counts.get(name, 0) + amount
    phase_index, after = job.phase_index, result.next_after
    if after is None:
        phase_index += 1
    done = phase_index >= len(phases(job))
    problems = [*job.problems, *result.problems]
    updated = save_job(
        job.model_copy(
            update={
                "cursor": job.cursor + 1,
                "page_attempts": 0,
                "phase_index": phase_index,
                "after": after,
                "counts": counts,
                "created_count": counts.get("issues_created", 0),
                "updated_count": counts.get("issues_updated", 0),
                "labels_created": counts.get("labels", 0),
                "linked_count": counts.get("sub_issues", 0),
                "problems": problems[:MAX_PROBLEMS],
                "problems_truncated": job.problems_truncated or len(problems) > MAX_PROBLEMS,
                "status": "completed" if done else "running",
                "finished_at": utc_now() if done else None,
            }
        )
    )
    if done:
        delete_key(job.workspace_id, job.import_id)
        notify(repositories, updated)
    return updated
