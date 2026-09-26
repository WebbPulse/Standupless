"""Which scopes each REST route needs, as one table read by the one authorization path.

The m6 contract assigns a scope to a capability, not to a role, and the two do not
line up: `POST /issues` and `GET /issues` both declare `WORKSPACE_READ`, because a
member may do either. So the required scope cannot be derived from the capability a
route already declares, and deriving it from the HTTP verb alone would be wrong in
the other direction, since `POST /inbox/read` writes nothing a key should need
`issues:write` for.

What does determine it is the route itself, which is why this is a table keyed by
the method and the router-relative path template that `request.scope["route"]`
carries. Every workspace-scoped router mounts under the same `/api/workspaces`
prefix, so that template is unique across the product, which `test_scopes.py`
holds.

The table is exhaustive and fail closed. A route absent from it refuses every API
key, so adding a route without deciding its scope denies a key rather than handing
it one, and `test_scopes.py` fails until the decision is recorded here.
"""

from __future__ import annotations

from typing import Mapping, Optional

NO_KEY_ACCESS: tuple[str, ...] = ()
"""A route no API key may reach, whatever scopes it carries.

Spelled as an empty requirement rather than an omission so the table stays
exhaustive: `None` from a lookup means a route nobody thought about, and this means
a route somebody decided against. Workspace administration, credential minting and
every delete land here, per the contract's rule that no scope reaches them.
"""

ISSUES_READ = ("issues:read",)

ISSUES_WRITE = ("issues:write",)

COMMENTS_WRITE = ("comments:write",)

TEAMS_READ = ("teams:read",)

VIEWS_READ = ("views:read",)

