"""Import from a Shortcut workspace through Shortcut's REST API, a page at a time on the issue import queue.

A Shortcut import is an `ImportJob` of kind `shortcut`, so it shares the other
importers' job object, queue, page retries, stale job detection, cancel and
inbox notice. Each mapped Shortcut team is walked in three phases: its
iterations become cycles of the Standupless team, its epics become projects,
and its stories become issues, a page of `PAGE_SIZE` stories per queue message,
each read in full for its comments, tasks, links and sub-task stories.
`phase_index` and `after` say where the job is, and `cursor` counts the steps so
the queue's duplicate guard works unchanged. An iteration or epic that names no
team goes into every mapped team.

Every row an import writes gets an id derived from the workspace and the
Shortcut id, with the Shortcut creation time as its time part, so a step that
runs twice, and a later import of the same Shortcut workspace, updates the rows
already written instead of writing them again. Each issue's `external_ref`
carries `sc-<id>` and the story's Shortcut URL.

A story's workflow state maps to the team status of the same name, else the
status of the same category, else the team's default. Its labels and story type
become team labels, its tasks a checklist in the description, and its estimate,
deadline, epic and iteration carry over. Sub-task stories become sub-issues and
story links become blocks, duplicate and related relations. Both are written
from whichever end is imported second, so links within and across mapped teams
land in one pass.

The API token the admin pasted is sealed beside the job in `key.json` exactly as
a Linear key is, under its own purpose, opened in memory for each step and
deleted when the job completes, fails or is cancelled. It is never written to
the job, a log, an audit row or any imported data.

People are matched to members by email. A comment whose author is not a member
is written under a `shortcut:<name>` placeholder, and no account or invite is
ever created.
"""

from __future__ import annotations

import logging
from collections import Counter
from typing import Any, Callable, Optional

from fastapi import HTTPException
from webbpulse.dynamodb import ConditionFailed, new_ulid

from app.common import issue_import
from app.common.api.dependencies.authz import AuthzContext
from app.common.core.config import settings
from app.common.db.dynamo.base import utc_now
from app.common.issue_import import SourceTeamMapping
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
from app.domains.integrations.shortcut_api import (
    ShortcutAuthFailed,
    ShortcutClient,
    ShortcutError,
    list_epics,
    list_iterations,
    list_members,
    list_teams,
    list_workflow_states,
    story,
    team_stories,
)

_log = logging.getLogger(__name__)

KIND = "shortcut"

PRESET = "shortcut_api"

SEAL_PURPOSE = "shortcut_import_token"
"""What a sealed Shortcut token is bound to, so it never opens as a Linear key."""

AUTHOR_PREFIX = "shortcut:"
"""The author id prefix of a comment whose Shortcut author matched no member."""

TEAM_PHASES: tuple[str, ...] = ("iterations", "epics", "stories")
"""What one mapped team's walk reads, in order: what stories point at comes before the stories."""

PAGE_SIZE = 25
"""Stories read per step, each fetched in full, so a step stays well inside Shortcut's per minute budget."""

PREVIEW_STORIES = 1000
"""The most stories of one team a preview counts, Shortcut's largest page."""

CATEGORY_BY_STATE_TYPE: dict[str, str] = {
    "backlog": "backlog",
    "unstarted": "unstarted",
    "started": "started",
    "done": "completed",
}
"""Shortcut's workflow state types as the status categories a Standupless team groups its statuses in."""

PROJECT_STATUS_BY_EPIC_STATE: dict[str, str] = {
    "to do": "planned",
    "in progress": "in_progress",
    "done": "completed",
}

RELATION_BY_VERB: dict[str, str] = {
    "blocks": "blocks",
    "duplicates": "duplicate_of",
    "relates to": "relates_to",
}
"""Shortcut's story link verbs as Standupless link types, the subject being the linking issue."""

STORY_TYPES: dict[str, str] = {"feature": "Feature", "bug": "Bug", "chore": "Chore"}
"""The label each Shortcut story type becomes."""


