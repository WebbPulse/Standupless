"""Decisions an issue write needs that a schema cannot make on its own.

Held in `common` because the issue routes and the MCP tools in the integrations
image both make them, and that image may not import another domain's code.

Estimates are validated against the team's own `estimate_scale`, labels against
the team's label set, and an assignee against team readership, so each of
these needs a table read and belongs here rather than in a pydantic validator. The
routes stay thin and every rule has one home.
"""

from __future__ import annotations

from datetime import date
from difflib import get_close_matches
from typing import Any, Collection, Iterable, Mapping

from fastapi import HTTPException, status

from app.common.api.dependencies.authz import IMPLIED_TEAM_ROLE, TEAM_ROLES, AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.cycle_schedule import RELATIVE_CYCLES, relative_cycle
from app.common.db.dynamo.api_keys import is_service_subject
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.planning import Project
from app.common.db.dynamo.team_config import Status
from app.common.db.dynamo.teams import Team
from app.common.estimates import allowed_estimates
from app.common.team_privacy import needs_team_membership
from app.common.team_refs import team_not_found
from app.common.team_retirement import refuse_if_retired

COMPLETED_CATEGORIES: frozenset[str] = frozenset({"completed", "cancelled"})
"""Which status categories count an issue as finished for the parent's rollup.

The contract counts a cancelled child as done: it is resolved, so leaving it
pending would mean a parent could never reach full progress.
"""

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

TRIAGE_STATUS_ID = "triage"
"""The status id every client shows an issue awaiting triage under, and writes to send one there.

Synthetic: no status row carries it. The issue keeps `in_triage` and a hidden real
status, so the triage index and every stored row stay as they are.
"""

TRIAGE_STATUS_NAME = "Triage"
"""The name the synthetic triage status shows under."""

TRIAGE_STATUS_CATEGORY = "backlog"
"""The category the synthetic triage status reports, as waiting work that has not started."""


def unprocessable(message: str) -> HTTPException:
    """A 422 carrying the product's error envelope.

    Spelled once because every validation below answers the same shape, and a bare
    `HTTPException` would otherwise return a string detail the client cannot read.
    """
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail={"error_code": "VALIDATION_ERROR", "message": message},
    )


def not_found() -> HTTPException:
    """The 404 an invisible issue, team or link gets.

    Invisible and absent must look identical, or a caller could probe for issues in
    teams they are outside.
    """
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)


ISSUE_CHANGED = "This issue changed since it was read. Reload it and try again."


def issue_changed() -> HTTPException:
    """The 409 a write answers when someone else wrote the issue after it was read."""
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"error_code": "ISSUE_CHANGED", "message": ISSUE_CHANGED},
    )


def team_estimates(team: Team) -> tuple[str, ...]:
    """Every estimate one team accepts, from its scale and its two toggles."""
    return allowed_estimates(
        team.estimate_scale,
        extended=team.estimate_extended,
        allow_zero=team.estimate_allow_zero,
    )


def check_estimate(estimate: str | None, team: Team, *, current: str | None = None) -> str | None:
    """Hold an estimate to the team's scale, or raise a 422.

    The scale is a team setting rather than a global one, so this cannot live in
    the schema: the team has to be read before the value can be judged. `current`
    is the value the issue already holds, which is kept even when the team's scale
    no longer offers it, so a client echoing an issue back never has it refused
    and the stored value is never silently rewritten.
    """
    if estimate is None:
        return None
    candidate = estimate.strip()
    if not candidate:
        return None
    if current is not None and candidate == current:
        return candidate
    if team.estimate_scale == "off":
        raise unprocessable("This team has estimates turned off")
    permitted = team_estimates(team)
    if candidate not in permitted:
        raise unprocessable(f"estimate must be one of: {', '.join(permitted)}")
    return candidate


def check_labels(repositories: Repositories, workspace_id: str, team_id: str, label_ids: Iterable[str]) -> list[str]:
    """Hold every label to the team's own set, dropping duplicates.

    A label from another team would render as a missing chip rather than an
    error, so it is refused at the write instead of tolerated on the row. As in
    Linear, a label group is never put on an issue itself, and an issue carries at
    most one label of each group.
    """
    wanted = [label_id for label_id in dict.fromkeys(label_ids) if label_id]
    groups: dict[str, str] = {}
    for label_id in wanted:
        row = repositories.team_config.get_label(workspace_id, team_id, label_id)
        if row is None:
            raise unprocessable(f"No such label: {label_id}")
        if row.is_group:
            raise unprocessable(f"{row.name} is a label group. Choose one of its labels instead.")
        if row.parent_id:
            if row.parent_id in groups:
                group = repositories.team_config.get_label(workspace_id, team_id, row.parent_id)
                name = group.name if group is not None else "the same"
                raise unprocessable(f"An issue can carry one label from the {name} group.")
            groups[row.parent_id] = label_id
    return wanted


