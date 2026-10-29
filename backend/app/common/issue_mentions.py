"""Issue mentions: the "mentioned in" backlink an issue key in a description or a comment leaves.

Linear writes an entry into a mentioned issue's history naming where it was
mentioned, so following a reference works in both directions. Held in `common`
because the issues, discussion and integrations images all write bodies, and an
agent's description or comment has to leave the same backlink a person's does.

Only keys a write adds leave a backlink, so editing a description that already
names an issue does not record the mention again. The row is written on the
mentioned issue with the mentioning issue's id, key, title and team as its value,
and the activity read drops it for a reader who cannot see that team, so a private
team's issue never surfaces its title through a backlink on a public one.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.activity import Activity, build_activity
from app.common.db.dynamo.issues import Issue
from app.common.issue_keys import current
from app.common.issue_privacy import can_see_issue

MENTIONED = "mentioned"
"""The activity kind a backlink row carries."""

MENTIONS_MAX = 25
"""The most issues one write records a backlink on, so a pasted changelog cannot fan out without bound."""

KEY_PATTERN = re.compile(r"(?<![A-Za-z0-9/-])([A-Z][A-Z0-9]{1,5})-(\d{1,9})(?![0-9A-Za-z])")
"""An issue key as people write it, uppercase prefix and number, not inside a URL path or another word."""

MentionPlace = Literal["description", "comment"]


def issue_keys(body: str | None) -> list[str]:
    """The distinct issue keys a body names, in the order written, capped at `MENTIONS_MAX`.

    Fenced and inline code is left out, so a key quoted in a snippet or a log
    line is not read as a reference.
    """
    if not body:
        return []
    text = re.sub(r"```[\s\S]*?```|`[^`\n]*`", " ", body)
    keys: dict[str, None] = {}
    for match in KEY_PATTERN.finditer(text):
        keys[f"{match.group(1)}-{int(match.group(2))}"] = None
        if len(keys) >= MENTIONS_MAX:
            break
    return list(keys)


def added_keys(before: str | None, after: str | None) -> list[str]:
    """The keys `after` names that `before` did not, in the order written."""
    held = set(issue_keys(before))
    return [key for key in issue_keys(after) if key not in held]


def resolve_issue_keys(repositories: Repositories, context: AuthzContext, keys: list[str]) -> list[Issue]:
    """The issues the keys name that this caller can see, one per issue, in the order written.

    A key in a team the writer cannot see resolves to nothing, so a backlink is
    never written onto an issue its author could not open.
    """
    teams: dict[str, str | None] = {}
    found: list[Issue] = []
    seen: set[str] = set()
    for key in keys:
        prefix, _, number = key.rpartition("-")
        if prefix not in teams:
            team = repositories.teams.get_by_key_prefix(context.workspace_id, prefix)
            teams[prefix] = team.team_id if team is not None else None
        team_id = teams[prefix]
        if team_id is None or not context.can_see_team(team_id):
            continue
        issue = repositories.issues.get_by_number(context.workspace_id, team_id, int(number))
        if issue is None or issue.issue_id in seen or not can_see_issue(repositories, context, issue):
            continue
        seen.add(issue.issue_id)
        found.append(issue)
    return found


def mention_reference(repositories: Repositories, source: Issue, comment_id: str | None) -> dict[str, Any]:
    """The value a backlink row stores: where the mention was written, under its current key."""
    shown = current(repositories.teams, source)
    reference: dict[str, Any] = {
        "id": shown.issue_id,
        "key": shown.key,
        "title": shown.title,
        "team_id": shown.team_id,
    }
    if comment_id:
        reference["comment_id"] = comment_id
    return reference


def record_issue_mentions(
    repositories: Repositories,
    context: AuthzContext,
    source: Issue,
    before: str | None,
    after: str | None,
    *,
    place: MentionPlace,
    comment_id: str | None = None,
) -> list[Activity]:
    """Write a backlink on every issue `after` newly mentions, answering the rows written.

    An issue mentioning itself leaves nothing, and an unresolved or unseen key is
    dropped quietly: a body is free text, and a word shaped like a key is not an
    error.
    """
    keys = added_keys(before, after)
    if not keys:
        return []
    targets = [issue for issue in resolve_issue_keys(repositories, context, keys) if issue.issue_id != source.issue_id]
    if not targets:
        return []
    reference = mention_reference(repositories, source, comment_id)
    rows = [
        build_activity(
            context.workspace_id,
            target.team_id,
            target.issue_id,
            context.user_id,
            MENTIONED,
            field=place,
            to_value=dict(reference),
            source=context.source,
        )
        for target in targets
    ]
    return repositories.activity.record_many(rows)


def visible_backlink(context: AuthzContext, row: Activity) -> bool:
    """Whether this caller may read one activity row, which only a backlink from an unseen team fails."""
    if row.kind != MENTIONED or not isinstance(row.to_value, dict):
        return True
    team_id = row.to_value.get("team_id")
    return not isinstance(team_id, str) or not team_id or context.can_see_team(team_id)