class UnknownShortcutTeam(Exception):
    """A chosen Shortcut team is not one the token can read, or was chosen twice."""


def _default_client(token: str) -> ShortcutClient:
    """A Shortcut client for one token against the configured endpoint."""
    return ShortcutClient(token=token)


client_factory: Callable[[str], ShortcutClient] = _default_client
"""How a step builds its Shortcut client, which the tests point at a fake Shortcut server."""


def read_teams(token: str) -> list[dict[str, Any]]:
    """Every Shortcut team the token can read, raising `ShortcutAuthFailed` when Shortcut refuses it."""
    return list_teams(client_factory(token))


def team_mappings(token: str, choices: list[tuple[str, str]]) -> list[SourceTeamMapping]:
    """Check each chosen Shortcut team against what the token can read, keeping its key and name for the job.

    `choices` pairs a Shortcut team id with the Standupless team id it goes into.
    Raises `UnknownShortcutTeam` for a team the token cannot read or one chosen twice.
    """
    readable = {team["id"]: team for team in read_teams(token)}
    mappings: list[SourceTeamMapping] = []
    seen: set[str] = set()
    for source_id, team_id in choices:
        team = readable.get(source_id)
        if team is None or source_id in seen:
            raise UnknownShortcutTeam(source_id)
        seen.add(source_id)
        mappings.append(SourceTeamMapping(source_id=source_id, key=team["key"], name=team["name"], team_id=team_id))
    return mappings


def phases(job: Any) -> list[tuple[str, Optional[int]]]:
    """Every phase of one job in order: each mapped team's iterations, epics and stories."""
    return [(phase, index) for index in range(len(job.source_teams)) for phase in TEAM_PHASES]


def shortcut_row_id(workspace_id: str, kind: str, shortcut_id: Any, created_at: Any) -> str:
    """The id one Shortcut record always becomes in one workspace, so a re-run finds what it wrote."""
    return linear_row_id(workspace_id, f"shortcut_{kind}", str(shortcut_id), created_at)


def _team_ids(node: dict[str, Any]) -> list[str]:
    """The Shortcut teams an epic or iteration names, under either field name the API has used."""
    ids = [str(value) for value in node.get("group_ids") or []]
    if node.get("group_id"):
        ids.append(str(node["group_id"]))
    return ids


def _in_team(node: dict[str, Any], source_id: str) -> bool:
    """Whether an epic or iteration belongs to a mapped Shortcut team: it names the team, or names none."""
    ids = _team_ids(node)
    return not ids or source_id in ids


def _status(context: TeamContext, state: Optional[dict[str, Any]]) -> Any:
    """The team status a Shortcut workflow state maps to: the same name, else the same type, else the default."""
    lookup = context.lookup
    if not state:
        return lookup.default_status
    named = lookup.status_by_name.get(str(state.get("name") or "").strip().lower())
    if named is not None:
        return named
    category = CATEGORY_BY_STATE_TYPE.get(str(state.get("type") or "").lower())
    if category is not None and category in lookup.status_by_category:
        return lookup.status_by_category[category]
    return lookup.default_status


def _member(context: TeamContext, members: dict[str, dict[str, str]], shortcut_id: Any) -> Optional[str]:
    """The member a Shortcut member is, matched by email, or `None`."""
    email = members.get(str(shortcut_id or ""), {}).get("email", "")
    return context.lookup.by_email.get(email) if email else None


def _author(context: TeamContext, members: dict[str, dict[str, str]], shortcut_id: Any) -> str:
    """Who a comment is written as: the matching member, else a `shortcut:<name>` placeholder."""
    member = _member(context, members, shortcut_id)
    if member is not None:
        return member
    name = members.get(str(shortcut_id or ""), {}).get("name", "")
    return f"{AUTHOR_PREFIX}{(name or 'Shortcut user')[:80]}"


