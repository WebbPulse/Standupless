"""Issue visibility, the team's rule plus the narrower one a private ask carries.

A private ask, filed from a Slack DM or private channel, is read only by the
person who asked, the member who filed or holds it, and the explicit members of
its team. A workspace role alone does not open it, the same way it does not open
a private team, so it stays out of every workspace-wide list, search and view
for everyone else. Every other issue is visible exactly when its team is.
"""

from __future__ import annotations

from collections.abc import Callable

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.issues import Issue
from app.common.team_privacy import person_can_see_team


def private_ask_people(issue: Issue) -> set[str]:
    """The people a private ask is open to by name rather than by team membership."""
    people = {issue.created_by}
    if issue.assignee_id:
        people.add(issue.assignee_id)
    if issue.requester is not None and issue.requester.user_id:
        people.add(issue.requester.user_id)
    people.discard("")
    return people


def issue_reader(repositories: Repositories, context: AuthzContext) -> Callable[[Issue], bool]:
    """A check of whether the caller may read one issue, reusable across a page.

    The caller's explicit team memberships are read at most once per team, and
    only for a private ask, so a page of ordinary issues costs nothing extra.
    """
    members: dict[str, bool] = {}

    def explicit_member(team_id: str) -> bool:
        if team_id not in members:
            if context.is_guest or context.private_team_ids:
                members[team_id] = team_id in context.team_ids
            else:
                found = repositories.memberships.get_team_membership(context.workspace_id, team_id, context.user_id)
                members[team_id] = found is not None
        return members[team_id]

    def visible(issue: Issue) -> bool:
        if not context.can_see_team(issue.team_id):
            return False
        if not issue.private:
            return True
        if context.user_id and context.user_id in private_ask_people(issue):
            return True
        return bool(context.user_id) and explicit_member(issue.team_id)

    return visible


def can_see_issue(repositories: Repositories, context: AuthzContext, issue: Issue) -> bool:
    """Whether the caller may read one issue: its team, and its people when it is a private ask."""
    return issue_reader(repositories, context)(issue)


def person_can_see_issue(repositories: Repositories, issue: Issue, user_id: str) -> bool:
    """Whether one person other than the caller may read an issue, for a notification or a recipient."""
    if not person_can_see_team(repositories, issue.workspace_id, issue.team_id, user_id):
        return False
    if not issue.private or user_id in private_ask_people(issue):
        return True
    return repositories.memberships.get_team_membership(issue.workspace_id, issue.team_id, user_id) is not None
