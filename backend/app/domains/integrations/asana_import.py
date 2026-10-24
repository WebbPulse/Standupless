"""Import chosen Asana projects through Asana's REST API, a page at a time on the issue import queue.

An Asana import is an `ImportJob` of kind `asana`, so it shares the other
importers' job object, queue, page retries, stale job detection, cancel and inbox
notice. Each chosen project goes into one team and walks two phases: `project`,
which writes the Asana project as a Standupless project when the admin asked for
one, and `tasks`, which reads the project's top level tasks a page at a time and
writes each with its comments and subtasks. `phase_index` and `after`, Asana's
page offset, say where the job is, and `cursor` counts the steps so the queue's
duplicate guard works unchanged.

A task's status comes from its section in the project, or from a single choice
custom field the admin picked instead. The admin may map any section or option
to a status; anything left unmapped lands in the team status of the same name,
else the status whose category the name means, else the team's default. A
completed task always lands in a completed status. Tags become labels, a
single choice field named Priority sets the priority, and assignees, creators
and comment authors are matched to members by email. A comment whose author is
not a member is written under an `asana:<name>` placeholder, and no account or
invite is ever created.

Subtasks become sub-issues of the task they hang off. Standupless sub-issues are
one level deep, so a subtask of a subtask becomes a sub-issue of the top level
task, down to `MAX_SUBTASK_DEPTH` levels.

Every row an import writes gets an id derived from the workspace and the Asana
gid, with the Asana creation time as its time part, so a step that runs twice,
and a later import of the same project, finds the rows already written and
updates them rather than writing them again. Each issue's `external_ref` carries
the Asana gid and the task's URL.

The personal access token the admin pasted is sealed beside the job in
`key.json` under its own purpose, bound to the workspace and import, and is the
only copy kept. It is opened in memory for each step, deleted when the job
completes, fails or is cancelled, and never written to the job, a log, an audit
row or any imported data.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from fastapi import HTTPException
from webbpulse.dynamodb import ConditionFailed, new_ulid

from app.common import issue_import
from app.common.api.dependencies.authz import AuthzContext
from app.common.core.config import settings
from app.common.csv_import import parse_priority, status_category
from app.common.db.dynamo.base import utc_now
from app.common.issue_import import AsanaProjectMapping
from app.common.linear_import import (
    KeyGone,
    StepResult,
    TeamContext,
    _cap,
    _date,
    _ensure_label,
    _instant,
    _team_context,
    can_seal,
    delete_key,
    linear_row_id,
    open_key,
    seal_key,
)
from app.domains.integrations import asana_api
from app.domains.integrations.asana_api import AsanaAuthFailed, AsanaClient, AsanaNotFound

_log = logging.getLogger(__name__)

KIND = "asana"

PRESET = "asana_api"

SEAL_PURPOSE = "asana_import_key"
"""The purpose an Asana token is sealed under, so it never opens as another importer's key."""

ASANA_AUTHOR_PREFIX = "asana:"

PAGE_SIZE = 20
"""Top level tasks one step reads, each with its comments and subtasks, so a step ends inside its invocation."""

MAX_SUBTASK_DEPTH = 3
"""How many levels of subtasks below a top level task are read."""

MAX_WORKSPACES = 10
"""How many of the token's Asana workspaces the project list reads."""

PROJECT_PHASES: tuple[str, ...] = ("project", "tasks")

TAG_COLORS: dict[str, str] = {
    "dark-pink": "#b4387c",
    "dark-green": "#31a24c",
    "dark-blue": "#1f6fd1",
    "dark-red": "#c92f2f",
    "dark-teal": "#1c8f8a",
    "dark-brown": "#8d5b3f",
    "dark-orange": "#d9661c",
    "dark-purple": "#7a4ccb",
    "dark-warm-gray": "#6b6560",
    "light-pink": "#f19fc6",
    "light-green": "#8fd08a",
    "light-blue": "#8ab8f0",
    "light-red": "#f29a9a",
    "light-teal": "#83d3cd",
    "light-brown": "#c9a68b",
    "light-orange": "#f6b47a",
    "light-purple": "#bba6ef",
    "light-warm-gray": "#b8b1aa",
}
"""Asana's named tag colours as the hex a label takes; a tag with no colour gets the importer's colour for its name."""


class UnknownAsanaProject(Exception):
    """A chosen Asana project is not one the token can read, or was chosen twice."""