def preview(
    repositories: Any, workspace_id: str, token: str, mappings: list[SourceTeamMapping]
) -> list[dict[str, Any]]:
    """What importing each mapped Shortcut team would bring over, computed without writing anything.

    Per team: how many stories, epics and iterations it holds, where each
    workflow state lands, the labels the team would gain, and how many story
    owners match a member by email. Stories are counted up to `PREVIEW_STORIES`.
    """
    from app.common.issue_import import load_lookup

    client = client_factory(token)
    states = list_workflow_states(client)
    members = list_members(client)
    epics = list_epics(client)
    iterations = list_iterations(client)
    answers: list[dict[str, Any]] = []
    for mapping in mappings:
        lookup = load_lookup(repositories, workspace_id, mapping.team_id)
        context = TeamContext(team_id=mapping.team_id, lookup=lookup)
        stories = team_stories(client, mapping.source_id, 0, PREVIEW_STORIES)
        by_state = Counter(str(node.get("workflow_state_id") or "") for node in stories)
        statuses = []
        for state_id, count in by_state.most_common():
            state = states.get(state_id)
            statuses.append(
                {
                    "source": state["name"] if state else "No state",
                    "status_name": _status(context, state).name,
                    "count": count,
                }
            )
        labels = {
            str(label.get("name") or "").strip()
            for node in stories
            for label in node.get("labels") or []
            if isinstance(label, dict) and str(label.get("name") or "").strip()
        }
        labels.update(
            STORY_TYPES[kind] for kind in {str(node.get("story_type") or "") for node in stories} if kind in STORY_TYPES
        )
        owners = {str(owner) for node in stories for owner in node.get("owner_ids") or []}
        matched = sum(1 for owner in owners if _member(context, members, owner) is not None)
        answers.append(
            {
                "shortcut_team_id": mapping.source_id,
                "name": mapping.name,
                "team_id": mapping.team_id,
                "stories": len(stories),
                "stories_capped": len(stories) >= PREVIEW_STORIES,
                "epics": sum(1 for node in epics if _in_team(node, mapping.source_id)),
                "iterations": sum(1 for node in iterations if _in_team(node, mapping.source_id)),
                "statuses": statuses,
                "new_labels": sorted(name for name in labels if name.lower() not in lookup.labels),
                "matched_owners": matched,
                "unmatched_owners": len(owners) - matched,
            }
        )
    return answers


def start_shortcut_import(
    repositories: Any, context: AuthzContext, token: str, mappings: list[SourceTeamMapping]
) -> Any:
    """Queue an import of Shortcut teams into Standupless teams, or run it inline where no queue exists.

    The token has already been checked against Shortcut by the caller. It is
    sealed beside the job and never stored on it. Refuses like the other imports.
    """
    from app.common.issue_rules import require_team_member

    issue_import.bucket()
    queue_url = settings.ISSUE_IMPORT_QUEUE_URL.strip()
    if (not queue_url and settings.is_production) or not can_seal():
        raise issue_import.ImportUnavailable("Shortcut imports are not configured for this environment")
    for mapping in mappings:
        require_team_member(repositories, context, mapping.team_id)
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
            source_teams=mappings,
            file_name="Shortcut",
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


def run_step(repositories: Any, job: Any, client: ShortcutClient) -> StepResult:
    """Read and write the page of the phase the job is at."""
    phase, index = phases(job)[job.phase_index]
    mapping = job.source_teams[index or 0]
    context = _team_context(repositories, job.workspace_id, mapping.team_id)
    if phase == "iterations":
        return _iterations_step(repositories, job, client, mapping)
    if phase == "epics":
        return _epics_step(repositories, job, client, mapping, context)
    return _stories_step(repositories, job, client, mapping, context)


