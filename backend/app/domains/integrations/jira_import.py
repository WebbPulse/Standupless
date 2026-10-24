"""Import chosen Jira Cloud projects or JQL filters through Jira's REST API, a page at a time on the import queue.

A Jira import is an `ImportJob` of kind `jira`, so it shares the other importers'
job object, queue, page retries, stale job detection, cancel and inbox notice.
Each chosen project, or JQL filter, goes into one team and walks three phases:
`epics`, which writes each epic as a Standupless project when the admin chose
projects for epics; `issues`, which reads the issues a page at a time and writes
each with its comments; and `links`, which, once every issue is written, makes
sub-tasks sub-issues, children of an epic sub-issues of it when the admin chose
parents for epics, and issue links relations. `phase_index` and `after`, the id
of the last issue read, say where the job is, and `cursor` counts the steps so
the queue's duplicate guard works unchanged.

A status maps by its Jira status category unless the admin mapped it or the
team has a status of the same name: To Do lands unstarted, In Progress started
and Done completed. An issue's type and its Jira labels become labels, the
priority maps by name, story points become an estimate on the team's scale, and
the newest sprint an issue sits in becomes a cycle of the team. Assignees,
reporters and comment authors are matched to members by email, which Jira only
shares when the person allows it. A comment whose author matches no member is
written under a `jira:<name>` placeholder, and no account or invite is ever
created. Descriptions and comments are converted from ADF to markdown by
`jira_adf`, deterministically.

Every row an import writes gets an id derived from the workspace and the Jira id,
with the Jira creation time as its time part where Jira gives it, so a step that
runs twice, and a later import of the same project, finds the rows already
written and updates them rather than writing them again. Each issue's
`external_ref` carries the Jira key and the issue's URL.

The account email and API token the admin pasted are sealed together beside the
job in `key.json` under their own purpose, bound to the workspace and import,
and are the only copy kept. They are opened in memory for each step, deleted
when the job completes, fails or is cancelled, and never written to the job, a
log, an audit row or any imported data.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from fastapi import HTTPException
from webbpulse.dynamodb import ConditionFailed, new_ulid

from app.common import issue_import
from app.common.api.dependencies.authz import AuthzContext
from app.common.core.config import settings
from app.common.csv_import import parse_priority, status_category
from app.common.db.dynamo.base import utc_now
from app.common.issue_import import JiraProjectMapping
from app.common.linear_import import (
    KeyGone,
    StepResult,
    TeamContext,
    _cap,
    _date,
    _ensure_label,
    _estimate,
    _instant,
    _team_context,
    can_seal,
    delete_key,
    linear_row_id,
    open_key,
    seal_key,
)
from app.domains.integrations import jira_api
from app.domains.integrations.jira_adf import to_markdown
from app.domains.integrations.jira_api import JiraAuthFailed, JiraBadQuery, JiraClient, JiraNotFound

_log = logging.getLogger(__name__)

KIND = "jira"

PRESET = "jira_api"

SEAL_PURPOSE = "jira_import_key"
"""The purpose Jira credentials are sealed under, so they never open as another importer's key."""

JIRA_AUTHOR_PREFIX = "jira:"

PAGE_SIZE = 20
"""Issues one step writes, each with its comments, so a step ends inside its invocation."""

SCAN_PAGE_SIZE = 100
"""Issues one epics or links step reads, since those steps make no call per issue."""

MAX_STATUSES = 200
"""How many statuses a preview lists."""

PROJECT_PHASES: tuple[str, ...] = ("epics", "issues", "links")

EPIC_MODES: tuple[str, ...] = ("projects", "parents")

CATEGORY_BY_JIRA: dict[str, str] = {"new": "unstarted", "indeterminate": "started", "done": "completed"}
"""Jira's three status category keys as the status categories a Standupless team groups its statuses in."""

PROJECT_STATUS_BY_JIRA: dict[str, str] = {"new": "planned", "indeterminate": "in_progress", "done": "completed"}

KEY_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]{0,49}$")

ORDER_BY = re.compile(r"\border\s+by\b.*$", re.IGNORECASE | re.DOTALL)

MAX_JQL = 2000


class UnknownJiraProject(Exception):
    """A chosen Jira project is not one the account can browse, or was chosen twice."""


class InvalidJql(Exception):
    """A JQL filter Jira refused, or a choice with neither a project nor a filter."""


class UnknownStatusChoice(Exception):
    """A status mapping names a status the team lacks."""