def check_status(repositories: Repositories, workspace_id: str, team_id: str, status_id: str) -> Status:
    """The named status of this team, or a 422.

    Read back rather than trusted because an issue's board partition is composed
    from the status id, and an unknown one would index the row into a column no
    query ever names.
    """
    row = repositories.team_config.get_status(workspace_id, team_id, status_id)
    if row is None:
        raise unprocessable(unknown_status_message(repositories, workspace_id, team_id, status_id))
    return row


def unknown_status_message(repositories: Repositories, workspace_id: str, team_id: str, reference: str) -> str:
    """The refusal for a status this team lacks, naming its statuses and the closest one.

    A caller that guessed a name, such as `Canceled` for `Cancelled`, learns the
    spelling and the id to send without a second call to list the statuses.
    """
    rows = repositories.team_config.list_statuses(workspace_id, team_id, include_hidden=False)
    if not rows:
        return f"No such status: {reference}. This team has no statuses."
    listed = ", ".join(f"{row.name} ({row.status_id})" for row in rows)
    message = f"No such status: {reference}. This team's statuses are: {listed}."
    by_folded = {row.name.casefold(): row for row in rows}
    closest = get_close_matches(reference.strip().casefold(), list(by_folded), n=1, cutoff=0.6)
    if closest:
        match = by_folded[closest[0]]
        message += f" Did you mean {match.name} ({match.status_id})?"
    return message


def default_status(repositories: Repositories, workspace_id: str, team_id: str) -> Status:
    """The status a new issue lands in: the lowest-position `backlog` one.

    Falls back to the lowest-position status of any category, because a team
    whose backlog statuses were all deleted must still accept an issue.
    """
    rows = repositories.team_config.list_statuses(workspace_id, team_id, include_hidden=False)
    if not rows:
        raise unprocessable("This team has no statuses")
    backlog = [row for row in rows if row.category == "backlog"]
    candidates = backlog or rows
    return sorted(candidates, key=lambda row: (row.position, row.name))[0]


def check_assignee(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    assignee_id: str | None,
) -> str | None:
    """Hold an assignee to being someone who can read the team, or raise a 422.

    A guest only reads the teams they hold a membership in, and anyone reads a
    private team only as its member, so assigning such a person an issue in a
    team they cannot open would hide it from them entirely.
    """
    if not assignee_id:
        return None
    membership = repositories.memberships.get(workspace_id, assignee_id)
    if membership is None:
        raise unprocessable("The assignee is not a member of this workspace")
    if not needs_team_membership(repositories, workspace_id, team_id, membership.role):
        return assignee_id
    team_membership = repositories.memberships.get_team_membership(workspace_id, team_id, assignee_id)
    if team_membership is None:
        raise unprocessable("The assignee cannot see this team")
    return assignee_id


def check_parent(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    issue_id: str | None,
    parent_id: str | None,
    *,
    known: Mapping[str, Issue] | None = None,
) -> str | None:
    """Hold a parent to the contract's three rules, or raise a 422.

    Same team, never itself, and at most one level deep: a child cannot itself
    have children, which is what keeps `progress` a count of direct children rather
    than a tree walk. `known` holds issues this request wrote moments ago, checked
    as written rather than through a read that can lag the write.
    """
    if not parent_id:
        return None
    if issue_id is not None and parent_id == issue_id:
        raise unprocessable("An issue cannot be its own parent")

    parent = (known or {}).get(parent_id) or repositories.issues.get(workspace_id, parent_id)
    if parent is None:
        raise unprocessable(f"No such issue: {parent_id}")
    if parent.team_id != team_id:
        raise unprocessable("A parent must be in the same team")
    if parent.parent_id:
        raise unprocessable("Sub-issues are one level deep")
    if issue_id is not None and repositories.issues.has_children(workspace_id, issue_id):
        raise unprocessable("An issue with children cannot become a sub-issue")
    return parent_id


def check_cycle(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    cycle_id: str | None,
) -> str | None:
    """Hold a cycle to being one of this team's, or raise a 422.

    A cycle from another team would count this issue into a bar its own team
    never sees, and the planning rollup has no way to notice, so the attachment is
    refused at the write rather than tolerated on the row.
    """
    if not cycle_id:
        return None
    if repositories.planning.get_cycle(workspace_id, team_id, cycle_id) is None:
        raise unprocessable(f"No such cycle: {cycle_id}")
    return cycle_id


TEAM_CYCLE_LIMIT = 500
"""The most cycles one team's read takes when resolving a relative cycle."""