def _iterations_step(repositories: Any, job: Any, client: ShortcutClient, mapping: SourceTeamMapping) -> StepResult:
    """Write a Shortcut team's iterations as the mapped team's cycles."""
    from app.common.db.dynamo.planning import Cycle, cycle_key

    result = StepResult()
    for node in list_iterations(client):
        if not node.get("id") or not _in_team(node, mapping.source_id):
            continue
        start, end = _date(node.get("start_date")), _date(node.get("end_date"))
        if not start or not end:
            continue
        cycle_id = shortcut_row_id(job.workspace_id, "iteration", node["id"], node.get("created_at"))
        fields = {
            "name": (str(node.get("name") or "").strip() or "Iteration")[:120],
            "start_date": start,
            "end_date": end,
            "goal": str(node.get("description") or "").strip()[:2000] or None,
            "import_batch_id": job.import_id,
            "updated_at": utc_now(),
        }
        existing = repositories.planning.get_cycle(job.workspace_id, mapping.team_id, cycle_id)
        if existing is None:
            try:
                repositories.planning.create_cycle(
                    Cycle(
                        workspace_id=job.workspace_id,
                        planning_key=cycle_key(mapping.team_id, cycle_id),
                        cycle_id=cycle_id,
                        team_id=mapping.team_id,
                        created_by=job.requested_by,
                        created_at=_instant(node.get("created_at")) or utc_now(),
                        **fields,
                    )
                )
            except ConditionFailed:
                continue
        else:
            repositories.planning.replace_cycle(existing.model_copy(update=fields), keep_import_batch=True)
        result.add("cycles")
    return result


def _epics_step(
    repositories: Any, job: Any, client: ShortcutClient, mapping: SourceTeamMapping, context: TeamContext
) -> StepResult:
    """Write a Shortcut team's epics as projects, adding the mapped team to one another team's walk wrote."""
    from app.common.db.dynamo.planning import Project, project_key

    result = StepResult()
    epics = [node for node in list_epics(client) if node.get("id") and _in_team(node, mapping.source_id)]
    members = list_members(client) if epics else {}
    for node in epics:
        project_id = shortcut_row_id(job.workspace_id, "epic", node["id"], node.get("created_at"))
        description, _ = _cap(str(node.get("description") or "").strip() or None)
        lead = next(
            (
                member
                for member in (_member(context, members, owner) for owner in node.get("owner_ids") or [])
                if member
            ),
            None,
        )
        fields: dict[str, Any] = {
            "name": (str(node.get("name") or "").strip() or "Untitled epic")[:120],
            "description": description,
            "lead_id": lead,
            "start_date": _date(node.get("planned_start_date")),
            "target_date": _date(node.get("deadline")),
            "status": PROJECT_STATUS_BY_EPIC_STATE.get(str(node.get("state") or "").strip().lower(), "backlog"),
            "import_batch_id": job.import_id,
            "updated_at": utc_now(),
        }
        existing = repositories.planning.get_project(job.workspace_id, project_id)
        if existing is None:
            try:
                repositories.planning.create_project(
                    Project(
                        workspace_id=job.workspace_id,
                        planning_key=project_key(project_id),
                        project_id=project_id,
                        team_ids=[mapping.team_id],
                        created_by=job.requested_by,
                        created_at=_instant(node.get("created_at")) or utc_now(),
                        **fields,
                    )
                )
            except ConditionFailed:
                existing = repositories.planning.get_project(job.workspace_id, project_id)
        if existing is not None:
            team_ids = list(dict.fromkeys([*existing.team_ids, mapping.team_id]))
            repositories.planning.replace_project(
                existing.model_copy(update={**fields, "team_ids": team_ids}), keep_import_batch=True
            )
        result.add("projects")
    return result


class StoryEnds:
    """The creation times of the stories one step has seen, so a link's far end resolves to its row id."""

    def __init__(self, client: ShortcutClient, workspace_id: str) -> None:
        """Start empty for one step."""
        self.client = client
        self.workspace_id = workspace_id
        self.created: dict[str, Any] = {}

    def see(self, node: dict[str, Any]) -> None:
        """Remember one story's creation time."""
        if node.get("id") is not None:
            self.created[str(node["id"])] = node.get("created_at")

    def row_id(self, story_id: Any) -> Optional[str]:
        """The issue id a Shortcut story becomes, reading the story when this step has not seen it."""
        key = str(story_id or "")
        if not key:
            return None
        if key not in self.created:
            try:
                self.see(story(self.client, key))
            except ShortcutError as exc:
                if exc.code != "not_found":
                    raise
                self.created[key] = None
                return None
            except ValueError:
                return None
        if self.created.get(key) is None:
            return None
        return shortcut_row_id(self.workspace_id, "story", key, self.created[key])


