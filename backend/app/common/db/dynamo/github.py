"""The `github` table: one workspace's installation, repositories, links and endpoints.

Four entities share the partition and are told apart by their sort key prefix,
`install#<iid>`, `repo#<rid>`, `link#<pr_node_id>` and `webhook#<id>`, because each
one is read either by its exact key or as a prefix query inside one workspace, and
none of them is large enough to earn a table of its own.

`installation_id-index` is the only index in the product whose hash key is not
workspace scoped, and it cannot be. A webhook delivery arrives carrying an
installation id and nothing else, so resolving the workspace from it is exactly
what the index exists for; every other read here is a query inside one workspace
partition.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Page, Repository, new_ulid

from app.common.db.dynamo.base import as_item, build_repository, first, utc_now
from app.common.db.dynamo.tables import GITHUB

INSTALLATION_INDEX = "installation_id-index"
LINK_INDEX = "ws_issue-link-index"

PrState = Literal["open", "closed", "merged", "draft"]

PR_STATES: tuple[str, ...] = ("open", "closed", "merged", "draft")

OutboundEvent = Literal["issue.created", "issue.updated", "issue.status_changed", "comment.created"]

OUTBOUND_EVENTS: tuple[str, ...] = (
    "issue.created",
    "issue.updated",
    "issue.status_changed",
    "comment.created",
)
"""What an outbound endpoint may subscribe to, per the M5 contract."""


def new_webhook_id() -> str:
    """A fresh outbound endpoint id, time sortable so a list reads in creation order."""
    return new_ulid()


def install_key(installation_id: str) -> str:
    """The sort key of one installation row."""
    return f"install#{installation_id}"


def repo_key(repository_id: str) -> str:
    """The sort key of one linked repository."""
    return f"repo#{repository_id}"


def link_key(pr_node_id: str) -> str:
    """The sort key of one pull request link.

    Keyed by the pull request's GitHub node id rather than a generated id, because
    a replayed delivery must reach the same row: the node id is what the event
    carries and is what makes the consumer's write idempotent.
    """
    return f"link#{pr_node_id}"


def webhook_key(webhook_id: str) -> str:
    """The sort key of one outbound webhook endpoint."""
    return f"webhook#{webhook_id}"


INSTALL_PREFIX = "install#"
REPO_PREFIX = "repo#"
LINK_PREFIX = "link#"
WEBHOOK_PREFIX = "webhook#"


def ws_issue(workspace_id: str, issue_id: str) -> str:
    """The link index's hash key, scoped to one workspace and one issue."""
    return f"{workspace_id}#{issue_id}"


class Installation(BaseModel):
    """One workspace's GitHub App installation.

    A workspace holds at most one: the install route refuses a second, because two
    installations would make "which one does this repository belong to" a question
    the delivery cannot answer.
    """

    workspace_id: str
    github_key: str
    installation_id: str
    account_login: str
    account_type: str = "Organization"
    repository_selection: str = "selected"
    html_url: str = ""
    avatar_url: str = ""
    installed_by: str
    installed_at: datetime = Field(default_factory=utc_now)
    suspended_at: datetime | None = None


class Repository_(BaseModel):
    """One repository the installation covers.

    `team_id` is nullable and means "match this repository's issue keys against
    every team of the workspace". Set, it narrows the match to one team,
    which is what stops a monorepo's branch names from moving another team's
    issues.
    """

    workspace_id: str
    github_key: str
    repository_id: str
    installation_id: str
    full_name: str
    name: str
    private: bool = True
    default_branch: str = "main"
    team_id: str | None = None
    linked_at: datetime = Field(default_factory=utc_now)