class UnknownStatusChoice(Exception):
    """A status mapping names a status the team lacks, or a status field the project does not have."""


ClientFactory = Callable[[str], AsanaClient]


def _default_client(token: str) -> AsanaClient:
    """An Asana client for one token against the configured endpoint."""
    return AsanaClient(token=token)


client_factory: ClientFactory = _default_client
"""How a step builds its Asana client, which the tests point at a fake Asana server."""


@dataclass
class ProjectChoice:
    """One project the admin picked: the team it goes into and how its tasks map."""

    project_gid: str
    team_id: str
    create_project: bool = True
    status_field_gid: str = ""
    statuses: dict[str, str] = field(default_factory=dict)


@dataclass
class StatusPlan:
    """Where one section or option of a project lands."""

    source: str
    status_id: str
    status_name: str


@dataclass
class ProjectPreview:
    """What importing one project would do, read from Asana without writing anything."""

    mapping: AsanaProjectMapping
    task_count: int
    completed_count: int
    sections: list[str]
    status_fields: list[dict[str, Any]]
    statuses: list[StatusPlan]


def _is_gid(value: str) -> bool:
    """Whether a value is shaped like an Asana gid, so it is safe to put in a request path."""
    return 0 < len(value) <= 32 and value.isascii() and value.isdigit()


def asana_row_id(workspace_id: str, kind: str, gid: Any, created_at: Any) -> str:
    """The id one Asana record always becomes in one workspace, so a re-run finds what it wrote."""
    return linear_row_id(workspace_id, f"asana_{kind}", str(gid), created_at)


def read_projects(token: str) -> list[dict[str, Any]]:
    """Every project the token can see across its workspaces, raising `AsanaAuthFailed` for a refused token."""
    client = client_factory(token)
    user = asana_api.me(client)
    projects: list[dict[str, Any]] = []
    for workspace in (user.get("workspaces") or [])[:MAX_WORKSPACES]:
        if not isinstance(workspace, dict) or not workspace.get("gid"):
            continue
        for project in asana_api.list_projects(client, str(workspace["gid"])):
            if not project.get("gid"):
                continue
            team = project.get("team") if isinstance(project.get("team"), dict) else {}
            projects.append(
                {
                    "gid": str(project["gid"]),
                    "name": str(project.get("name") or "Untitled project"),
                    "workspace_gid": str(workspace["gid"]),
                    "workspace_name": str(workspace.get("name") or ""),
                    "team_name": str(team.get("name") or "") or None,
                    "archived": bool(project.get("archived")),
                    "completed": bool(project.get("completed")),
                    "url": str(project.get("permalink_url") or "") or None,
                }
            )
    return projects


def _team_statuses(repositories: Any, workspace_id: str, team_id: str) -> dict[str, Any]:
    """One team's visible statuses by id."""
    rows = repositories.team_config.list_statuses(workspace_id, team_id, include_hidden=False)
    return {row.status_id: row for row in rows}


def resolve_status(lookup: Any, by_id: dict[str, Any], mapping: AsanaProjectMapping, source: str, done: bool) -> Any:
    """The team status one section or option lands in, and a completed status for a completed task."""
    status = None
    if source:
        chosen = mapping.statuses.get(source)
        status = by_id.get(chosen) if chosen else None
        if status is None:
            status = lookup.status_by_name.get(source.strip().lower())
        if status is None:
            category = status_category(source)
            status = lookup.status_by_category.get(category) if category else None
    status = status or lookup.default_status
    if done and status.category not in ("completed", "cancelled"):
        status = lookup.status_by_category.get("completed", status)
    return status