def _stories_step(
    repositories: Any, job: Any, client: ShortcutClient, mapping: SourceTeamMapping, context: TeamContext
) -> StepResult:
    """Write one page of a Shortcut team's stories with their comments, sub-task stories and links."""
    result = StepResult()
    offset = int(job.after or 0)
    page = team_stories(client, mapping.source_id, offset, PAGE_SIZE)
    if page:
        states = list_workflow_states(client)
        members = list_members(client)
        cycles = {str(node["id"]): node.get("created_at") for node in list_iterations(client) if node.get("id")}
        epics = {str(node["id"]): node.get("created_at") for node in list_epics(client) if node.get("id")}
        ends = StoryEnds(client, job.workspace_id)
        for slim in page:
            ends.see(slim)
        for slim in page:
            if slim.get("id") is None:
                continue
            node = story(client, slim["id"])
            ends.see(node)
            issue_id = _write_story(repositories, job, mapping, context, node, states, members, cycles, epics, result)
            if issue_id is None:
                continue
            comments = [entry for entry in node.get("comments") or [] if isinstance(entry, dict)]
            created = {str(entry.get("id")): entry.get("created_at") for entry in comments}
            for comment in sorted(comments, key=lambda entry: str(entry.get("created_at") or "")):
                _write_comment(repositories, job, context, members, issue_id, comment, created, result)
            _link_story(repositories, job, node, issue_id, ends, result)
    result.next_after = str(offset + len(page)) if len(page) >= PAGE_SIZE else None
    return result


def _story_body(node: dict[str, Any]) -> tuple[Optional[str], bool]:
    """The story's description with its tasks appended as a markdown checklist."""
    text = str(node.get("description") or "").strip()
    tasks = sorted(
        (
            task
            for task in node.get("tasks") or []
            if isinstance(task, dict) and str(task.get("description") or "").strip()
        ),
        key=lambda task: (task.get("position") or 0, str(task.get("created_at") or "")),
    )
    if tasks:
        lines = [f"- [{'x' if task.get('complete') else ' '}] {str(task['description']).strip()}" for task in tasks]
        text = "\n\n".join(part for part in (text, "**Tasks**\n" + "\n".join(lines)) if part)
    return _cap(text or None)


def _label_ids(
    repositories: Any, job: Any, context: TeamContext, node: dict[str, Any], result: StepResult
) -> list[str]:
    """The team labels a story's labels and story type map to, created where missing."""
    entries = [
        {"name": label.get("name"), "color": label.get("color")}
        for label in node.get("labels") or []
        if isinstance(label, dict)
    ]
    story_type = STORY_TYPES.get(str(node.get("story_type") or "").lower())
    if story_type:
        entries.append({"name": story_type, "color": None})
    ids = []
    for entry in entries:
        label_id = _ensure_label(repositories, job.workspace_id, context, entry, result)
        if label_id is not None:
            ids.append(label_id)
    return list(dict.fromkeys(ids))


def _assignee(
    repositories: Any,
    job: Any,
    context: TeamContext,
    members: dict[str, dict[str, str]],
    node: dict[str, Any],
    ref: str,
    result: StepResult,
) -> Optional[str]:
    """The first story owner who is a member able to hold the issue, or `None` with a warning."""
    from app.common.issue_import import _assignable

    owners = node.get("owner_ids") or []
    if not owners:
        return None
    for owner in owners:
        member = _member(context, members, owner)
        if member is not None and _assignable(repositories, context.lookup, job.workspace_id, member):
            return member
    result.warn("assignee", f"{ref}: no owner is a member who can see this team, left unassigned")
    return None