ClientFactory = Callable[[str, str, str], JiraClient]


def _default_client(site: str, email: str, token: str) -> JiraClient:
    """A Jira client for one site and account."""
    return JiraClient(url=site, email=email, token=token)


client_factory: ClientFactory = _default_client
"""How a step builds its Jira client, which the tests point at a fake Jira site."""


@dataclass
class ProjectChoice:
    """One project or JQL filter the admin picked: the team it goes into and how its issues map."""

    team_id: str
    project_key: str = ""
    jql: str = ""
    epics_as: str = "projects"
    statuses: dict[str, str] = field(default_factory=dict)


@dataclass
class StatusPlan:
    """Where one Jira status lands."""

    source: str
    category: str
    status_id: str
    status_name: str


@dataclass
class ProjectPreview:
    """What importing one project or filter would do, read from Jira without writing anything."""

    mapping: JiraProjectMapping
    issue_count: int
    done_count: int
    statuses: list[StatusPlan]
    estimate_field: Optional[str]
    sprint_field: Optional[str]


@dataclass
class Credentials:
    """The account email and API token one import signs in to Jira with."""

    email: str = field(repr=False)
    token: str = field(repr=False)

    def sealed(self) -> str:
        """The pair as the one string sealed beside the job."""
        return json.dumps({"email": self.email, "token": self.token})

    @classmethod
    def opened(cls, value: str) -> "Credentials":
        """The pair back from the sealed string, raising `KeyGone` when it is not one."""
        try:
            data = json.loads(value)
        except ValueError:
            raise KeyGone("The sealed Jira credentials cannot be read") from None
        if not isinstance(data, dict) or not data.get("email") or not data.get("token"):
            raise KeyGone("The sealed Jira credentials cannot be read")
        return cls(email=str(data["email"]), token=str(data["token"]))


def jira_row_id(workspace_id: str, kind: str, jira_id: Any, created_at: Any) -> str:
    """The id one Jira record always becomes in one workspace, so a re-run finds what it wrote."""
    return linear_row_id(workspace_id, f"jira_{kind}", str(jira_id), created_at)


def clean_jql(value: str) -> str:
    """A JQL filter without its `ORDER BY`, since the importer orders by id to page."""
    return ORDER_BY.sub("", value.strip()).strip()[:MAX_JQL]


def scope_jql(mapping: JiraProjectMapping) -> str:
    """The query naming every issue one mapping imports."""
    parts = []
    if mapping.project_key:
        parts.append(f'project = "{mapping.project_key}"')
    if mapping.jql:
        parts.append(f"({mapping.jql})")
    return " AND ".join(parts)


def page_jql(mapping: JiraProjectMapping, after: Optional[str]) -> str:
    """The query for the page after the issue id `after`, in id order."""
    scope = scope_jql(mapping)
    if after and after.isdigit():
        return f"({scope}) AND id > {after} ORDER BY id ASC"
    return f"({scope}) ORDER BY id ASC"


def read_projects(site: str, email: str, token: str) -> list[dict[str, Any]]:
    """Every project the account can browse on the site, raising `JiraAuthFailed` for refused credentials."""
    client = client_factory(site, email, token)
    jira_api.myself(client)
    projects: list[dict[str, Any]] = []
    for project in jira_api.list_projects(client):
        key = str(project.get("key") or "")
        if not key:
            continue
        projects.append(
            {
                "id": str(project.get("id") or ""),
                "key": key,
                "name": str(project.get("name") or key),
                "project_type": str(project.get("projectTypeKey") or "") or None,
                "team_managed": project.get("style") == "next-gen" or bool(project.get("simplified")),
                "archived": bool(project.get("archived")),
                "url": f"{client.url}/browse/{key}",
            }
        )
    return projects


def _team_statuses(repositories: Any, workspace_id: str, team_id: str) -> dict[str, Any]:
    """One team's visible statuses by id."""
    rows = repositories.team_config.list_statuses(workspace_id, team_id, include_hidden=False)
    return {row.status_id: row for row in rows}


def _category_key(status: Any) -> str:
    """The category key of a Jira status object, `new`, `indeterminate` or `done`, or empty."""
    if not isinstance(status, dict):
        return ""
    category = status.get("statusCategory")
    return str(category.get("key") or "").lower() if isinstance(category, dict) else ""