class IssueLink(BaseModel):
    """One pull request linked to one issue.

    `applied_status_id` and `comment_id` are what make the write-back skippable on
    a retry: a job that finds the state it was about to set already recorded does
    nothing rather than posting a second comment.
    """

    workspace_id: str
    github_key: str
    ws_issue: str
    link_id: str
    issue_id: str
    issue_key: str
    repository_full_name: str
    pr_number: int
    pr_title: str = ""
    pr_url: str = ""
    pr_state: str = "open"
    author_login: str = ""
    magic_word: str | None = None
    applied_status_id: str | None = None
    comment_id: str | None = None
    check_run_id: str | None = None
    linked_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class WebhookEndpoint(BaseModel):
    """One outbound endpoint of a workspace.

    `secret_hash` verifies a secret rather than reproducing one. The signing key is
    derived per endpoint from the environment's master key, so no customer secret
    is ever at rest in this table and losing the table loses no credential.
    """

    workspace_id: str
    github_key: str
    webhook_id: str
    url: str
    events: list[str] = Field(default_factory=lambda: list(OUTBOUND_EVENTS))
    description: str | None = None
    active: bool = True
    secret_hash: str = ""
    secret_salt: str = ""
    secret_hint: str = ""
    last_status: int | None = None
    last_delivery_at: datetime | None = None
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class GithubRepository:
    """Reads and writes `github` rows, every method workspace first.

    The one exception is `installation_by_id`, which takes no workspace because
    resolving the workspace is what it does. It is reachable only from the queue
    consumer, never from a request handler, so no route takes an installation id
    from a caller.
    """

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(GITHUB, repository)

    def get_installation(self, workspace_id: str) -> Installation | None:
        """The workspace's installation, or `None`."""
        if not workspace_id:
            return None
        items = self._query(workspace_id, INSTALL_PREFIX, 1)
        item = first(list(items))
        return Installation.model_validate(dict(item)) if item is not None else None

    def installation_by_id(self, installation_id: str) -> Installation | None:
        """The installation with this GitHub id, across every workspace.

        The only read in the product that crosses a workspace boundary, and the
        only caller is the queue consumer resolving a delivery. A request handler
        that wanted this would be taking an installation id from a caller, which
        is why no route does.
        """
        if not installation_id:
            return None
        page: Page = self._repository.query(
            Key("installation_id").eq(installation_id),
            index_name=INSTALLATION_INDEX,
            limit=5,
        )
        for item in page.items:
            if str(item.get("github_key", "")).startswith(INSTALL_PREFIX):
                return Installation.model_validate(dict(item))
        return None

    def create_installation(self, installation: Installation) -> Installation:
        """Store one installation, raising `ConditionFailed` when one is already there."""
        self._repository.put(as_item(installation), condition=Attr("github_key").not_exists())
        return installation

    def put_installation(self, installation: Installation) -> Installation:
        """Store or replace one installation row, for a refresh of one already bound."""
        self._repository.put(as_item(installation))
        return installation

    def put_repository(self, repository: Repository_) -> Repository_:
        """Store or replace one repository row.

        A plain put rather than a create, because `installation_repositories` replays
        the same repository whenever the selection changes and the row's content is
        entirely derived from the event.
        """
        self._repository.put(as_item(repository))
        return repository

    def list_repositories(self, workspace_id: str, *, limit: int = 500) -> list[Repository_]:
        """Every repository of one workspace's installation, by name."""
        rows = [Repository_.model_validate(dict(item)) for item in self._query(workspace_id, REPO_PREFIX, limit)]
        return sorted(rows, key=lambda row: row.full_name.lower())

    def get_repository(self, workspace_id: str, repository_id: str) -> Repository_ | None:
        """One repository row, or `None`."""
        if not workspace_id or not repository_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "github_key": repo_key(repository_id)})
        return Repository_.model_validate(dict(item)) if item is not None else None

    def delete_repository(self, workspace_id: str, repository_id: str) -> bool:
        """Remove one repository row, reporting whether one was there."""
        return self._delete(workspace_id, repo_key(repository_id))

    def set_repository_team(self, workspace_id: str, repository_id: str, team_id: str | None) -> bool:
        """Point one repository at a team, or at every team when `None`."""
        key = {"workspace_id": workspace_id, "github_key": repo_key(repository_id)}
        try:
            self._repository.set_attributes(key, {"team_id": team_id}, condition=Attr("repository_id").exists())
        except ConditionFailed:
            return False
        return True

    def get_link(self, workspace_id: str, pr_node_id: str) -> IssueLink | None:
        """One pull request link, or `None`."""
        if not workspace_id or not pr_node_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "github_key": link_key(pr_node_id)})
        return IssueLink.model_validate(dict(item)) if item is not None else None

    def put_link(self, link: IssueLink) -> IssueLink:
        """Store or replace one pull request link.

        A put rather than a create, because every delivery about the same pull
        request rewrites the same row: that is what makes a replayed delivery leave
        the table in the state one delivery would have.
        """
        self._repository.put(as_item(link))
        return link

    def update_link(self, workspace_id: str, pr_node_id: str, **attributes: Any) -> IssueLink | None:
        """Apply `attributes` to one link, or `None` when it does not exist."""
        values: dict[str, Any] = {name: value for name, value in attributes.items()}
        values["updated_at"] = utc_now().isoformat()
        key = {"workspace_id": workspace_id, "github_key": link_key(pr_node_id)}
        try:
            item = self._repository.set_attributes(key, values, condition=Attr("link_id").exists())
        except ConditionFailed:
            return None
        return IssueLink.model_validate(dict(item)) if item is not None else None

    def list_links_for_issue(
        self,
        workspace_id: str,
        issue_id: str,
        *,
        limit: int = 50,
        start_key: Mapping[str, Any] | None = None,
    ) -> Page:
        """One issue's pull request links, newest first, as a cursor page."""
        return self._repository.query(
            Key("ws_issue").eq(ws_issue(workspace_id, issue_id)),
            index_name=LINK_INDEX,
            limit=limit,
            start_key=dict(start_key) if start_key else None,
            ascending=False,
        )

    def delete_link(self, workspace_id: str, pr_node_id: str) -> bool:
        """Remove one link, reporting whether one was there."""
        return self._delete(workspace_id, link_key(pr_node_id))

    def delete_links_for_issue(self, workspace_id: str, issue_id: str, *, batch: int = 50) -> int:
        """Remove every pull request link of one issue, a page at a time, returning how many went."""
        removed = 0
        while True:
            page = self.list_links_for_issue(workspace_id, issue_id, limit=batch)
            if not page.items:
                return removed
            removed += self._repository.delete_many(
                [{"workspace_id": workspace_id, "github_key": item["github_key"]} for item in page.items]
            )

    def get_endpoint(self, workspace_id: str, webhook_id: str) -> WebhookEndpoint | None:
        """One outbound endpoint, or `None`."""
        if not workspace_id or not webhook_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "github_key": webhook_key(webhook_id)})
        return WebhookEndpoint.model_validate(dict(item)) if item is not None else None

    def create_endpoint(self, endpoint: WebhookEndpoint) -> WebhookEndpoint:
        """Store one outbound endpoint, raising `ConditionFailed` on a key collision."""
        self._repository.put(as_item(endpoint), condition=Attr("github_key").not_exists())
        return endpoint

    def list_endpoints(self, workspace_id: str, *, limit: int = 100) -> list[WebhookEndpoint]:
        """Every outbound endpoint of one workspace, oldest first."""
        rows = [WebhookEndpoint.model_validate(dict(item)) for item in self._query(workspace_id, WEBHOOK_PREFIX, limit)]
        return sorted(rows, key=lambda row: row.webhook_id)

    def update_endpoint(self, workspace_id: str, webhook_id: str, **attributes: Any) -> WebhookEndpoint | None:
        """Apply `attributes` to one endpoint, or `None` when it does not exist."""
        values = {name: value for name, value in attributes.items() if value is not None}
        key = {"workspace_id": workspace_id, "github_key": webhook_key(webhook_id)}
        if not values:
            item = self._repository.get(key)
            return WebhookEndpoint.model_validate(dict(item)) if item is not None else None
        values["updated_at"] = utc_now().isoformat()
        try:
            item = self._repository.set_attributes(key, values, condition=Attr("webhook_id").exists())
        except ConditionFailed:
            return None
        return WebhookEndpoint.model_validate(dict(item)) if item is not None else None

    def delete_endpoint(self, workspace_id: str, webhook_id: str) -> bool:
        """Remove one outbound endpoint, reporting whether one was there."""
        return self._delete(workspace_id, webhook_key(webhook_id))

    def delete_installation(self, workspace_id: str) -> int:
        """Forget the installation, its repositories and its links, returning how many went.

        The outbound endpoints are deliberately left: they are the workspace's own
        configuration and have nothing to do with GitHub, so uninstalling the App
        must not silently stop a customer's integration.
        """
        removed = 0
        for prefix in (INSTALL_PREFIX, REPO_PREFIX, LINK_PREFIX):
            for item in self._query(workspace_id, prefix, 1000):
                self._repository.delete({"workspace_id": workspace_id, "github_key": item["github_key"]})
                removed += 1
        return removed

    def _query(self, workspace_id: str, prefix: str, limit: int) -> list[Mapping[str, Any]]:
        """Every row of one workspace under a sort key prefix."""
        if not workspace_id or not prefix:
            return []
        return list(
            self._repository.iter_query(
                Key("workspace_id").eq(workspace_id) & Key("github_key").begins_with(prefix),
                max_items=limit,
            )
        )

    def _delete(self, workspace_id: str, github_key: str) -> bool:
        """Remove one row, reporting whether one was there."""
        key = {"workspace_id": workspace_id, "github_key": github_key}
        if self._repository.get(key) is None:
            return False
        self._repository.delete(key)
        return True