def _planning_ref(
    repositories: Any, job: Any, mapping: SourceTeamMapping, kind: str, shortcut_id: Any, created: dict[str, Any]
) -> Optional[str]:
    """The id of the imported cycle or project a story points at, when it was imported."""
    key = str(shortcut_id or "")
    if not key or key not in created:
        return None
    if kind == "iteration":
        row_id = shortcut_row_id(job.workspace_id, kind, key, created[key])
        found = repositories.planning.get_cycle(job.workspace_id, mapping.team_id, row_id)
    else:
        row_id = shortcut_row_id(job.workspace_id, kind, key, created[key])
        found = repositories.planning.get_project(job.workspace_id, row_id)
    return row_id if found is not None else None


def _write_story(
    repositories: Any,
    job: Any,
    mapping: SourceTeamMapping,
    context: TeamContext,
    node: dict[str, Any],
    states: dict[str, dict[str, Any]],
    members: dict[str, dict[str, str]],
    cycles: dict[str, Any],
    epics: dict[str, Any],
    result: StepResult,
) -> Optional[str]:
    """Write or update one Shortcut story in the mapped team, answering its id, or `None` when it was left out."""
    from app.common.db.dynamo.activity import build_activity
    from app.common.db.dynamo.issues import Issue, issue_key
    from app.common.sla import apply_sla

    ref = f"sc-{node.get('id')}"
    title = str(node.get("name") or "").strip()[:500]
    if not title:
        result.warn("title", f"{ref}: no title, left out")
        return None
    issue_id = shortcut_row_id(job.workspace_id, "story", node["id"], node.get("created_at"))
    body, cut = _story_body(node)
    if cut:
        result.warn("description", f"{ref}: the description was cut to fit")
    url = str(node.get("app_url") or "").strip()
    fields: dict[str, Any] = {
        "title": title,
        "body": body,
        "status_id": _status(context, states.get(str(node.get("workflow_state_id") or ""))).status_id,
        "assignee_id": _assignee(repositories, job, context, members, node, ref, result),
        "label_ids": _label_ids(repositories, job, context, node, result),
        "estimate": _estimate(context, node.get("estimate"), ref, result),
        "due_date": _date(node.get("deadline")),
        "cycle_id": _planning_ref(repositories, job, mapping, "iteration", node.get("iteration_id"), cycles),
        "project_id": _planning_ref(repositories, job, mapping, "epic", node.get("epic_id"), epics),
        "external_ref": f"{ref} {url}".strip()[:500],
        "import_batch_id": job.import_id,
    }
    now = utc_now()
    existing = repositories.issues.get(job.workspace_id, issue_id)
    if existing is not None:
        if existing.team_id != mapping.team_id:
            result.warn("team", f"{ref}: imported before into another team, left there")
            return issue_id
        updated = existing.model_copy(
            update={**fields, "updated_at": now, "updated_by": job.requested_by, "updated_source": job.source}
        )
        repositories.issues.replace(updated, keep_import_batch=True)
        result.add("issues_updated")
        return issue_id
    creator = _member(context, members, node.get("requested_by_id")) or job.requested_by
    number = repositories.counters.allocate_issue_number(job.workspace_id, mapping.team_id)
    created_at = _instant(node.get("created_at"))
    issue = Issue(
        workspace_id=job.workspace_id,
        issue_id=issue_id,
        team_id=mapping.team_id,
        key=issue_key(context.lookup.team.key_prefix, number),
        number=number,
        priority="none",
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
    repositories: Any,
    job: Any,
    context: TeamContext,
    members: dict[str, dict[str, str]],
    issue_id: str,
    node: dict[str, Any],
    created: dict[str, Any],
    result: StepResult,
) -> None:
    """Write or update one Shortcut comment with its author, time and thread parent."""
    from app.common.db.dynamo.comments import build_comment

    if node.get("deleted") or node.get("id") is None:
        return
    body, _ = _cap(str(node.get("text") or "").strip() or None)
    if not body:
        return
    comment_id = shortcut_row_id(job.workspace_id, "comment", node["id"], node.get("created_at"))
    parent = str(node.get("parent_id") or "")
    parent_id = shortcut_row_id(job.workspace_id, "comment", parent, created[parent]) if parent in created else None
    comment = build_comment(
        job.workspace_id,
        issue_id,
        context.team_id,
        _author(context, members, node.get("author_id")),
        body,
        parent_comment_id=parent_id,
        source=job.source,
    ).model_copy(
        update={
            "comment_id": comment_id,
            "created_at": _instant(node.get("created_at")) or utc_now(),
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


def _link_parent(repositories: Any, job: Any, child_id: str, parent_id: str, result: StepResult) -> None:
    """Make one imported story a sub-issue of another once both are written, warning when it cannot be."""
    from app.common.issue_rules import check_parent

    child = repositories.issues.get(job.workspace_id, child_id)
    if child is None or child.parent_id or repositories.issues.get(job.workspace_id, parent_id) is None:
        return
    try:
        check_parent(repositories, job.workspace_id, child.team_id, child_id, parent_id)
    except HTTPException:
        result.warn("parent", f"{child.key}: the Shortcut parent story cannot be its parent here, left without one")
        return
    if repositories.issues.link_imported_parent(job.workspace_id, child_id, parent_id, job.import_id):
        result.add("sub_issues")


def _link_story(
    repositories: Any, job: Any, node: dict[str, Any], issue_id: str, ends: StoryEnds, result: StepResult
) -> None:
    """Link one story to its parent, its sub-task stories and the stories it links, where both ends exist."""
    from app.common.relation_effects import blocked_side, recount_blocked, recount_relations

    if node.get("parent_story_id"):
        parent_id = ends.row_id(node["parent_story_id"])
        if parent_id is not None and parent_id != issue_id:
            _link_parent(repositories, job, issue_id, parent_id, result)
    for child in node.get("sub_task_story_ids") or []:
        child_id = ends.row_id(child)
        if child_id is not None and child_id != issue_id:
            _link_parent(repositories, job, child_id, issue_id, result)
    for link in node.get("story_links") or []:
        if not isinstance(link, dict):
            continue
        link_type = RELATION_BY_VERB.get(str(link.get("verb") or "").strip().lower())
        if link_type is None:
            continue
        source_id, target_id = ends.row_id(link.get("subject_id")), ends.row_id(link.get("object_id"))
        if source_id is None or target_id is None or source_id == target_id or issue_id not in (source_id, target_id):
            continue
        if any(repositories.issues.get(job.workspace_id, end) is None for end in (source_id, target_id)):
            continue
        if repositories.relations.get(job.workspace_id, source_id, link_type, target_id) is not None:
            continue
        row = repositories.relations.link(job.workspace_id, source_id, link_type, target_id, job.requested_by)
        blocked = blocked_side(row)
        if blocked is not None:
            recount_blocked(repositories, job.workspace_id, blocked)
        recount_relations(repositories, job.workspace_id, source_id)
        recount_relations(repositories, job.workspace_id, target_id)
        result.add("relations")


def run_shortcut_page(repositories: Any, job: Any) -> Any:
    """Run the step the job is at and move it on, completing it after the last phase.

    The job is read again before its progress is saved, so a cancel that landed
    while the step ran is kept. A refused token, or a mapped team Shortcut no
    longer has, fails the job at once, since no retry can fix it.
    """
    try:
        token = open_key(job.workspace_id, job.import_id, purpose=SEAL_PURPOSE)
    except KeyGone as exc:
        return issue_import.fail(repositories, job, exc)
    try:
        result = run_step(repositories, job, client_factory(token))
    except ShortcutError as exc:
        if not isinstance(exc, ShortcutAuthFailed) and exc.code != "not_found":
            raise
        _log.warning(
            "A Shortcut import cannot read its workspace.",
            extra={"event": "issue.import.shortcut_refused", "import_id": job.import_id, "code": exc.code},
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


issue_import.PAGE_RUNNERS[KIND] = run_shortcut_page
