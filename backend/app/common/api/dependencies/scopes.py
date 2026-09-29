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
a route somebody decided against. Workspace deletion, credential minting, billing,
the GitHub installation and anything else irreversible at workspace level land here.
"""

ISSUES_READ = ("issues:read",)

ISSUES_WRITE = ("issues:write",)

COMMENTS_WRITE = ("comments:write",)

TEAMS_READ = ("teams:read",)

TEAMS_WRITE = ("teams:write",)

MEMBERS_READ = ("members:read",)

MEMBERS_WRITE = ("members:write",)

STATUSES_READ = ("statuses:read",)

STATUSES_WRITE = ("statuses:write",)

LABELS_READ = ("labels:read",)

LABELS_WRITE = ("labels:write",)

PROJECTS_READ = ("projects:read",)

PROJECTS_WRITE = ("projects:write",)

MILESTONES_READ = ("milestones:read",)

MILESTONES_WRITE = ("milestones:write",)

CYCLES_READ = ("cycles:read",)

CYCLES_WRITE = ("cycles:write",)

VIEWS_READ = ("views:read",)

VIEWS_WRITE = ("views:write",)

NOTIFICATIONS_READ = ("notifications:read",)

NOTIFICATIONS_WRITE = ("notifications:write",)

SETTINGS_READ = ("settings:read",)

SETTINGS_WRITE_ADMIN = ("settings:write", "admin")

MEMBERS_READ_ADMIN = ("members:read", "admin")

MEMBERS_WRITE_ADMIN = ("members:write", "admin")
"""Workspace administration: the resource scope and `admin` together.