def resolve_status(lookup: Any, by_id: dict[str, Any], mapping: JiraProjectMapping, name: str, category: str) -> Any:
    """The team status one Jira status lands in, and a completed status for one in Jira's Done category."""
    status = None
    if name:
        chosen = mapping.statuses.get(name)
        status = by_id.get(chosen) if chosen else None
        if status is None:
            status = lookup.status_by_name.get(name.strip().lower())
    if status is None and category in CATEGORY_BY_JIRA:
        status = lookup.status_by_category.get(CATEGORY_BY_JIRA[category])
    if status is None and name:
        guessed = status_category(name)
        status = lookup.status_by_category.get(guessed) if guessed else None
    status = status or lookup.default_status
    if category == "done" and status.category not in ("completed", "cancelled"):
        status = lookup.status_by_category.get("completed", status)
    return status


def _sources(client: JiraClient, project_key: str, site_statuses: list[dict[str, Any]]) -> list[tuple[str, str]]:
    """Each status one mapping's issues may be in, with its category key."""
    categories: dict[str, str] = {}
    for entry in site_statuses:
        name = str(entry.get("name") or "")
        if name and name not in categories:
            categories[name] = _category_key(entry)
    names = jira_api.project_status_names(client, project_key) if project_key else list(categories)
    return [(name, categories.get(name, "")) for name in names[:MAX_STATUSES]]


def _plan(
    repositories: Any,
    workspace_id: str,
    client: JiraClient,
    choice: ProjectChoice,
    lookups: dict[str, Any],
    site: dict[str, Any],
) -> ProjectPreview:
    """Read one chosen project or filter from Jira and check its mapping, raising on one that does not fit."""
    from app.common.issue_import import load_lookup

    name = "JQL filter"
    if choice.project_key:
        try:
            project = jira_api.get_project(client, choice.project_key)
        except JiraNotFound:
            raise UnknownJiraProject(choice.project_key) from None
        name = str(project.get("name") or choice.project_key)
        if choice.jql:
            name = f"{name} (filtered)"
    if choice.team_id not in lookups:
        lookups[choice.team_id] = (
            load_lookup(repositories, workspace_id, choice.team_id),
            _team_statuses(repositories, workspace_id, choice.team_id),
        )
    lookup, by_id = lookups[choice.team_id]
    if any(status_id not in by_id for status_id in choice.statuses.values()):
        raise UnknownStatusChoice("A mapped status is not one of the team's statuses")
    if "statuses" not in site:
        site["statuses"] = jira_api.list_statuses(client)
        site["points"], site["sprint"] = jira_api.estimate_and_sprint_fields(jira_api.list_fields(client))
    sources = _sources(client, choice.project_key, site["statuses"])
    names = {source for source, _ in sources}
    sprint = site["sprint"]
    mapping = JiraProjectMapping(
        site_url=client.url,
        project_key=choice.project_key,
        jql=choice.jql,
        name=name[:200],
        team_id=choice.team_id,
        epics_as="parents" if choice.epics_as == "parents" else "projects",
        statuses={source: status_id for source, status_id in choice.statuses.items() if source in names},
        estimate_fields=[entry["id"] for entry in site["points"]],
        sprint_field=sprint["id"] if sprint else "",
    )
    scope = scope_jql(mapping)
    try:
        issue_count = jira_api.count(client, scope)
        done_count = jira_api.count(client, f"({scope}) AND statusCategory = Done")
    except JiraBadQuery:
        raise InvalidJql("Jira refused the JQL filter. Check it runs in Jira's issue search.") from None
    plans = []
    for source, category in sources:
        status = resolve_status(lookup, by_id, mapping, source, category)
        plans.append(
            StatusPlan(source=source, category=category, status_id=status.status_id, status_name=status.name)
        )
    return ProjectPreview(
        mapping=mapping,
        issue_count=issue_count,
        done_count=done_count,
        statuses=plans,
        estimate_field=site["points"][0]["name"] if site["points"] else None,
        sprint_field=sprint["name"] if sprint else None,
    )


def _checked(choice: ProjectChoice) -> ProjectChoice:
    """A choice with its key upper cased and its filter cleaned, raising when it names nothing to import."""
    key = choice.project_key.strip().upper()
    if key and not KEY_PATTERN.match(key):
        raise UnknownJiraProject(choice.project_key)
    jql = clean_jql(choice.jql)
    if not key and not jql:
        raise InvalidJql("Each choice needs a Jira project key or a JQL filter")
    if choice.epics_as not in EPIC_MODES:
        raise InvalidJql("Epics become either projects or parents")
    return ProjectChoice(
        team_id=choice.team_id, project_key=key, jql=jql, epics_as=choice.epics_as, statuses=dict(choice.statuses)
    )


