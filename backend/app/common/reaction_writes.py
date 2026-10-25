"""Adding and removing a reaction, shared by the reaction routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and a reaction an agent leaves must be the same row a person's tap writes:
the notify consumer reads that row off the stream, so the same row is the same
notification.

The target is an issue or a comment, and the caller names which. A comment's target
id is resolved back to its issue before anything else happens, so both kinds end up
deciding visibility against exactly one issue's team. A comment on a document is
resolved back to its document instead, and decided against the document's parent.
"""

from __future__ import annotations

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.custom_emoji import require_custom_emoji
from app.common.db.dynamo.reactions import build_reaction
from app.common.discussion_reads import ReactionGroupRead, group_reactions, reaction_key
from app.common.discussion_rules import forbidden, load_visible_issue, not_found, require_team_member
from app.common.document_comments import NO_TEAM, load_document_comment, require_document_commenter


def resolve_target(
    repositories: Repositories,
    context: AuthzContext,
    target_id: str,
    target_kind: str,
    issue_id: str | None,
    document_id: str | None = None,
) -> str | None:
    """The team of the issue one reaction target belongs to, `None` for a document's comment, or a 404.

    An `issue` target is its own issue. A `comment` target needs the issue that
    partitions it, which the caller supplies as `issue_id`; the comment is then read
    to hold that it really is in that issue, so a caller cannot pair someone else's
    comment id with an issue they can see and react across a team boundary. A
    comment on a document names the document as `document_id`, and is held to it
    the same way.
    """
    if target_kind == "comment" and document_id:
        load_document_comment(repositories, context, document_id, target_id)
        return None
    if target_kind == "issue":
        return load_visible_issue(repositories, context, target_id).team_id

    if not issue_id:
        raise not_found()
    issue = load_visible_issue(repositories, context, issue_id)
    comment = repositories.comments.get(context.workspace_id, issue_id, target_id)
    if comment is None or comment.document_id:
        raise not_found()
    return issue.team_id


def _issue_of(target_id: str, target_kind: str, issue_id: str | None) -> str:
    """The issue a resolved issue or issue comment target belongs to, carried on the row for the notify consumer."""
    return target_id if target_kind == "issue" else issue_id or ""


def add_reaction(
    repositories: Repositories,
    context: AuthzContext,
    target_id: str,
    target_kind: str,
    emoji: str,
    *,
    issue_id: str | None = None,
    document_id: str | None = None,
) -> ReactionGroupRead:
    """React to a target, answering with that emoji's group as it now stands.

    Idempotent by key, so a second add by the same user is the same row and the
    same answer rather than a conflict. A custom `:name:` must be an emoji the
    workspace has. The emoji is expected already normalised, the way the route's
    schema and the MCP tool's argument check both normalise it.
    """
    team_id = resolve_target(repositories, context, target_id, target_kind, issue_id, document_id)
    if team_id is None and document_id:
        require_document_commenter(repositories, context, document_id)
    else:
        require_team_member(repositories, context, team_id or "")
    require_custom_emoji(repositories, context.workspace_id, emoji)

    repositories.reactions.put(
        build_reaction(
            context.workspace_id,
            target_id,
            target_kind,
            team_id or NO_TEAM,
            emoji,
            context.user_id,
            issue_id="" if team_id is None else _issue_of(target_id, target_kind, issue_id),
        )
    )

    rows = repositories.reactions.list_for_target(context.workspace_id, target_id)
    groups = [group for group in group_reactions(rows, context.user_id) if group.emoji == emoji]
    if not groups:
        raise not_found()
    return groups[0]


def remove_reaction(
    repositories: Repositories,
    context: AuthzContext,
    target_id: str,
    target_kind: str,
    emoji: str,
    *,
    issue_id: str | None = None,
    document_id: str | None = None,
) -> None:
    """Take back one's own reaction, whether or not it was there.

    The reacting user alone: the key names them, so there is no path by which one
    member removes another's reaction. The emoji is normalised the way the write
    normalised it, so the variation selector form removes the row it created.
    """
    team_id = resolve_target(repositories, context, target_id, target_kind, issue_id, document_id)
    if team_id is not None and not context.can_see_team(team_id):
        raise forbidden()
    repositories.reactions.delete(context.workspace_id, target_id, reaction_key(emoji), context.user_id)