`admin` is live only for an owner or an admin, and the route still checks the
role, so the pair is what lets a credential exercise that role at all.
"""

ROUTE_SCOPES: Mapping[tuple[str, str], tuple[str, ...]] = {
    ("GET", "/{workspace_id}"): SETTINGS_READ,
    ("PATCH", "/{workspace_id}"): SETTINGS_WRITE_ADMIN,
    ("POST", "/{workspace_id}/icon/uploads"): SETTINGS_WRITE_ADMIN,
    ("PUT", "/{workspace_id}/icon"): SETTINGS_WRITE_ADMIN,
    ("DELETE", "/{workspace_id}/icon"): SETTINGS_WRITE_ADMIN,
    ("POST", "/{workspace_id}/deletion"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/deletion"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/members"): MEMBERS_READ,
    ("PATCH", "/{workspace_id}/members/{user_id}"): MEMBERS_WRITE_ADMIN,
    ("DELETE", "/{workspace_id}/members/{user_id}"): MEMBERS_WRITE_ADMIN,
    ("GET", "/{workspace_id}/invites"): MEMBERS_READ_ADMIN,
    ("POST", "/{workspace_id}/invites"): MEMBERS_WRITE_ADMIN,
    ("DELETE", "/{workspace_id}/invites/{invite_id}"): MEMBERS_WRITE_ADMIN,
    ("GET", "/{workspace_id}/api-keys"): NO_KEY_ACCESS,
    ("POST", "/{workspace_id}/api-keys"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/api-keys/{key_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/billing"): NO_KEY_ACCESS,
    ("POST", "/{workspace_id}/billing/checkout-session"): NO_KEY_ACCESS,
    ("POST", "/{workspace_id}/billing/portal-session"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/connected-apps"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/connected-apps/{user_id}/{client_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/teams"): TEAMS_READ,
    ("POST", "/{workspace_id}/teams"): TEAMS_WRITE,
    ("PUT", "/{workspace_id}/teams/order"): TEAMS_WRITE,
    ("GET", "/{workspace_id}/teams/{team_id}"): TEAMS_READ,
    ("PATCH", "/{workspace_id}/teams/{team_id}"): TEAMS_WRITE,
    ("POST", "/{workspace_id}/teams/{team_id}/icon/uploads"): TEAMS_WRITE,
    ("PUT", "/{workspace_id}/teams/{team_id}/icon"): TEAMS_WRITE,
    ("DELETE", "/{workspace_id}/teams/{team_id}/icon"): TEAMS_WRITE,
    ("DELETE", "/{workspace_id}/teams/{team_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/teams/{team_id}/cycle-settings"): TEAMS_READ,
    ("PATCH", "/{workspace_id}/teams/{team_id}/cycle-settings"): TEAMS_WRITE,
    ("GET", "/{workspace_id}/teams/{team_id}/archive-settings"): TEAMS_READ,
    ("PATCH", "/{workspace_id}/teams/{team_id}/archive-settings"): TEAMS_WRITE,
    ("GET", "/{workspace_id}/teams/{team_id}/members"): MEMBERS_READ,
    ("PUT", "/{workspace_id}/teams/{team_id}/members/{user_id}"): MEMBERS_WRITE,
    ("DELETE", "/{workspace_id}/teams/{team_id}/members/{user_id}"): MEMBERS_WRITE,
    ("POST", "/{workspace_id}/teams/{team_id}/join"): MEMBERS_WRITE,
    ("POST", "/{workspace_id}/teams/{team_id}/leave"): MEMBERS_WRITE,
    ("GET", "/{workspace_id}/teams/{team_id}/statuses"): STATUSES_READ,
    ("POST", "/{workspace_id}/teams/{team_id}/statuses"): STATUSES_WRITE,
    ("PATCH", "/{workspace_id}/teams/{team_id}/statuses/{status_id}"): STATUSES_WRITE,
    ("DELETE", "/{workspace_id}/teams/{team_id}/statuses/{status_id}"): STATUSES_WRITE,
    ("GET", "/{workspace_id}/teams/{team_id}/labels"): LABELS_READ,
    ("POST", "/{workspace_id}/teams/{team_id}/labels"): LABELS_WRITE,
    ("PATCH", "/{workspace_id}/teams/{team_id}/labels/{label_id}"): LABELS_WRITE,
    ("DELETE", "/{workspace_id}/teams/{team_id}/labels/{label_id}"): LABELS_WRITE,
    ("GET", "/{workspace_id}/issues"): ISSUES_READ,
    ("POST", "/{workspace_id}/issues"): ISSUES_WRITE,
    ("PATCH", "/{workspace_id}/issues"): ISSUES_WRITE,
    ("GET", "/{workspace_id}/issues/by-key/{key}"): ISSUES_READ,
    ("GET", "/{workspace_id}/issues/{issue_id}"): ISSUES_READ,
    ("PATCH", "/{workspace_id}/issues/{issue_id}"): ISSUES_WRITE,
    ("DELETE", "/{workspace_id}/issues/{issue_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/issues/{issue_id}/children"): ISSUES_READ,
    ("POST", "/{workspace_id}/issues/{issue_id}/archive"): ISSUES_WRITE,
    ("POST", "/{workspace_id}/issues/{issue_id}/unarchive"): ISSUES_WRITE,
    ("GET", "/{workspace_id}/issues/{issue_id}/activity"): ISSUES_READ,
    ("GET", "/{workspace_id}/issues/{issue_id}/links"): ISSUES_READ,
    ("POST", "/{workspace_id}/issues/{issue_id}/links"): ISSUES_WRITE,
    ("DELETE", "/{workspace_id}/issues/{issue_id}/links/{link_id}"): ISSUES_WRITE,
    ("GET", "/{workspace_id}/issues/{issue_id}/github-links"): ISSUES_READ,
    ("GET", "/{workspace_id}/issues/{issue_id}/subscribers"): ISSUES_READ,
    ("PUT", "/{workspace_id}/issues/{issue_id}/subscribers/me"): ISSUES_WRITE,
    ("DELETE", "/{workspace_id}/issues/{issue_id}/subscribers/me"): ISSUES_WRITE,
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
    ("GET", "/{workspace_id}/attachments/media"): ISSUES_READ,
    ("GET", "/{workspace_id}/attachments/usage"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/attachments/{attachment_id}/content"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/attachments/{attachment_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/cycles"): CYCLES_READ,
    ("POST", "/{workspace_id}/cycles"): CYCLES_WRITE,
    ("GET", "/{workspace_id}/cycles/velocity"): CYCLES_READ,
    ("GET", "/{workspace_id}/cycles/{cycle_id}"): CYCLES_READ,
    ("GET", "/{workspace_id}/cycles/{cycle_id}/history"): CYCLES_READ,
    ("PATCH", "/{workspace_id}/cycles/{cycle_id}"): CYCLES_WRITE,
    ("DELETE", "/{workspace_id}/cycles/{cycle_id}"): CYCLES_WRITE,
    ("GET", "/{workspace_id}/projects"): PROJECTS_READ,
    ("POST", "/{workspace_id}/projects"): PROJECTS_WRITE,
    ("GET", "/{workspace_id}/projects/{project_id}"): PROJECTS_READ,
    ("PATCH", "/{workspace_id}/projects/{project_id}"): PROJECTS_WRITE,
    ("DELETE", "/{workspace_id}/projects/{project_id}"): PROJECTS_WRITE,
    ("GET", "/{workspace_id}/projects/{project_id}/milestones"): MILESTONES_READ,
    ("POST", "/{workspace_id}/projects/{project_id}/milestones"): MILESTONES_WRITE,
    ("PATCH", "/{workspace_id}/projects/{project_id}/milestones/{milestone_id}"): MILESTONES_WRITE,
    ("DELETE", "/{workspace_id}/projects/{project_id}/milestones/{milestone_id}"): MILESTONES_WRITE,
    ("GET", "/{workspace_id}/projects/{project_id}/updates"): PROJECTS_READ,
    ("POST", "/{workspace_id}/projects/{project_id}/updates"): PROJECTS_WRITE,
    ("PATCH", "/{workspace_id}/projects/{project_id}/updates/{update_id}"): PROJECTS_WRITE,
    ("DELETE", "/{workspace_id}/projects/{project_id}/updates/{update_id}"): PROJECTS_WRITE,
    ("GET", "/{workspace_id}/roadmap"): PROJECTS_READ,
    ("GET", "/{workspace_id}/board"): VIEWS_READ,
    ("GET", "/{workspace_id}/board/columns/{status_id}"): VIEWS_READ,
    ("GET", "/{workspace_id}/views"): VIEWS_READ,
    ("POST", "/{workspace_id}/views"): VIEWS_WRITE,
    ("GET", "/{workspace_id}/views/{view_id}"): VIEWS_READ,
    ("PATCH", "/{workspace_id}/views/{view_id}"): VIEWS_WRITE,
    ("DELETE", "/{workspace_id}/views/{view_id}"): VIEWS_WRITE,
    ("GET", "/{workspace_id}/search"): ISSUES_READ,
    ("GET", "/{workspace_id}/inbox"): NOTIFICATIONS_READ,
    ("GET", "/{workspace_id}/inbox/count"): NOTIFICATIONS_READ,
    ("POST", "/{workspace_id}/inbox/read"): NOTIFICATIONS_WRITE,
    ("POST", "/{workspace_id}/inbox/unread"): NOTIFICATIONS_WRITE,
    ("POST", "/{workspace_id}/inbox/snooze"): NOTIFICATIONS_WRITE,
    ("DELETE", "/{workspace_id}/inbox/{notification_id}"): NOTIFICATIONS_WRITE,
    ("GET", "/{workspace_id}/share-links"): NO_KEY_ACCESS,
    ("POST", "/{workspace_id}/share-links"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/share-links/{token_hash}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/github/install-url"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/github/installation"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/github/installation"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/github/repositories"): NO_KEY_ACCESS,
    ("PATCH", "/{workspace_id}/github/repositories/{repository_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/teams/{team_id}/github-transitions"): TEAMS_READ,
    ("POST", "/{workspace_id}/teams/{team_id}/github-transitions"): TEAMS_WRITE,
    ("PUT", "/{workspace_id}/teams/{team_id}/github-transitions"): TEAMS_WRITE,
    ("PATCH", "/{workspace_id}/teams/{team_id}/github-transitions/{transition_id}"): TEAMS_WRITE,
    ("DELETE", "/{workspace_id}/teams/{team_id}/github-transitions/{transition_id}"): TEAMS_WRITE,
    ("GET", "/{workspace_id}/teams/{team_id}/github-sync"): TEAMS_READ,
    ("PUT", "/{workspace_id}/teams/{team_id}/github-sync"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/teams/{team_id}/github-sync"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/issues/{issue_id}/github-sync"): ISSUES_READ,
    ("GET", "/{workspace_id}/webhooks"): NO_KEY_ACCESS,
    ("POST", "/{workspace_id}/webhooks"): NO_KEY_ACCESS,
    ("PATCH", "/{workspace_id}/webhooks/{webhook_id}"): NO_KEY_ACCESS,
    ("POST", "/{workspace_id}/webhooks/{webhook_id}/rotate"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/webhooks/{webhook_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/webhooks/{webhook_id}/deliveries"): NO_KEY_ACCESS,
    ("POST", "/{workspace_id}/webhooks/{webhook_id}/ping"): NO_KEY_ACCESS,
    ("POST", "/{workspace_id}/webhooks/{webhook_id}/deliveries/{delivery_id}/redeliver"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/teams/{team_id}/webhooks"): NO_KEY_ACCESS,
    ("POST", "/{workspace_id}/teams/{team_id}/webhooks"): NO_KEY_ACCESS,
    ("PATCH", "/{workspace_id}/teams/{team_id}/webhooks/{webhook_id}"): NO_KEY_ACCESS,
    ("POST", "/{workspace_id}/teams/{team_id}/webhooks/{webhook_id}/rotate"): NO_KEY_ACCESS,
    ("DELETE", "/{workspace_id}/teams/{team_id}/webhooks/{webhook_id}"): NO_KEY_ACCESS,
    ("GET", "/{workspace_id}/teams/{team_id}/webhooks/{webhook_id}/deliveries"): NO_KEY_ACCESS,
    ("POST", "/{workspace_id}/teams/{team_id}/webhooks/{webhook_id}/ping"): NO_KEY_ACCESS,
    ("POST", "/{workspace_id}/teams/{team_id}/webhooks/{webhook_id}/deliveries/{delivery_id}/redeliver"): NO_KEY_ACCESS,
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