def resolve_cycle(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    cycle_id: str | None,
    *,
    today: date | None = None,
) -> str | None:
    """`check_cycle`, with `current`, `next` and `previous` resolved against the team's schedule.

    A cycle whose id is the alias itself still wins, so the alias never hides a
    stored row. A team with no such cycle is refused with a 422 naming the alias
    and the team, rather than the bare "No such cycle".
    """
    alias = (cycle_id or "").strip().casefold()
    if alias not in RELATIVE_CYCLES or repositories.planning.get_cycle(workspace_id, team_id, cycle_id or ""):
        return check_cycle(repositories, workspace_id, team_id, cycle_id)
    cycles, _ = repositories.planning.list_cycles(workspace_id, team_id, limit=TEAM_CYCLE_LIMIT)
    found = relative_cycle(cycles, alias, today or date.today())
    if found is None:
        team = repositories.teams.get(workspace_id, team_id)
        name = team.key_prefix if team is not None and team.key_prefix else team_id
        raise unprocessable(f"Team {name} has no {alias} cycle")
    return found.cycle_id


def check_project(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    project_id: str | None,
    *,
    known: Project | None = None,
) -> str | None:
    """Hold a project to being on this issue's team, or raise a 422.

    A project spans one or more teams, and an issue may join it only from one of
    them, so the project's own team list is what decides. A project not on this
    team reads as absent, which tells the caller nothing about other teams.
    `known` is a project this request wrote moments ago, checked as written
    rather than through a read that can lag the write.
    """
    if not project_id:
        return None
    if known is not None and known.project_id == project_id:
        project: Project | None = known
    else:
        project = repositories.planning.get_project(workspace_id, project_id)
    if project is None or team_id not in project.team_ids:
        raise unprocessable(f"No such project: {project_id}")
    return project_id


def check_project_milestone(
    repositories: Repositories,
    workspace_id: str,
    project_id: str | None,
    milestone_id: str | None,
    *,
    known: Mapping[str, Collection[str]] | None = None,
) -> str | None:
    """Hold a milestone to being one of the issue's own project's, or raise a 422.

    A milestone is a stage of one project, so an issue outside that project, or
    in no project, cannot sit in it. `known` maps a project this request wrote
    moments ago to the milestone ids it wrote on it, trusted as written rather
    than read back through a read that can lag the write.
    """
    if not milestone_id:
        return None
    if not project_id:
        raise unprocessable("project_milestone_id needs a project_id")
    if milestone_id in (known or {}).get(project_id, ()):
        return milestone_id
    if repositories.planning.get_milestone(workspace_id, project_id, milestone_id) is None:
        raise unprocessable(f"No such milestone: {milestone_id}")
    return milestone_id


def visible_team_ids(repositories: Repositories, context: AuthzContext) -> list[str]:
    """Every team of the workspace this caller may read, in a stable order.

    The fan-out list reads this rather than filtering rows afterwards, so an issue
    in an invisible team is never fetched in the first place.
    """
    teams = repositories.teams.list_for_workspace(context.workspace_id)
    return sorted(team.team_id for team in teams if context.can_see_team(team.team_id))


def team_role(repositories: Repositories, context: AuthzContext, team_id: str) -> str | None:
    """The caller's role on one team, explicit membership winning over implied.

    The authorization dependency resolves this for the team in the path, and the
    issue routes carry the team in the body or on the row instead, so the same
    decision is made here against the team the issue actually belongs to.
    """
    membership = repositories.memberships.get_team_membership(context.workspace_id, team_id, context.user_id)
    if membership is not None and membership.role in TEAM_ROLES:
        return membership.role
    return IMPLIED_TEAM_ROLE.get(context.role)


def lands_in_triage(
    repositories: Repositories,
    context: AuthzContext,
    team_id: str,
    requested: bool,
    *,
    status_named: bool = False,
    has_parent: bool = False,
) -> bool:
    """Whether a new issue in one team starts in its triage inbox.

    Only when the team has triage on: then an issue filed by a guest, by someone
    outside the team or by a workspace key always lands there, and so does a
    member's issue that names no status. A member who names a real status files
    straight into it, and a member's sub-issue files straight in unless triage
    is asked for.
    """
    if not triage_on(repositories, context.workspace_id, team_id):
        return False
    if requested or context.is_guest or is_service_subject(context.user_id):
        return True
    if repositories.memberships.get_team_membership(context.workspace_id, team_id, context.user_id) is None:
        return True
    return not status_named and not has_parent


def triage_on(repositories: Repositories, workspace_id: str, team_id: str) -> bool:
    """Whether one team has its triage inbox switched on."""
    settings = repositories.team_config.get_triage_settings(workspace_id, team_id)
    return settings is not None and settings.enabled


def require_triage_on(repositories: Repositories, workspace_id: str, team_id: str) -> None:
    """Hold that one team has triage on before an issue is sent there, or a 422."""
    if not triage_on(repositories, workspace_id, team_id):
        raise unprocessable("This team does not have triage turned on")