def preview_projects(
    repositories: Any, workspace_id: str, site: str, credentials: Credentials, choices: list[ProjectChoice]
) -> list[ProjectPreview]:
    """Read each chosen project or filter and say where its issues would land, writing nothing.

    Raises `jira_api.InvalidSite` for a site that is not Jira Cloud,
    `UnknownJiraProject` for a project the account cannot browse or one chosen
    twice, `InvalidJql` for a filter Jira refuses, and `UnknownStatusChoice` for
    a mapping that does not fit.
    """
    client = client_factory(jira_api.site_url(site), credentials.email, credentials.token)
    checked = [_checked(choice) for choice in choices]
    seen: set[tuple[str, str]] = set()
    for choice in checked:
        if (choice.project_key, choice.jql) in seen:
            raise UnknownJiraProject(choice.project_key)
        seen.add((choice.project_key, choice.jql))
    lookups: dict[str, Any] = {}
    shared: dict[str, Any] = {}
    return [_plan(repositories, workspace_id, client, choice, lookups, shared) for choice in checked]


def start_jira_import(
    repositories: Any, context: AuthzContext, site: str, credentials: Credentials, choices: list[ProjectChoice]
) -> Any:
    """Queue an import of Jira projects into Standupless teams, or run it inline where no queue exists.

    Each project and mapping is checked against Jira first. The credentials are
    sealed beside the job and never stored on it. Refuses like the other imports do.
    """
    from app.common.issue_rules import require_team_member

    issue_import.bucket()
    queue_url = settings.ISSUE_IMPORT_QUEUE_URL.strip()
    if (not queue_url and settings.is_production) or not can_seal():
        raise issue_import.ImportUnavailable("Jira imports are not configured for this environment")
    for choice in choices:
        require_team_member(repositories, context, choice.team_id)
    previews = preview_projects(repositories, context.workspace_id, site, credentials, choices)
    mappings = [preview.mapping for preview in previews]
    now = utc_now()
    if any(job.is_active(now) for job in issue_import.list_jobs(context.workspace_id, limit=3)):
        raise issue_import.ImportInProgress("An import into this workspace is already running")
    import_id = new_ulid()
    seal_key(context.workspace_id, import_id, credentials.sealed(), purpose=SEAL_PURPOSE)
    job = issue_import.save_job(
        issue_import.ImportJob(
            import_id=import_id,
            workspace_id=context.workspace_id,
            team_id=mappings[0].team_id,
            kind=KIND,
            preset=PRESET,
            mapping={},
            jira_projects=mappings,
            file_name="Jira",
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


def audit_after(job: Any) -> dict[str, Any]:
    """What the audit row records about a started import: the site, each project or filter and its team."""
    return {
        "preset": job.preset,
        "projects": [
            {
                "site_url": mapping.site_url,
                "project_key": mapping.project_key or None,
                "jql": bool(mapping.jql),
                "team_id": mapping.team_id,
            }
            for mapping in job.jira_projects
        ],
    }


def phases(job: Any) -> list[tuple[str, Optional[int]]]:
    """Every phase of one job in order: each chosen project's epics, then its issues, then its links."""
    return [(phase, index) for index in range(len(job.jira_projects)) for phase in PROJECT_PHASES]


def _email(user: Any) -> str:
    """The lower cased email of a Jira user, or empty when Jira hides it."""
    if not isinstance(user, dict):
        return ""
    return str(user.get("emailAddress") or "").strip().lower()


def _member(context: TeamContext, user: Any) -> Optional[str]:
    """The member a Jira user is, matched by email, or `None`."""
    email = _email(user)
    return context.lookup.by_email.get(email) if email else None


def _author(context: TeamContext, user: Any) -> str:
    """Who a comment is written as: the matching member, else a `jira:<name>` placeholder."""
    member = _member(context, user)
    if member is not None:
        return member
    name = str(user.get("displayName") or "").strip() if isinstance(user, dict) else ""
    return f"{JIRA_AUTHOR_PREFIX}{(name or 'Jira user')[:80]}"


def _fields(issue: dict[str, Any]) -> dict[str, Any]:
    """An issue's fields, or none."""
    fields = issue.get("fields")
    return fields if isinstance(fields, dict) else {}


def _is_epic(issue: Any) -> bool:
    """Whether an issue, or the parent reference of one, is an epic."""
    if not isinstance(issue, dict):
        return False
    issue_type = _fields(issue).get("issuetype")
    if not isinstance(issue_type, dict):
        return False
    level = issue_type.get("hierarchyLevel")
    if isinstance(level, int):
        return level == 1
    return str(issue_type.get("name") or "").strip().lower() == "epic"


def epic_project_id(job: Any, epic_id: Any) -> str:
    """The Standupless project one Jira epic becomes."""
    return jira_row_id(job.workspace_id, "epic", epic_id, None)


def issue_row_id(job: Any, issue: dict[str, Any]) -> str:
    """The Standupless issue one Jira issue becomes."""
    return jira_row_id(job.workspace_id, "issue", issue.get("id"), _fields(issue).get("created"))


def _epics_step(
    repositories: Any, job: Any, client: JiraClient, mapping: JiraProjectMapping, context: TeamContext
) -> StepResult:
    """Write one page of epics as Standupless projects, when the admin chose projects for epics."""
    from app.common.db.dynamo.planning import Project, project_key

    result = StepResult()
    if mapping.epics_as != "projects":
        return result
    page = jira_api.search(client, page_jql(mapping, job.after), jira_api.EPIC_FIELDS, SCAN_PAGE_SIZE)
    for issue in page.issues:
        if not _is_epic(issue) or not issue.get("id"):
            continue
        fields = _fields(issue)
        project_id = epic_project_id(job, issue["id"])
        description, _ = _cap(to_markdown(fields.get("description")) or None)
        values: dict[str, Any] = {
            "name": str(fields.get("summary") or "Untitled epic").strip()[:120] or "Untitled epic",
            "description": description,
            "lead_id": _member(context, fields.get("assignee")),
            "target_date": _date(fields.get("duedate")),
            "status": PROJECT_STATUS_BY_JIRA.get(_category_key(fields.get("status")), "planned"),
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
                created_at=_instant(fields.get("created")) or utc_now(),
                **values,
            )
            try:
                repositories.planning.create_project(project)
            except ConditionFailed:
                existing = repositories.planning.get_project(job.workspace_id, project_id)
        if existing is not None:
            team_ids = list(dict.fromkeys([*existing.team_ids, mapping.team_id]))
            repositories.planning.replace_project(
                existing.model_copy(update={**values, "team_ids": team_ids}), keep_import_batch=True
            )
        result.add("projects")
    result.next_after = _next_after(page)
    return result


def _next_after(page: jira_api.JiraPage) -> Optional[str]:
    """The id the next page starts after, or `None` after the last page."""
    if page.is_last or not page.issues:
        return None
    last = str(page.issues[-1].get("id") or "")
    return last if last.isdigit() else None


@dataclass
class IssueWriter:
    """What writing one mapping's issues needs: the job, the mapping, the team and its statuses."""

    repositories: Any
    job: Any
    client: JiraClient
    mapping: JiraProjectMapping
    context: TeamContext
    by_id: dict[str, Any]
    result: StepResult
    cycles: dict[str, Optional[str]] = field(default_factory=dict)
    projects: dict[str, bool] = field(default_factory=dict)

    def labels(self, fields: dict[str, Any]) -> list[str]:
        """The team labels an issue's type and Jira labels map to, created where missing."""
        from app.common.issue_import import label_color

        names = []
        issue_type = fields.get("issuetype")
        if isinstance(issue_type, dict) and issue_type.get("name"):
            names.append(str(issue_type["name"]).strip())
        names.extend(str(name).strip() for name in fields.get("labels") or [] if isinstance(name, str))
        ids: list[str] = []
        for name in dict.fromkeys(name[:60] for name in names if name):
            label_id = _ensure_label(
                self.repositories,
                self.job.workspace_id,
                self.context,
                {"name": name, "color": label_color(name)},
                self.result,
            )
            if label_id is not None:
                ids.append(label_id)
        return list(dict.fromkeys(ids))

    def estimate(self, fields: dict[str, Any], key: str) -> Optional[str]:
        """The issue's story points on the team's scale, from the first story point field that holds a value."""
        for field_id in self.mapping.estimate_fields:
            value = fields.get(field_id)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return _estimate(self.context, value, key, self.result)
        return None

    def cycle(self, fields: dict[str, Any], key: str) -> Optional[str]:
        """The cycle the issue's newest sprint becomes, written the first time a step meets it."""
        from app.common.db.dynamo.planning import Cycle, cycle_key

        sprints = fields.get(self.mapping.sprint_field) if self.mapping.sprint_field else None
        if not isinstance(sprints, list):
            return None
        sprint = next((entry for entry in reversed(sprints) if isinstance(entry, dict) and entry.get("id")), None)
        if sprint is None:
            return None
        sprint_id = str(sprint["id"])
        if sprint_id in self.cycles:
            return self.cycles[sprint_id]
        job, team_id = self.job, self.mapping.team_id
        start, end = _date(sprint.get("startDate")), _date(sprint.get("endDate"))
        if not start or not end:
            self.result.warn("cycle", f"{key}: the sprint has no dates yet, left out of a cycle")
            self.cycles[sprint_id] = None
            return None
        cycle_id = jira_row_id(job.workspace_id, f"sprint_{team_id}", sprint_id, sprint.get("startDate"))
        values = {
            "name": (str(sprint.get("name") or "").strip() or "Sprint")[:120],
            "start_date": start,
            "end_date": max(start, end),
            "goal": str(sprint.get("goal") or "").strip() or None,
            "import_batch_id": job.import_id,
            "updated_at": utc_now(),
        }
        existing = self.repositories.planning.get_cycle(job.workspace_id, team_id, cycle_id)
        if existing is None:
            try:
                self.repositories.planning.create_cycle(
                    Cycle(
                        workspace_id=job.workspace_id,
                        planning_key=cycle_key(team_id, cycle_id),
                        cycle_id=cycle_id,
                        team_id=team_id,
                        created_by=job.requested_by,
                        created_at=_instant(sprint.get("startDate")) or utc_now(),
                        **values,
                    )
                )
            except ConditionFailed:
                pass
        else:
            self.repositories.planning.replace_cycle(existing.model_copy(update=values), keep_import_batch=True)
        self.result.add("cycles")
        self.cycles[sprint_id] = cycle_id
        return cycle_id

    def project(self, fields: dict[str, Any]) -> Optional[str]:
        """The project the issue's epic became, when epics became projects and that one was written."""
        parent = fields.get("parent")
        if self.mapping.epics_as != "projects" or not _is_epic(parent) or not parent.get("id"):
            return None
        project_id = epic_project_id(self.job, parent["id"])
        if project_id not in self.projects:
            found = self.repositories.planning.get_project(self.job.workspace_id, project_id)
            self.projects[project_id] = found is not None
        return project_id if self.projects[project_id] else None

    def write(self, issue: dict[str, Any]) -> Optional[str]:
        """Write or update one Jira issue as a Standupless issue, answering its id, or `None` when it was left out."""
        from app.common.db.dynamo.activity import build_activity
        from app.common.db.dynamo.issues import Issue, issue_key
        from app.common.issue_import import _assignable
        from app.common.sla import apply_sla

        repositories, job, context, result = self.repositories, self.job, self.context, self.result
        fields = _fields(issue)
        key = str(issue.get("key") or issue.get("id") or "")
        title = str(fields.get("summary") or "").strip()[:500]
        if not issue.get("id") or not title:
            result.warn("title", f"{key or 'A Jira issue'}: no summary, left out")
            return None
        issue_id = issue_row_id(job, issue)
        existing = repositories.issues.get(job.workspace_id, issue_id)
        if existing is not None and existing.team_id != self.mapping.team_id:
            result.warn("team", f"{key}: imported before into another team, left there")
            return None
        body, cut = _cap(to_markdown(fields.get("description")) or None)
        if cut:
            result.warn("description", f"{key}: the description was cut to fit")
        assignee = _member(context, fields.get("assignee"))
        if fields.get("assignee") and assignee is None:
            result.warn("assignee", f"{key}: the assignee is not a member or hides their email, left unassigned")
        elif assignee is not None and not _assignable(repositories, context.lookup, job.workspace_id, assignee):
            result.warn("assignee", f"{key}: the assignee cannot see this team, left unassigned")
            assignee = None
        jira_status = fields.get("status") if isinstance(fields.get("status"), dict) else {}
        status = resolve_status(
            context.lookup,
            self.by_id,
            self.mapping,
            str(jira_status.get("name") or ""),
            _category_key(jira_status),
        )
        priority = fields.get("priority") if isinstance(fields.get("priority"), dict) else {}
        url = f"{self.mapping.site_url}/browse/{key}"
        values: dict[str, Any] = {
            "title": title,
            "body": body,
            "status_id": status.status_id,
            "priority": parse_priority(str(priority.get("name") or "")) or "none",
            "assignee_id": assignee,
            "label_ids": self.labels(fields),
            "estimate": self.estimate(fields, key),
            "due_date": _date(fields.get("duedate")),
            "cycle_id": self.cycle(fields, key),
            "project_id": self.project(fields),
            "external_ref": f"Jira {key} {url}"[:500],
            "import_batch_id": job.import_id,
        }
        now = utc_now()
        if existing is not None:
            updated = existing.model_copy(
                update={**values, "updated_at": now, "updated_by": job.requested_by, "updated_source": job.source}
            )
            repositories.issues.replace(updated, keep_import_batch=True)
            result.add("issues_updated")
            return issue_id
        creator = _member(context, fields.get("reporter")) or _member(context, fields.get("creator"))
        creator = creator or job.requested_by
        number = repositories.counters.allocate_issue_number(job.workspace_id, self.mapping.team_id)
        created_at = _instant(fields.get("created"))
        row = Issue(
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
            **values,
        )
        apply_sla(repositories, None, row)
        try:
            created = repositories.issues.create(row)
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

    def comments(self, jira_issue_id: str, issue_id: str) -> None:
        """Write or update every comment of one issue with its author and time."""
        from app.common.db.dynamo.comments import build_comment

        job, context = self.job, self.context
        for entry in jira_api.list_comments(self.client, jira_issue_id):
            body, _ = _cap(to_markdown(entry.get("body")) or None)
            if not body or not entry.get("id"):
                continue
            comment_id = jira_row_id(job.workspace_id, "comment", entry["id"], entry.get("created"))
            comment = build_comment(
                job.workspace_id,
                issue_id,
                context.team_id,
                _author(context, entry.get("author")),
                body,
                source=job.source,
            ).model_copy(
                update={
                    "comment_id": comment_id,
                    "created_at": _instant(entry.get("created")) or utc_now(),
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


def _issues_step(
    repositories: Any, job: Any, client: JiraClient, mapping: JiraProjectMapping, context: TeamContext
) -> StepResult:
    """Write one page of a mapping's issues, each with its comments; epics too when they become parents."""
    result = StepResult()
    writer = IssueWriter(
        repositories=repositories,
        job=job,
        client=client,
        mapping=mapping,
        context=context,
        by_id=_team_statuses(repositories, job.workspace_id, mapping.team_id),
        result=result,
    )
    extra = tuple(mapping.estimate_fields) + ((mapping.sprint_field,) if mapping.sprint_field else ())
    page = jira_api.search(client, page_jql(mapping, job.after), jira_api.ISSUE_FIELDS + extra, PAGE_SIZE)
    for issue in page.issues:
        if mapping.epics_as == "projects" and _is_epic(issue):
            continue
        issue_id = writer.write(issue)
        if issue_id is not None:
            writer.comments(str(issue["id"]), issue_id)
    result.next_after = _next_after(page)
    return result


RELATION_BY_LINK: dict[str, str] = {"blocks": "blocks", "duplicate": "duplicate_of"}
"""Jira link type names as the relation an outward link means; any other link type relates the two issues."""


def _link_ends(issue_id: str, link: dict[str, Any], target_id: str) -> Optional[tuple[str, str, str]]:
    """The source, relation type and target one Jira issue link becomes, read from the issue's side."""
    link_type = link.get("type") if isinstance(link.get("type"), dict) else {}
    relation = RELATION_BY_LINK.get(str(link_type.get("name") or "").strip().lower(), "relates_to")
    if relation == "relates_to" or isinstance(link.get("outwardIssue"), dict):
        return issue_id, relation, target_id
    return target_id, relation, issue_id


def _links_step(
    repositories: Any, job: Any, client: JiraClient, mapping: JiraProjectMapping, context: TeamContext
) -> StepResult:
    """Link one page of a mapping's issues to their parents and linked issues, now every issue is written."""
    from app.common.issue_rules import check_parent
    from app.common.relation_effects import blocked_side, recount_blocked, recount_relations

    result = StepResult()
    page = jira_api.search(client, page_jql(mapping, job.after), jira_api.LINK_FIELDS, SCAN_PAGE_SIZE)
    created: dict[str, str] = {}
    wanted: list[str] = []
    for issue in page.issues:
        fields = _fields(issue)
        if issue.get("id") and fields.get("created"):
            created[str(issue["id"])] = str(fields["created"])
        parent = fields.get("parent")
        if isinstance(parent, dict) and parent.get("id"):
            wanted.append(str(parent["id"]))
        for link in fields.get("issuelinks") or []:
            target = (link.get("outwardIssue") or link.get("inwardIssue")) if isinstance(link, dict) else None
            if isinstance(target, dict) and target.get("id"):
                wanted.append(str(target["id"]))
    missing = [jira_id for jira_id in dict.fromkeys(wanted) if jira_id not in created]
    if missing:
        created.update(jira_api.created_times(client, missing))

    def row(jira_id: str) -> Optional[str]:
        """The issue a Jira id became, or `None` when the import never wrote it."""
        if jira_id not in created:
            return None
        return jira_row_id(job.workspace_id, "issue", jira_id, created[jira_id])

    for node in page.issues:
        if not node.get("id") or (mapping.epics_as == "projects" and _is_epic(node)):
            continue
        fields = _fields(node)
        issue_id = issue_row_id(job, node)
        issue = repositories.issues.get(job.workspace_id, issue_id)
        if issue is None or issue.team_id != mapping.team_id:
            continue
        parent = fields.get("parent")
        linkable = isinstance(parent, dict) and parent.get("id") and not (
            mapping.epics_as == "projects" and _is_epic(parent)
        )
        parent_id = row(str(parent["id"])) if linkable and isinstance(parent, dict) else None
        if parent_id is not None and not issue.parent_id:
            try:
                check_parent(repositories, job.workspace_id, issue.team_id, issue_id, parent_id)
            except HTTPException:
                result.warn("parent", f"{node.get('key')}: the Jira parent cannot be its parent here, left without one")
            else:
                if repositories.issues.link_imported_parent(job.workspace_id, issue_id, parent_id, job.import_id):
                    result.add("sub_issues")
        for link in fields.get("issuelinks") or []:
            if not isinstance(link, dict):
                continue
            target = link.get("outwardIssue") or link.get("inwardIssue")
            target_id = row(str(target["id"])) if isinstance(target, dict) and target.get("id") else None
            if target_id is None or target_id == issue_id:
                continue
            if repositories.issues.get(job.workspace_id, target_id) is None:
                continue
            ends = _link_ends(issue_id, link, target_id)
            if ends is None:
                continue
            source_id, relation, sink_id = ends
            if repositories.relations.get(job.workspace_id, source_id, relation, sink_id) is not None:
                continue
            if relation == "relates_to" and repositories.relations.get(
                job.workspace_id, sink_id, relation, source_id
            ):
                continue
            link_row = repositories.relations.link(job.workspace_id, source_id, relation, sink_id, job.requested_by)
            blocked = blocked_side(link_row)
            if blocked is not None:
                recount_blocked(repositories, job.workspace_id, blocked)
            recount_relations(repositories, job.workspace_id, source_id)
            recount_relations(repositories, job.workspace_id, sink_id)
            result.add("relations")
    result.next_after = _next_after(page)
    return result


def run_step(repositories: Any, job: Any, client: JiraClient) -> StepResult:
    """Read and write the page of the phase the job is at."""
    phase, index = phases(job)[job.phase_index]
    mapping = job.jira_projects[index or 0]
    context = _team_context(repositories, job.workspace_id, mapping.team_id)
    handlers = {"epics": _epics_step, "issues": _issues_step, "links": _links_step}
    return handlers[phase](repositories, job, client, mapping, context)


def run_jira_page(repositories: Any, job: Any) -> Any:
    """Run the step the job is at and move it on, completing it after the last phase.

    The job is read again before its progress is saved, so a cancel that landed
    while the step ran is kept rather than overwritten. Refused credentials, a
    project the account can no longer browse, or a filter Jira now refuses, fail
    the job at once, since no retry can fix them.
    """
    try:
        credentials = Credentials.opened(open_key(job.workspace_id, job.import_id, purpose=SEAL_PURPOSE))
    except KeyGone as exc:
        return issue_import.fail(repositories, job, exc)
    mapping = job.jira_projects[0] if job.jira_projects else None
    try:
        client = client_factory(mapping.site_url if mapping else "", credentials.email, credentials.token)
        result = run_step(repositories, job, client)
    except (JiraAuthFailed, JiraNotFound, JiraBadQuery, jira_api.InvalidSite) as exc:
        _log.warning(
            "A Jira import cannot read its projects.",
            extra={"event": "issue.import.jira_refused", "import_id": job.import_id, "error": type(exc).__name__},
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


issue_import.PAGE_RUNNERS[KIND] = run_jira_page