ROUTE_SCOPES: Mapping[tuple[str, str], tuple[str, ...]] = {
    ("GET", "/{workspace_id}"): TEAMS_READ,
    ("PATCH", "/{workspace_id}"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/members"): TEAMS_READ,
    ("PATCH", "/{workspace_id}/members/{user_id}"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/members/{user_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/invites"): NO_KEY_ACCESS,
    ("POST", "/{workspace_id}/invites"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/invites/{invite_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/api-keys"): NO_KEY_ACCESS,
    ("POST", "/{workspace_id}/api-keys"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/api-keys/{key_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/teams"): TEAMS_READ,
    ("POST", "/{workspace_id}/teams"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/teams/{team_id}"): TEAMS_READ,
    ("PATCH", "/{workspace_id}/teams/{team_id}"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/teams/{team_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/teams/{team_id}/members"): TEAMS_READ,
    ("PUT", "/{workspace_id}/teams/{team_id}/members/{user_id}"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/teams/{team_id}/members/{user_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/teams/{team_id}/statuses"): TEAMS_READ,
    ("POST", "/{workspace_id}/teams/{team_id}/statuses"): NO_KEY_ACCESS,
    ("PATCH", "/{workspace_id}/teams/{team_id}/statuses/{status_id}"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/teams/{team_id}/statuses/{status_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/teams/{team_id}/labels"): TEAMS_READ,
    ("POST", "/{workspace_id}/teams/{team_id}/labels"): NO_KEY_ACCESS,
    ("PATCH", "/{workspace_id}/teams/{team_id}/labels/{label_id}"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/teams/{team_id}/labels/{label_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/issues"): ISSUES_READ,
    ("POST", "/{workspace_id}/issues"): ISSUES_WRITE,
    ("PATCH", "/{workspace_id}/issues"): ISSUES_WRITE,
    ("GET", "/{workspace_id}/issues/by-key/{key}"): ISSUES_READ,
    ("GET", "/{workspace_id}/issues/{issue_id}"): ISSUES_READ,
    ("PATCH", "/{workspace_id}/issues/{issue_id}"): ISSUES_WRITE,
    ("DELETE", "/{workspace_id}/issues/{issue_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/issues/{issue_id}/children"): ISSUES_READ,
    ("GET", "/{workspace_id}/issues/{issue_id}/activity"): ISSUES_READ,
    ("GET", "/{workspace_id}/issues/{issue_id}/links"): ISSUES_READ,
    ("POST", "/{workspace_id}/issues/{issue_id}/links"): ISSUES_WRITE,
    ("DELETE", "/{workspace_id}/issues/{issue_id}/links/{link_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/issues/{issue_id}/github-links"): ISSUES_READ,
    ("GET", "/{workspace_id}/issues/{issue_id}/comments"): ISSUES_READ,
    ("POST", "/{workspace_id}/issues/{issue_id}/comments"): COMMENTS_WRITE,
    ("GET", "/{workspace_id}/comments/{comment_id}"): ISSUES_READ,
    ("PATCH", "/{workspace_id}/comments/{comment_id}"): COMMENTS_WRITE,
    ("DELETE", "/{workspace_id}/comments/{comment_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/reactions"): ISSUES_READ,
    ("PUT", "/{workspace_id}/reactions"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/reactions"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/attachments"): ISSUES_READ,
    ("POST", "/{workspace_id}/attachments"): NO_KEY_ACCESS,
    ("POST", "/{workspace_id}/attachments/uploads"): NO_KEY_ACCESS,
    ("POST", "/{workspace_id}/attachments/url"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/attachments/{attachment_id}/download"): ISSUES_READ,
    ("DELETE", "/{workspace_id}/attachments/{attachment_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/cycles"): TEAMS_READ,
    ("POST", "/{workspace_id}/cycles"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/cycles/{cycle_id}"): TEAMS_READ,
    ("PATCH", "/{workspace_id}/cycles/{cycle_id}"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/cycles/{cycle_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/projects"): TEAMS_READ,
    ("POST", "/{workspace_id}/projects"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/projects/{project_id}"): TEAMS_READ,
    ("PATCH", "/{workspace_id}/projects/{project_id}"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/projects/{project_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/roadmap"): TEAMS_READ,
    ("GET", "/{workspace_id}/board"): VIEWS_READ,
    ("GET", "/{workspace_id}/board/columns/{status_id}"): VIEWS_READ,
    ("GET", "/{workspace_id}/views"): VIEWS_READ,
    ("POST", "/{workspace_id}/views"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/views/{view_id}"): VIEWS_READ,
    ("PATCH", "/{workspace_id}/views/{view_id}"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/views/{view_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/search"): ISSUES_READ,
    ("GET", "/{workspace_id}/inbox"): VIEWS_READ,
    ("GET", "/{workspace_id}/inbox/count"): VIEWS_READ,
    ("POST", "/{workspace_id}/inbox/read"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/inbox/{notification_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/share-links"): NO_KEY_ACCESS,
    ("POST", "/{workspace_id}/share-links"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/share-links/{token_hash}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/github/install-url"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/github/installation"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/github/installation"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/github/repositories"): NO_KEY_ACCESS,
    ("PATCH", "/{workspace_id}/github/repositories/{repository_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/teams/{team_id}/github-transitions"): TEAMS_READ,
    ("POST", "/{workspace_id}/teams/{team_id}/github-transitions"): NO_KEY_ACCESS,
    ("PATCH", "/{workspace_id}/teams/{team_id}/github-transitions/{transition_id}"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/teams/{team_id}/github-transitions/{transition_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/webhooks"): NO_KEY_ACCESS,
    ("POST", "/{workspace_id}/webhooks"): NO_KEY_ACCESS,
    ("PATCH", "/{workspace_id}/webhooks/{webhook_id}"): NO_KEY_ACCESS,
    ("POST", "/{workspace_id}/webhooks/{webhook_id}/rotate"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/webhooks/{webhook_id}"): NO_KEY_ACCESS,
}
"""Every workspace-scoped route, against the scopes an API key needs to reach it.

Keyed by the method and the router-relative template rather than the full path,
because that is what a dependency can read off the matched route without knowing
which prefix its router was included under.
"""


def scopes_for_route(method: str, route_path: Optional[str]) -> Optional[tuple[str, ...]]:
    """The scopes this route needs, or `None` when the table does not name it.

    `None` is the fail-closed answer the caller turns into a refusal, so a route
    added without an entry here denies every key instead of admitting one.
    """
    if not route_path:
        return None
    return ROUTE_SCOPES.get((method.upper(), route_path))