def shown_status_id(issue: Issue) -> str:
    """The status id an issue shows under: the synthetic triage one while it waits in triage."""
    return TRIAGE_STATUS_ID if issue.in_triage else issue.status_id


def require_team_reader(repositories: Repositories, context: AuthzContext, team_id: str) -> None:
    """Hold that the caller may read one team, or 404.

    A guest outside the team gets the same answer as for a team that never
    existed, which is what keeps the team set unenumerable.
    """
    _readable_team(repositories, context, team_id)


def _readable_team(repositories: Repositories, context: AuthzContext, team_id: str) -> Team:
    """The team the caller may read, or 404, read once for the checks built on it."""
    if not context.can_see_team(team_id):
        raise team_not_found(team_id)
    team = repositories.teams.get(context.workspace_id, team_id)
    if team is None:
        raise team_not_found(team_id)
    return team


def require_team_member(repositories: Repositories, context: AuthzContext, team_id: str) -> None:
    """Hold that the caller may write in one team, or 404 or 403.

    Invisibility is a 404 so nothing leaks, but a caller who can see the team and
    still may not write gets a 403: the resource is not in doubt, only the verb.
    A retired team is read-only, so a write into it is a 409.
    """
    refuse_if_retired(_readable_team(repositories, context, team_id))
    role = team_role(repositories, context, team_id)
    if role is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error_code": "FORBIDDEN", "message": "Not allowed"},
        )


def require_team_admin(repositories: Repositories, context: AuthzContext, team_id: str) -> None:
    """Hold that the caller administers one team, or 404 or 403, and that it is not retired, or 409."""
    refuse_if_retired(_readable_team(repositories, context, team_id))
    if context.is_workspace_admin:
        return
    if team_role(repositories, context, team_id) != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error_code": "FORBIDDEN", "message": "Not allowed"},
        )


def load_visible_issue(
    repositories: Repositories, context: AuthzContext, issue_id: str, *, include_deleted: bool = False
) -> Issue:
    """One issue the caller may read, or a 404.

    Every issue route starts here, so an issue in a team the caller is outside is
    indistinguishable from one that was never created. A deleted issue is a 404
    too, unless `include_deleted`, which the reads and the trash actions pass.
    """
    issue = repositories.issues.get(context.workspace_id, issue_id, include_deleted=include_deleted)
    if issue is None:
        raise not_found()
    if not context.can_see_team(issue.team_id):
        raise not_found()
    return issue


def status_categories(repositories: Repositories, workspace_id: str, team_id: str) -> dict[str, str]:
    """Each status id of one team mapped to its category.

    Read once per rollup rather than per child, because counting a parent's
    completed children needs the category of every child's status.
    """
    rows = repositories.team_config.list_statuses(workspace_id, team_id)
    return {row.status_id: row.category for row in rows}


def count_progress(children: list[Issue], categories: dict[str, str]) -> tuple[int, int]:
    """One parent's rollup: how many direct children, and how many are finished."""
    total = len(children)
    completed = sum(1 for child in children if categories.get(child.status_id) in COMPLETED_CATEGORIES)
    return total, completed


def changed_fields(before: Issue, after: Issue, fields: Iterable[str]) -> list[tuple[str, Any, Any]]:
    """Each named field whose value actually moved, as `(field, from, to)`.

    Compared after the write is assembled rather than from the request body, so a
    patch that sets a field to what it already held writes no activity row.
    """
    changes: list[tuple[str, Any, Any]] = []
    for field in fields:
        old = getattr(before, field)
        new = getattr(after, field)
        if old != new:
            changes.append((field, old, new))
    return changes


def subscribe_touched(repositories: Repositories, issue: Issue, before: Issue | None) -> None:
    """Subscribe the people a write brought onto the issue, as Linear does.

    A create subscribes its author, its assignee and everyone its description
    mentions. An update subscribes a new assignee and anyone the description now
    mentions that it did not before, so an edit never re-subscribes someone who
    chose to unsubscribe while still being mentioned.
    """
    subscriptions = repositories.subscriptions
    workspace_id, issue_id, team_id = issue.workspace_id, issue.issue_id, issue.team_id
    if before is None:
        subscriptions.subscribe(workspace_id, issue_id, team_id, issue.created_by, "creator")
    if issue.assignee_id and (before is None or before.assignee_id != issue.assignee_id):
        subscriptions.subscribe(workspace_id, issue_id, team_id, issue.assignee_id, "assignee")
    previous = set(before.mentioned_user_ids) if before is not None else set()
    added = [user_id for user_id in issue.mentioned_user_ids if user_id not in previous]
    subscriptions.subscribe_many(workspace_id, issue_id, team_id, added, "mentioned")