def _plan(
    repositories: Any, workspace_id: str, client: AsanaClient, choice: ProjectChoice, lookups: dict[str, Any]
) -> ProjectPreview:
    """Read one chosen project from Asana and check its mapping, raising on a project or status that does not fit."""
    from app.common.issue_import import load_lookup

    try:
        project = asana_api.get_project(client, choice.project_gid)
    except AsanaNotFound:
        raise UnknownAsanaProject(choice.project_gid) from None
    fields = asana_api.list_enum_fields(client, choice.project_gid)
    field_name = ""
    if choice.status_field_gid:
        chosen = next((entry for entry in fields if str(entry.get("gid")) == choice.status_field_gid), None)
        if chosen is None:
            raise UnknownStatusChoice("The status field is not a single choice field of the project")
        field_name = str(chosen.get("name") or "")
        sources = [str(option.get("name") or "") for option in chosen.get("enum_options") or []]
    else:
        sources = [str(section.get("name") or "") for section in asana_api.list_sections(client, choice.project_gid)]
    sources = [source for source in dict.fromkeys(sources) if source]
    if choice.team_id not in lookups:
        lookups[choice.team_id] = (
            load_lookup(repositories, workspace_id, choice.team_id),
            _team_statuses(repositories, workspace_id, choice.team_id),
        )
    lookup, by_id = lookups[choice.team_id]
    if any(status_id not in by_id for status_id in choice.statuses.values()):
        raise UnknownStatusChoice("A mapped status is not one of the team's statuses")
    mapping = AsanaProjectMapping(
        project_gid=choice.project_gid,
        name=str(project.get("name") or "Untitled project")[:200],
        team_id=choice.team_id,
        create_project=choice.create_project,
        status_field_gid=choice.status_field_gid,
        status_field_name=field_name[:200],
        statuses={source: status_id for source, status_id in choice.statuses.items() if source in sources},
        created_at=str(project.get("created_at") or ""),
    )
    counts = asana_api.task_counts(client, choice.project_gid)
    plans = []
    for source in sources:
        status = resolve_status(lookup, by_id, mapping, source, False)
        plans.append(StatusPlan(source=source, status_id=status.status_id, status_name=status.name))
    return ProjectPreview(
        mapping=mapping,
        task_count=counts["tasks"],
        completed_count=counts["completed"],
        sections=sources if not choice.status_field_gid else [],
        status_fields=[
            {
                "gid": str(entry.get("gid")),
                "name": str(entry.get("name") or ""),
                "options": [str(option.get("name") or "") for option in entry.get("enum_options") or []],
            }
            for entry in fields
        ],
        statuses=plans,
    )


def preview_projects(
    repositories: Any, workspace_id: str, token: str, choices: list[ProjectChoice]
) -> list[ProjectPreview]:
    """Read each chosen project and say where its tasks would land, writing nothing.

    Raises `UnknownAsanaProject` for a project the token cannot read or one chosen
    twice, and `UnknownStatusChoice` for a mapping that does not fit.
    """
    client = client_factory(token)
    seen: set[str] = set()
    lookups: dict[str, Any] = {}
    previews: list[ProjectPreview] = []
    for choice in choices:
        if not _is_gid(choice.project_gid) or choice.project_gid in seen:
            raise UnknownAsanaProject(choice.project_gid)
        if choice.status_field_gid and not _is_gid(choice.status_field_gid):
            raise UnknownStatusChoice("The status field is not a single choice field of the project")
        seen.add(choice.project_gid)
        previews.append(_plan(repositories, workspace_id, client, choice, lookups))
    return previews


def start_asana_import(repositories: Any, context: AuthzContext, token: str, choices: list[ProjectChoice]) -> Any:
    """Queue an import of Asana projects into Standupless teams, or run it inline where no queue exists.

    Each project and mapping is checked against Asana first. The token is sealed
    beside the job and never stored on it. Refuses like the other imports do.
    """
    from app.common.issue_rules import require_team_member

    issue_import.bucket()
    queue_url = settings.ISSUE_IMPORT_QUEUE_URL.strip()
    if (not queue_url and settings.is_production) or not can_seal():
        raise issue_import.ImportUnavailable("Asana imports are not configured for this environment")
    for choice in choices:
        require_team_member(repositories, context, choice.team_id)
    mappings = [preview.mapping for preview in preview_projects(repositories, context.workspace_id, token, choices)]
    now = utc_now()
    if any(job.is_active(now) for job in issue_import.list_jobs(context.workspace_id, limit=3)):
        raise issue_import.ImportInProgress("An import into this workspace is already running")
    import_id = new_ulid()
    seal_key(context.workspace_id, import_id, token, purpose=SEAL_PURPOSE)
    job = issue_import.save_job(
        issue_import.ImportJob(
            import_id=import_id,
            workspace_id=context.workspace_id,
            team_id=mappings[0].team_id,
            kind=KIND,
            preset=PRESET,
            mapping={},
            asana_projects=mappings,
            file_name="Asana",
            requested_by=context.user_id,
            requester_role=context.role,
            source=context.source,
            created_at=now,
        )
    )
    if queue_url:
        issue_import.enqueue_page(job.workspace_id, job.import_id, 0)
        return job
    return issue_import.run_inline(repositories, job.workspace_id, job.import_id) or job


def phases(job: Any) -> list[tuple[str, Optional[int]]]:
    """Every phase of one job in order: each chosen project's own row, then its tasks."""
    return [(phase, index) for index in range(len(job.asana_projects)) for phase in PROJECT_PHASES]


def _email(value: Any) -> str:
    """The lower cased email of a nested Asana user, or empty."""
    if not isinstance(value, dict):
        return ""
    return str(value.get("email") or "").strip().lower()


def _member(context: TeamContext, user: Any) -> Optional[str]:
    """The member an Asana user is, matched by email, or `None`."""
    email = _email(user)
    return context.lookup.by_email.get(email) if email else None


def _author(context: TeamContext, user: Any) -> str:
    """Who a comment is written as: the matching member, else an `asana:<name>` placeholder."""
    member = _member(context, user)
    if member is not None:
        return member
    name = str(user.get("name") or "").strip() if isinstance(user, dict) else ""
    return f"{ASANA_AUTHOR_PREFIX}{(name or 'Asana user')[:80]}"


def project_row_id(job: Any, mapping: AsanaProjectMapping) -> str:
    """The Standupless project one Asana project becomes."""
    return asana_row_id(job.workspace_id, "project", mapping.project_gid, mapping.created_at or None)


def _project_step(
    repositories: Any, job: Any, client: AsanaClient, mapping: AsanaProjectMapping, context: TeamContext
) -> StepResult:
    """Write the chosen Asana project as a Standupless project, adding the team when another import wrote it."""
    from app.common.db.dynamo.planning import Project, project_key

    result = StepResult()
    if not mapping.create_project:
        return result
    node = asana_api.get_project(client, mapping.project_gid)
    project_id = project_row_id(job, mapping)
    description, _ = _cap(str(node.get("notes") or "").strip() or None)
    fields: dict[str, Any] = {
        "name": str(node.get("name") or "Untitled project").strip()[:120] or "Untitled project",
        "description": description,
        "lead_id": _member(context, node.get("owner")),
        "start_date": _date(node.get("start_on")),
        "target_date": _date(node.get("due_on")),
        "status": "completed" if node.get("completed") else "in_progress",
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
            created_at=_instant(node.get("created_at")) or utc_now(),
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
    return result


def _source(mapping: AsanaProjectMapping, task: dict[str, Any]) -> str:
    """The section or option name a task's status comes from, or empty when it has none."""
    if mapping.status_field_gid:
        for custom in task.get("custom_fields") or []:
            if isinstance(custom, dict) and str(custom.get("gid")) == mapping.status_field_gid:
                value = custom.get("enum_value")
                return str(value.get("name") or "") if isinstance(value, dict) else ""
        return ""
    for membership in task.get("memberships") or []:
        if not isinstance(membership, dict):
            continue
        project = membership.get("project")
        section = membership.get("section")
        if isinstance(project, dict) and str(project.get("gid")) == mapping.project_gid and isinstance(section, dict):
            return str(section.get("name") or "")
    return ""


def _priority(task: dict[str, Any]) -> str:
    """The priority a single choice field named Priority sets, or none."""
    for custom in task.get("custom_fields") or []:
        if not isinstance(custom, dict) or str(custom.get("name") or "").strip().lower() != "priority":
            continue
        value = custom.get("enum_value")
        if isinstance(value, dict):
            return parse_priority(str(value.get("name") or "")) or "none"
    return "none"


def _label_ids(
    repositories: Any, job: Any, context: TeamContext, task: dict[str, Any], result: StepResult
) -> list[str]:
    """The team labels a task's tags map to, created where missing."""
    from app.common.issue_import import label_color

    ids: list[str] = []
    for tag in task.get("tags") or []:
        if not isinstance(tag, dict):
            continue
        name = str(tag.get("name") or "").strip()
        if not name:
            continue
        color = TAG_COLORS.get(str(tag.get("color") or "").lower()) or label_color(name)
        label_id = _ensure_label(repositories, job.workspace_id, context, {"name": name, "color": color}, result)
        if label_id is not None:
            ids.append(label_id)
    return list(dict.fromkeys(ids))


@dataclass
class TaskWriter:
    """What writing one project's tasks needs: the job, the mapping, the team and its statuses."""

    repositories: Any
    job: Any
    client: AsanaClient
    mapping: AsanaProjectMapping
    context: TeamContext
    by_id: dict[str, Any]
    result: StepResult

    def write(self, task: dict[str, Any]) -> Optional[str]:
        """Write or update one task as an issue, answering its id, or `None` when it was left out."""
        from app.common.db.dynamo.activity import build_activity
        from app.common.db.dynamo.issues import Issue, issue_key
        from app.common.issue_import import _assignable
        from app.common.sla import apply_sla

        repositories, job, context, result = self.repositories, self.job, self.context, self.result
        gid = str(task.get("gid") or "")
        ref = f"Asana task {gid}"
        title = str(task.get("name") or "").strip()[:500]
        if not gid or not title:
            result.warn("title", f"{ref}: no name, left out")
            return None
        issue_id = asana_row_id(job.workspace_id, "task", gid, task.get("created_at"))
        existing = repositories.issues.get(job.workspace_id, issue_id)
        if existing is not None and existing.team_id != self.mapping.team_id:
            result.warn("team", f"{ref}: imported before into another team, left there")
            return None
        body, cut = _cap(str(task.get("notes") or "").strip() or None)
        if cut:
            result.warn("description", f"{ref}: the description was cut to fit")
        assignee = _member(context, task.get("assignee"))
        if task.get("assignee") and assignee is None:
            result.warn("assignee", f"{ref}: the assignee is not a member, left unassigned")
        elif assignee is not None and not _assignable(repositories, context.lookup, job.workspace_id, assignee):
            result.warn("assignee", f"{ref}: the assignee cannot see this team, left unassigned")
            assignee = None
        status = resolve_status(
            context.lookup, self.by_id, self.mapping, _source(self.mapping, task), bool(task.get("completed"))
        )
        url = str(task.get("permalink_url") or "").strip()
        fields: dict[str, Any] = {
            "title": title,
            "body": body,
            "status_id": status.status_id,
            "priority": _priority(task),
            "assignee_id": assignee,
            "label_ids": _label_ids(repositories, job, context, task, result),
            "start_date": _date(task.get("start_on")),
            "due_date": _date(task.get("due_on") or task.get("due_at")),
            "project_id": project_row_id(job, self.mapping) if self.mapping.create_project else None,
            "external_ref": f"Asana {gid} {url}".strip()[:500],
            "import_batch_id": job.import_id,
        }
        now = utc_now()
        if existing is not None:
            updated = existing.model_copy(
                update={**fields, "updated_at": now, "updated_by": job.requested_by, "updated_source": job.source}
            )
            repositories.issues.replace(updated, keep_import_batch=True)
            result.add("issues_updated")
            return issue_id
        creator = _member(context, task.get("created_by")) or job.requested_by
        number = repositories.counters.allocate_issue_number(job.workspace_id, self.mapping.team_id)
        created_at = _instant(task.get("created_at"))
        issue = Issue(
            workspace_id=job.workspace_id,
            issue_id=issue_id,
            team_id=self.mapping.team_id,
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
            build_activity(job.workspace_id, self.mapping.team_id, issue_id, creator, "created", source=job.source)
        )
        if created.assignee_id:
            repositories.subscriptions.subscribe(
                job.workspace_id, issue_id, self.mapping.team_id, created.assignee_id, "assignee"
            )
        result.add("issues_created")
        return issue_id

    def comments(self, task_gid: str, issue_id: str) -> None:
        """Write or update every comment of one task with its author and time."""
        from app.common.db.dynamo.comments import build_comment

        job, context = self.job, self.context
        for story in asana_api.list_comments(self.client, task_gid):
            body, _ = _cap(str(story.get("text") or "").strip() or None)
            if not body or not story.get("gid"):
                continue
            comment_id = asana_row_id(job.workspace_id, "comment", story["gid"], story.get("created_at"))
            comment = build_comment(
                job.workspace_id,
                issue_id,
                context.team_id,
                _author(context, story.get("created_by")),
                body,
                source=job.source,
            ).model_copy(
                update={
                    "comment_id": comment_id,
                    "created_at": _instant(story.get("created_at")) or utc_now(),
                    "import_batch_id": job.import_id,
                }
            )
            existing = self.repositories.comments.get(job.workspace_id, issue_id, comment_id)
            if existing is None:
                try:
                    self.repositories.comments.create(comment)
                except ConditionFailed:
                    continue
            elif existing.body != body or existing.author_id != comment.author_id:
                self.repositories.comments.replace_imported(comment)
            self.result.add("comments")

    def link(self, issue_id: str, parent_id: str) -> None:
        """Make one written subtask a sub-issue of its top level task, warning when it cannot be."""
        from app.common.issue_rules import check_parent

        issue = self.repositories.issues.get(self.job.workspace_id, issue_id)
        if issue is None or issue.parent_id:
            return
        try:
            check_parent(self.repositories, self.job.workspace_id, issue.team_id, issue_id, parent_id)
        except HTTPException:
            self.result.warn("parent", f"{issue.key}: the Asana parent cannot be its parent here, left without one")
            return
        job = self.job
        if self.repositories.issues.link_imported_parent(job.workspace_id, issue_id, parent_id, job.import_id):
            self.result.add("sub_issues")

    def subtasks(self, task: dict[str, Any], top_id: str, depth: int) -> None:
        """Write a task's subtasks, and theirs, each as a sub-issue of the top level task."""
        if not int(task.get("num_subtasks") or 0):
            return
        if depth > MAX_SUBTASK_DEPTH:
            self.result.warn("parent", f"Asana task {task.get('gid')}: subtasks nested too deep, left out")
            return
        for child in asana_api.list_subtasks(self.client, str(task["gid"])):
            child_id = self.write(child)
            if child_id is None:
                continue
            self.comments(str(child["gid"]), child_id)
            self.link(child_id, top_id)
            self.subtasks(child, top_id, depth + 1)


def _tasks_step(
    repositories: Any, job: Any, client: AsanaClient, mapping: AsanaProjectMapping, context: TeamContext
) -> StepResult:
    """Write one page of a project's top level tasks, each with its comments and subtasks."""
    result = StepResult()
    writer = TaskWriter(
        repositories=repositories,
        job=job,
        client=client,
        mapping=mapping,
        context=context,
        by_id=_team_statuses(repositories, job.workspace_id, mapping.team_id),
        result=result,
    )
    page = asana_api.task_page(client, mapping.project_gid, job.after, PAGE_SIZE)
    for task in page.data:
        issue_id = writer.write(task)
        if issue_id is None:
            continue
        writer.comments(str(task["gid"]), issue_id)
        writer.subtasks(task, issue_id, 1)
    result.next_after = page.offset
    return result


def run_step(repositories: Any, job: Any, client: AsanaClient) -> StepResult:
    """Read and write the page of the phase the job is at."""
    phase, index = phases(job)[job.phase_index]
    mapping = job.asana_projects[index or 0]
    context = _team_context(repositories, job.workspace_id, mapping.team_id)
    handlers = {"project": _project_step, "tasks": _tasks_step}
    return handlers[phase](repositories, job, client, mapping, context)


def run_asana_page(repositories: Any, job: Any) -> Any:
    """Run the step the job is at and move it on, completing it after the last phase.

    The job is read again before its progress is saved, so a cancel that landed
    while the step ran is kept rather than overwritten. A refused token, or a
    project the token can no longer see, fails the job at once, since no retry
    can fix it.
    """
    try:
        token = open_key(job.workspace_id, job.import_id, purpose=SEAL_PURPOSE)
    except KeyGone as exc:
        return issue_import.fail(repositories, job, exc)
    try:
        result = run_step(repositories, job, client_factory(token))
    except (AsanaAuthFailed, AsanaNotFound) as exc:
        _log.warning(
            "An Asana import cannot read its projects.",
            extra={"event": "issue.import.asana_refused", "import_id": job.import_id, "error": type(exc).__name__},
        )
        return issue_import.fail(repositories, job, exc)
    current = issue_import.load_job(job.workspace_id, job.import_id)
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
    updated = issue_import.save_job(
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
                "problems": problems[: issue_import.MAX_PROBLEMS],
                "problems_truncated": job.problems_truncated or len(problems) > issue_import.MAX_PROBLEMS,
                "status": "completed" if done else "running",
                "finished_at": utc_now() if done else None,
            }
        )
    )
    if done:
        delete_key(job.workspace_id, job.import_id)
        issue_import.notify(repositories, updated)
    return updated


issue_import.PAGE_RUNNERS[KIND] = run_asana_page
