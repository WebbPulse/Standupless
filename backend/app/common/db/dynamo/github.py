"""The `github` table: one workspace's installation, repositories, links, endpoints and sync state.

The entities share the partition and are told apart by their sort key prefix,
`install#<iid>`, `repo#<rid>`, `link#<pr_node_id>`, `prstate#<rid>#<number>` and
`webhook#<id>`, plus the
issue sync rows described on `TeamSync`, `IssueSync` and `CommentSync`, because
each one is read either by its exact key or as a prefix query inside one
workspace, and none of them is large enough to earn a table of its own. None of
the sync rows carries `ws_issue`, which keeps them out of the pull request link
index.

`installation_id-index` is the only index in the product whose hash key is not
workspace scoped, and it cannot be. A webhook delivery arrives carrying an
installation id and nothing else, so resolving the workspace from it is exactly
what the index exists for; every other read here is a query inside one workspace
partition.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Mapping, Sequence

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field, TypeAdapter, model_validator
from webbpulse.dynamodb import ConditionFailed, Page, Repository, new_ulid

from app.common.db.dynamo.base import as_item, build_repository, delete_partition, first, utc_now
from app.common.db.dynamo.channels import ChannelStore
from app.common.db.dynamo.discord import DiscordStore
from app.common.db.dynamo.slack import SlackStore
from app.common.db.dynamo.tables import GITHUB

INSTALLATION_INDEX = "installation_id-index"
LINK_INDEX = "ws_issue-link-index"

_DATETIME: TypeAdapter[datetime] = TypeAdapter(datetime)

PrState = Literal["open", "closed", "merged", "draft"]

PR_STATES: tuple[str, ...] = ("open", "closed", "merged", "draft")

PR_STATE_RANK: dict[str, int] = {"draft": 0, "open": 0, "closed": 1, "merged": 2}
"""How far along a pull request state is, which breaks a tie between two deliveries
raised in the same second: GitHub's `updated_at` has one second resolution, so a
close and the delivery before it can carry the same stamp, and the further state
is the one that happened last."""

TOMBSTONE_RETENTION_SECONDS = 30 * 24 * 3600
"""How long a deleted GitHub issue or comment is remembered, longer than SQS keeps
any message, so a late or redriven delivery about it finds the tombstone."""

RESOURCE_TYPES: tuple[str, ...] = ("issues", "comments", "projects", "project_updates", "cycles", "labels")
"""What an outbound endpoint may subscribe to, one entry per kind of row it describes."""

LEGACY_EVENT_RESOURCES: dict[str, str] = {
    "issue.created": "issues",
    "issue.updated": "issues",
    "issue.status_changed": "issues",
    "comment.created": "comments",
}
"""How a row written before resource types reads its old `events` list."""

DeliveryState = Literal["pending", "retrying", "delivered", "failed"]

DELIVERY_RETENTION_SECONDS = 30 * 24 * 3600
"""How long a delivery log row lives before the table's TTL removes it."""


def source_millis(value: datetime | None) -> int:
    """A GitHub timestamp as epoch milliseconds, or 0 when there is none.

    Stored as a number rather than the ISO string because a condition compares it,
    and ISO strings with and without a fraction do not sort as the times they name.
    """
    return int(value.timestamp() * 1000) if value is not None else 0


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


def pr_state_key(repository_id: str, number: int) -> str:
    """The sort key of one linked pull request's review and check state.

    Keyed by repository and number rather than node id, because a `check_run`
    delivery names its pull requests by number and nothing else.
    """
    return f"{PR_STATE_PREFIX}{repository_id}#{number}"


def webhook_key(webhook_id: str) -> str:
    """The sort key of one outbound webhook endpoint."""
    return f"webhook#{webhook_id}"


def delivery_prefix(webhook_id: str) -> str:
    """The sort key prefix every delivery of one endpoint shares."""
    return f"{DELIVERY_PREFIX}{webhook_id}#"


def delivery_key(webhook_id: str, delivery_id: str) -> str:
    """The sort key of one delivery, which sorts by time inside its endpoint."""
    return f"{delivery_prefix(webhook_id)}{delivery_id}"


INSTALL_PREFIX = "install#"
REPO_PREFIX = "repo#"
LINK_PREFIX = "link#"
PR_STATE_PREFIX = "prstate#"
WEBHOOK_PREFIX = "webhook#"
DELIVERY_PREFIX = "whdelivery#"
TEAM_SYNC_PREFIX = "teamsync#"
SYNC_REPO_PREFIX = "syncrepo#"
ISSUE_SYNC_PREFIX = "issuesync#"
GITHUB_ISSUE_PREFIX = "ghissue#"
COMMENT_SYNC_PREFIX = "cmtsync#"
GITHUB_COMMENT_PREFIX = "ghcomment#"
BACKLINK_PREFIX = "backlink#"
DISPATCH_SLOTS_KEY = "dispatch#slots"
"""The one row per workspace holding the leases on its in-flight webhook attempts."""

DISPATCH_SLOTS_RETENTION_SECONDS = 24 * 3600
"""How long an idle workspace's slot row lives before the table's TTL removes it."""

SYNC_PREFIXES: tuple[str, ...] = (
    TEAM_SYNC_PREFIX,
    SYNC_REPO_PREFIX,
    ISSUE_SYNC_PREFIX,
    GITHUB_ISSUE_PREFIX,
    COMMENT_SYNC_PREFIX,
    GITHUB_COMMENT_PREFIX,
    BACKLINK_PREFIX,
)
"""Every sort key prefix the issue sync writes, which is what a purge has to clear."""

SyncDirection = Literal["two_way", "github_to_standupless"]

SYNC_DIRECTIONS: tuple[str, ...] = ("two_way", "github_to_standupless")

SyncOrigin = Literal["github", "standupless"]


def team_sync_key(team_id: str) -> str:
    """The sort key of one team's sync configuration."""
    return f"{TEAM_SYNC_PREFIX}{team_id}"


def sync_repo_key(repository_id: str) -> str:
    """The sort key of the claim that ties one repository to one syncing team."""
    return f"{SYNC_REPO_PREFIX}{repository_id}"


def issue_sync_key(issue_id: str) -> str:
    """The sort key of one issue's sync state."""
    return f"{ISSUE_SYNC_PREFIX}{issue_id}"


def github_issue_key(repository_id: str, number: int) -> str:
    """The sort key of the pointer from a GitHub issue to the issue it syncs with."""
    return f"{GITHUB_ISSUE_PREFIX}{repository_id}#{number}"


def comment_sync_key(issue_id: str, comment_id: str) -> str:
    """The sort key of one comment's sync state, under its issue so a purge finds it."""
    return f"{COMMENT_SYNC_PREFIX}{issue_id}#{comment_id}"


def github_comment_key(github_comment_id: str) -> str:
    """The sort key of the pointer from a GitHub comment to the comment it syncs with."""
    return f"{GITHUB_COMMENT_PREFIX}{github_comment_id}"


def backlink_key(issue_id: str) -> str:
    """The sort key of the App's backlink comment on the GitHub issue one issue syncs with."""
    return f"{BACKLINK_PREFIX}{issue_id}"


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

    `team_id` is the team whose releases the repository's deployments feed, null
    for none. Issue keys match against every team of the workspace either way.
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

    `pr_updated_ms` is the pull request's own `updated_at` as of the delivery that
    wrote the row, in epoch milliseconds. It is what `put_link` orders on, so a late
    or redriven delivery cannot move the row back to an older state.

    `applied_labels` names the labels the App put on the pull request, mirrored on
    every link of that pull request, so the label sync removes only what it added.
    `detached` marks a link whose key a later delivery no longer names, which is
    how the label sync tells an unlinked issue from a linked one.

    The branch, review and check fields are copied from the pull request's
    `PullRequestState` row whenever it changes, so a read of an issue's links
    has what a stack and its status icons need without a second read. A row
    written before they existed reads as an unstacked pull request with no review
    and no checks.
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
    pr_updated_ms: int = 0
    repository_id: str = ""
    applied_labels: list[str] = Field(default_factory=list)
    detached: bool = False
    head_ref: str = ""
    base_ref: str = ""
    previous_base_refs: list[str] = Field(default_factory=list)
    from_fork: bool = False
    review_state: str = "none"
    ci_state: str = "none"
    linked_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class ReviewEntry(BaseModel):
    """One reviewer's latest review that counts toward the decision."""

    review_id: int = 0
    state: str = ""


class CheckEntry(BaseModel):
    """The newest run of one named check on one commit."""

    check_run_id: int = 0
    status: str = ""
    conclusion: str = ""


class PullRequestState(BaseModel):
    """What GitHub says about one linked pull request beyond its open or merged state.

    One row per pull request rather than per link, because reviews and check runs
    arrive about the pull request and a pull request may name several issues.
    `pr_updated_ms` orders the branch and reviewer fields the way `put_link` orders
    the link, `reviews` keeps each reviewer's highest review id, and `checks` keeps
    the newest run of each check name per head commit, so every delivery may land
    in any order and the row still converges. `version` guards each write, so two
    consumers racing on one pull request cannot both win.
    """

    workspace_id: str
    github_key: str
    repository_id: str
    pr_number: int
    node_id: str = ""
    head_ref: str = ""
    head_sha: str = ""
    base_ref: str = ""
    previous_base_refs: list[str] = Field(default_factory=list)
    from_fork: bool = False
    pr_updated_ms: int = 0
    requested_reviewers: int = 0
    reviews: dict[str, ReviewEntry] = Field(default_factory=dict)
    checks: dict[str, dict[str, CheckEntry]] = Field(default_factory=dict)
    version: int = 0
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
    label: str = ""
    team_id: str | None = None
    resource_types: list[str] = Field(default_factory=lambda: list(RESOURCE_TYPES))
    active: bool = True
    secret_hash: str = ""
    secret_salt: str = ""
    secret_hint: str = ""
    last_status: int | None = None
    last_delivery_at: datetime | None = None
    consecutive_failures: int = 0
    disabled_reason: str | None = None
    disabled_at: datetime | None = None
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    @model_validator(mode="before")
    @classmethod
    def _read_legacy_shape(cls, value: Any) -> Any:
        """Read a row written before labels and resource types.

        Such a row carries `description` and an `events` list instead, so the label
        falls back to the description and the resource types follow from the events.
        """
        if not isinstance(value, Mapping):
            return value
        row = dict(value)
        if "resource_types" not in row and row.get("events"):
            row["resource_types"] = sorted(
                {LEGACY_EVENT_RESOURCES[event] for event in row["events"] if event in LEGACY_EVENT_RESOURCES}
            )
        if not row.get("label") and row.get("description"):
            row["label"] = row["description"]
        return row

    def matches(self, resource_type: str, team_ids: "Sequence[str]") -> bool:
        """Whether this endpoint is enabled and wants an event about these teams."""
        if not self.active or resource_type not in self.resource_types:
            return False
        return self.team_id is None or self.team_id in team_ids


class DeliveryAttempt(BaseModel):
    """One try at posting a delivery, with what came back."""

    attempt: int
    at: datetime
    status_code: int
    latency_ms: int
    error: str | None = None
    response_body: str = ""


class WebhookDelivery(BaseModel):
    """One event sent, or being sent, to one endpoint, with every attempt made at it.

    `body` is the exact JSON the endpoint was sent, so a redelivery posts the same
    bytes under a fresh signature. `expires_at` is epoch seconds for the table TTL.
    """

    workspace_id: str
    github_key: str
    delivery_id: str
    webhook_id: str
    event_type: str
    action: str
    state: DeliveryState = "pending"
    is_test: bool = False
    redelivery_of: str | None = None
    body: str
    attempts: list[DeliveryAttempt] = Field(default_factory=list)
    next_attempt_at: datetime | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    expires_at: int = 0


class TeamSync(BaseModel):
    """One team's two way issue sync with one GitHub repository.

    A repository syncs with at most one team, enforced by a `syncrepo#` claim row
    written beside this one, because a GitHub issue that imported into two teams
    would have two sources of truth and no way to say which one a comment belongs
    to. `direction` limits the sync to GitHub into Standupless when a team wants
    the mirror without writing back, and is forced there when the repository is
    public, since two way sync would publish the team's private issues, unless
    `allow_public_two_way` says the team chose to publish them.
    `public_demoted_at` records when a link was forced to one way.
    """

    workspace_id: str
    github_key: str
    team_id: str
    repository_id: str
    full_name: str
    direction: str = "two_way"
    enabled: bool = True
    sync_labels: bool = True
    allow_public_two_way: bool = False
    public_demoted_at: datetime | None = None
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    @property
    def writes_back(self) -> bool:
        """Whether Standupless changes are written to GitHub."""
        return self.enabled and self.direction == "two_way"


class SyncPointer(BaseModel):
    """A lookup row from a GitHub identifier to the Standupless row it syncs with.

    Used for the repository claim, the GitHub issue number and the GitHub comment
    id, each of which a delivery carries while the Standupless id is what the
    state row is keyed by. A GitHub issue pointer with an empty `target_id` is a
    tombstone for a deleted GitHub issue, which no import can claim.
    """

    workspace_id: str
    github_key: str
    target_id: str
    issue_id: str | None = None


class IssueSync(BaseModel):
    """The sync state of one issue and the GitHub issue it mirrors.

    `github` and `standupless` are each side's field values as of the last sync,
    which is how a change is told apart from an echo: a delivery or a stream record
    whose values match its own snapshot moved nothing, so it writes nothing, and
    that is what stops the two sides bouncing an edit between them. `version`
    guards every snapshot write, so two consumers racing on one issue cannot both
    win. `state` is `pending` while an outbound create holds the claim.
    """

    workspace_id: str
    github_key: str
    issue_id: str
    team_id: str
    repository_id: str
    full_name: str
    number: int = 0
    node_id: str = ""
    html_url: str = ""
    origin: str = "github"
    state: str = "linked"
    github: dict[str, Any] = Field(default_factory=dict)
    standupless: dict[str, Any] = Field(default_factory=dict)
    version: int = 0
    synced_at: datetime = Field(default_factory=utc_now)


class CommentSync(BaseModel):
    """The sync state of one comment and the GitHub comment it mirrors.

    `origin` says which side wrote the comment first. Only that side's edits are
    carried across, because the other side's copy is authored by the App or by the
    attribution placeholder and editing it would be editing someone else's words.
    `github_updated_ms` is the GitHub comment's `updated_at` as of the last inbound
    write, which orders edits, and `state` is `deleted` on the tombstone a GitHub
    delete leaves, so a late `created` or `edited` cannot bring the comment back.
    """

    workspace_id: str
    github_key: str
    issue_id: str
    comment_id: str
    github_comment_id: str = ""
    origin: str = "github"
    state: str = "linked"
    body: str = ""
    github_updated_ms: int = 0
    synced_at: datetime = Field(default_factory=utc_now)


class IssueBacklink(BaseModel):
    """The one comment the App posts on a synced GitHub issue, linking back to the issue here.

    Kept on its own row rather than on `IssueSync`, because the snapshot row is
    replaced whole under its version guard and a field written beside it would be
    lost to the next snapshot save. `repository_id` and `number` name the GitHub
    issue the comment sits on, so a row left over from another GitHub issue is
    never taken for this one's. `state` is `pending` while a post holds the claim,
    and `body` is what was last written, which is how a job tells an identifier or
    title change from a comment that is already current.
    """

    workspace_id: str
    github_key: str
    issue_id: str
    repository_id: str
    number: int
    comment_id: str = ""
    body: str = ""
    state: str = "pending"
    claimed_at: datetime = Field(default_factory=utc_now)


def _stored_time(value: datetime) -> str:
    """A datetime in the string form `as_item` stores, so a condition compares like with like."""
    return str(_DATETIME.dump_python(value, mode="json"))


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
        self.channels = ChannelStore(self._repository)
        self.slack = SlackStore(self._repository)
        self.discord = DiscordStore(self._repository)

    def delete_workspace_rows(self, workspace_id: str) -> int:
        """Delete every row this table holds for one workspace, for the workspace purge."""
        return delete_partition(self._repository, GITHUB, workspace_id)

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

    def rename_repository(self, workspace_id: str, repository_id: str, full_name: str, name: str) -> bool:
        """Set one repository row's display names after a rename, reporting whether a row was there.

        A field update rather than a put, so a team pin written meanwhile is kept.
        """
        key = {"workspace_id": workspace_id, "github_key": repo_key(repository_id)}
        try:
            self._repository.set_attributes(
                key, {"full_name": full_name, "name": name}, condition=Attr("repository_id").eq(repository_id)
            )
        except ConditionFailed:
            return False
        return True

    def get_link(self, workspace_id: str, pr_node_id: str) -> IssueLink | None:
        """One pull request link, or `None`."""
        if not workspace_id or not pr_node_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "github_key": link_key(pr_node_id)})
        return IssueLink.model_validate(dict(item)) if item is not None else None

    def put_link(self, link: IssueLink) -> bool:
        """Store or replace one pull request link unless the row holds a newer state.

        A put rather than a create, because every delivery about the same pull
        request rewrites the same row: that is what makes a replayed delivery leave
        the table in the state one delivery would have.

        The put is conditioned on the pull request's own `updated_at`, the way
        GitHub's webhook guidance asks for since deliveries are not ordered: an
        older delivery never replaces a newer one. On a tie the state may only
        stay or move forward by `PR_STATE_RANK`, and a merged row is terminal
        against every delivery that is not itself a merge, because GitHub cannot
        unmerge a pull request. A row written before the stamp existed orders
        behind any delivery, but still keeps a merge. Returns whether the row was
        written; `False` means the delivery was stale.
        """
        stamp = link.pr_updated_ms
        rank = PR_STATE_RANK.get(link.pr_state, 0)
        not_behind = [state for state, value in PR_STATE_RANK.items() if value <= rank]
        ordered = (
            Attr("pr_updated_ms").not_exists()
            | Attr("pr_updated_ms").lt(stamp)
            | (Attr("pr_updated_ms").eq(stamp) & Attr("pr_state").is_in(not_behind))
        )
        if link.pr_state != "merged":
            ordered = ordered & Attr("pr_state").ne("merged")
        try:
            self._repository.put(as_item(link), condition=Attr("github_key").not_exists() | ordered)
        except ConditionFailed:
            return False
        return True

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

    def list_links_for_pr(self, workspace_id: str, pr_node_id: str, *, limit: int = 200) -> list[IssueLink]:
        """Every link of one pull request, one per issue it ever named."""
        if not workspace_id or not pr_node_id:
            return []
        rows = self._query(workspace_id, f"{link_key(pr_node_id)}#", limit, consistent=True)
        return [IssueLink.model_validate(dict(item)) for item in rows]

    def get_links(self, workspace_id: str, link_ids: Sequence[str]) -> list[IssueLink]:
        """The named links that still exist, read strongly consistent in one batch."""
        wanted = [link_id for link_id in dict.fromkeys(link_ids) if link_id]
        if not workspace_id or not wanted:
            return []
        items = self._repository.batch_get(
            [{"workspace_id": workspace_id, "github_key": link_key(link_id)} for link_id in wanted],
            consistent=True,
        )
        return [IssueLink.model_validate(dict(item)) for item in items]

    def iter_links(self, workspace_id: str, *, limit: int = 100_000) -> list[IssueLink]:
        """Every pull request link of one workspace, for a backfill that has to visit them all."""
        return [IssueLink.model_validate(dict(item)) for item in self._query(workspace_id, LINK_PREFIX, limit)]

    def get_pr_state(self, workspace_id: str, repository_id: str, number: int) -> PullRequestState | None:
        """One pull request's review and check state, or `None`."""
        if not workspace_id or not repository_id or not number:
            return None
        key = {"workspace_id": workspace_id, "github_key": pr_state_key(repository_id, number)}
        item = self._repository.get(key, consistent=True)
        return PullRequestState.model_validate(dict(item)) if item is not None else None

    def save_pr_state(self, state: PullRequestState, *, expected_version: int) -> bool:
        """Replace one pull request's state if nobody has moved it since `expected_version`.

        Returns `False` on a lost race, which the caller answers by reading the
        winner's row and applying its change again.
        """
        saved = state.model_copy(update={"version": expected_version + 1, "updated_at": utc_now()})
        condition = Attr("github_key").not_exists() if expected_version == 0 else Attr("version").eq(expected_version)
        try:
            self._repository.put(as_item(saved), condition=condition)
        except ConditionFailed:
            return False
        return True

    def detach_link(self, workspace_id: str, link_id: str, pr_updated_ms: int) -> bool:
        """Mark one link as no longer named by its pull request, unless the row holds a newer state.

        Ordered on `pr_updated_ms` like `put_link`, and a merged link is left alone,
        so a late delivery cannot detach an issue a newer one named again.
        """
        key = {"workspace_id": workspace_id, "github_key": link_key(link_id)}
        condition = (
            Attr("link_id").exists()
            & Attr("pr_state").ne("merged")
            & (Attr("pr_updated_ms").not_exists() | Attr("pr_updated_ms").lt(pr_updated_ms))
        )
        try:
            self._repository.set_attributes(
                key,
                {"detached": True, "pr_updated_ms": pr_updated_ms, "updated_at": utc_now().isoformat()},
                condition=condition,
            )
        except ConditionFailed:
            return False
        return True

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
        """One outbound endpoint, or `None`.

        A strongly consistent read, because every management route reads the row
        before it writes and an admin often rotates or pings the moment after a
        create; an eventually consistent read can miss that write and answer 404.
        """
        if not workspace_id or not webhook_id:
            return None
        item = self._repository.get(
            {"workspace_id": workspace_id, "github_key": webhook_key(webhook_id)},
            consistent=True,
        )
        return WebhookEndpoint.model_validate(dict(item)) if item is not None else None

    def create_endpoint(self, endpoint: WebhookEndpoint) -> WebhookEndpoint:
        """Store one outbound endpoint, raising `ConditionFailed` on a key collision."""
        self._repository.put(as_item(endpoint), condition=Attr("github_key").not_exists())
        return endpoint

    def list_endpoints(self, workspace_id: str, *, limit: int = 100, consistent: bool = True) -> list[WebhookEndpoint]:
        """Every outbound endpoint of one workspace, oldest first.

        Strongly consistent by default, so a list right after a create or delete shows
        it. The stream consumer reads eventually consistently at half the cost, since
        it already runs seconds behind the write it is reacting to.
        """
        items = self._query(workspace_id, WEBHOOK_PREFIX, limit, consistent=consistent)
        rows = [WebhookEndpoint.model_validate(dict(item)) for item in items]
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
        """Remove one outbound endpoint and its delivery log, reporting whether it was there."""
        self.delete_deliveries(workspace_id, webhook_id)
        return self._delete(workspace_id, webhook_key(webhook_id))

    def delete_team_endpoints(self, workspace_id: str, team_id: str) -> int:
        """Remove every endpoint scoped to one team, with their logs, for the team purge."""
        removed = 0
        for endpoint in self.list_endpoints(workspace_id):
            if team_id and endpoint.team_id == team_id and self.delete_endpoint(workspace_id, endpoint.webhook_id):
                removed += 1
        return removed

    def clear_endpoint_fields(self, workspace_id: str, webhook_id: str, *names: str) -> WebhookEndpoint | None:
        """Remove optional attributes from one endpoint, or `None` when it does not exist."""
        key = {"workspace_id": workspace_id, "github_key": webhook_key(webhook_id)}
        try:
            item = self._repository.remove_attributes(key, list(names), condition=Attr("webhook_id").exists())
        except ConditionFailed:
            return None
        return WebhookEndpoint.model_validate(dict(item)) if item is not None else None

    def count_failure(self, workspace_id: str, webhook_id: str) -> int:
        """Add one to an endpoint's run of failed attempts and return the new run.

        Conditional on the endpoint still existing, so a failure that lands after a
        delete does not recreate a husk row; that case answers zero.
        """
        key = {"workspace_id": workspace_id, "github_key": webhook_key(webhook_id)}
        try:
            attributes = self._repository.update(
                key,
                update_expression="ADD #failures :one",
                expression_names={"#failures": "consecutive_failures"},
                expression_values={":one": 1},
                condition=Attr("webhook_id").exists(),
                return_values="UPDATED_NEW",
            )
        except ConditionFailed:
            return 0
        return int((attributes or {}).get("consecutive_failures", 0))

    def acquire_dispatch_slot(
        self, workspace_id: str, *, limit: int, lease_seconds: float, now_ms: int
    ) -> tuple[int, int] | None:
        """Lease one of a workspace's `limit` in-flight attempt slots, or `None` when all are held.

        Each slot is an attribute holding the epoch millisecond its lease ends, so a
        slot whose holder died frees itself when the lease runs out. Returns the slot
        and its lease end, which `release_dispatch_slot` needs to free only its own lease.
        """
        key = {"workspace_id": workspace_id, "github_key": DISPATCH_SLOTS_KEY}
        until = now_ms + int(lease_seconds * 1000)
        for slot in range(limit):
            try:
                self._repository.update(
                    key,
                    update_expression="SET #slot = :until, #expires = :expires",
                    expression_names={"#slot": f"slot_{slot}", "#expires": "expires_at"},
                    expression_values={
                        ":until": until,
                        ":now": now_ms,
                        ":expires": now_ms // 1000 + DISPATCH_SLOTS_RETENTION_SECONDS,
                    },
                    condition="attribute_not_exists(#slot) OR #slot < :now",
                )
            except ConditionFailed:
                continue
            return slot, until
        return None

    def release_dispatch_slot(self, workspace_id: str, slot: int, until: int) -> None:
        """Free a slot this caller leased, leaving it alone when the lease has passed to another."""
        key = {"workspace_id": workspace_id, "github_key": DISPATCH_SLOTS_KEY}
        try:
            self._repository.update(
                key,
                update_expression="REMOVE #slot",
                expression_names={"#slot": f"slot_{slot}"},
                expression_values={":until": until},
                condition="#slot = :until",
            )
        except ConditionFailed:
            return

    def put_delivery(self, delivery: WebhookDelivery) -> WebhookDelivery:
        """Store one delivery row, replacing any row with the same key."""
        self._repository.put(as_item(delivery))
        return delivery

    def create_delivery(self, delivery: WebhookDelivery) -> bool:
        """Store a new delivery, reporting `False` when that delivery already exists.

        The stream consumer derives a delivery id from the stream record, so a
        redelivered stream batch lands on the same row rather than sending twice.
        """
        try:
            self._repository.put(as_item(delivery), condition=Attr("github_key").not_exists())
        except ConditionFailed:
            return False
        return True

    def get_delivery(self, workspace_id: str, webhook_id: str, delivery_id: str) -> WebhookDelivery | None:
        """One delivery of one endpoint, or `None`."""
        if not workspace_id or not webhook_id or not delivery_id:
            return None
        item = self._repository.get(
            {"workspace_id": workspace_id, "github_key": delivery_key(webhook_id, delivery_id)},
            consistent=True,
        )
        return WebhookDelivery.model_validate(dict(item)) if item is not None else None

    def list_deliveries(self, workspace_id: str, webhook_id: str, *, limit: int = 50) -> list[WebhookDelivery]:
        """One endpoint's most recent deliveries, newest first."""
        if not workspace_id or not webhook_id:
            return []
        page = self._repository.query(
            Key("workspace_id").eq(workspace_id) & Key("github_key").begins_with(delivery_prefix(webhook_id)),
            limit=limit,
            ascending=False,
        )
        return [WebhookDelivery.model_validate(dict(item)) for item in page.items]

    def delete_deliveries(self, workspace_id: str, webhook_id: str) -> int:
        """Remove every delivery row of one endpoint, returning how many went."""
        if not workspace_id or not webhook_id:
            return 0
        rows = self._query(workspace_id, delivery_prefix(webhook_id), 10_000)
        return self._repository.delete_many(
            [{"workspace_id": workspace_id, "github_key": item["github_key"]} for item in rows]
        )

    def delete_installation(self, workspace_id: str) -> int:
        """Forget the installation, its repositories, links and sync state, returning how many went.

        The outbound endpoints are deliberately left: they are the workspace's own
        configuration and have nothing to do with GitHub, so uninstalling the App
        must not silently stop a customer's integration.
        """
        removed = 0
        for prefix in (INSTALL_PREFIX, REPO_PREFIX, LINK_PREFIX, PR_STATE_PREFIX, *SYNC_PREFIXES):
            for item in self._query(workspace_id, prefix, 1000):
                self._repository.delete({"workspace_id": workspace_id, "github_key": item["github_key"]})
                removed += 1
        return removed

    def get_team_sync(self, workspace_id: str, team_id: str) -> TeamSync | None:
        """One team's sync configuration, or `None`."""
        if not workspace_id or not team_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "github_key": team_sync_key(team_id)})
        return TeamSync.model_validate(dict(item)) if item is not None else None

    def list_team_syncs(self, workspace_id: str, *, limit: int = 200) -> list[TeamSync]:
        """Every team sync configuration of one workspace."""
        return [TeamSync.model_validate(dict(item)) for item in self._query(workspace_id, TEAM_SYNC_PREFIX, limit)]

    def team_sync_for_repository(self, workspace_id: str, repository_id: str) -> TeamSync | None:
        """The team sync a repository is claimed by, or `None`."""
        if not workspace_id or not repository_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "github_key": sync_repo_key(repository_id)})
        if item is None:
            return None
        sync = self.get_team_sync(workspace_id, str(item.get("target_id", "")))
        return sync if sync is not None and sync.repository_id == repository_id else None

    def put_team_sync(self, sync: TeamSync) -> TeamSync:
        """Store one team's sync configuration, claiming its repository first.

        Raises `ConditionFailed` when another team already syncs the repository. A
        team moving to a different repository releases the claim it held.
        """
        claim = SyncPointer(
            workspace_id=sync.workspace_id,
            github_key=sync_repo_key(sync.repository_id),
            target_id=sync.team_id,
        )
        self._repository.put(
            as_item(claim),
            condition=Attr("github_key").not_exists() | Attr("target_id").eq(sync.team_id),
        )
        previous = self.get_team_sync(sync.workspace_id, sync.team_id)
        if previous is not None and previous.repository_id != sync.repository_id:
            self._release_repository(sync.workspace_id, previous.repository_id, sync.team_id)
        self._repository.put(as_item(sync))
        return sync

    def rename_team_sync(self, workspace_id: str, team_id: str, repository_id: str, full_name: str) -> bool:
        """Set one team sync's repository display name, only while it still syncs `repository_id`."""
        key = {"workspace_id": workspace_id, "github_key": team_sync_key(team_id)}
        try:
            self._repository.set_attributes(
                key, {"full_name": full_name}, condition=Attr("repository_id").eq(repository_id)
            )
        except ConditionFailed:
            return False
        return True

    def set_repository_private(self, workspace_id: str, repository_id: str, private: bool) -> bool:
        """Record one repository's visibility, reporting whether a row was there."""
        key = {"workspace_id": workspace_id, "github_key": repo_key(repository_id)}
        try:
            self._repository.set_attributes(
                key, {"private": private}, condition=Attr("repository_id").eq(repository_id)
            )
        except ConditionFailed:
            return False
        return True

    def demote_team_sync(self, workspace_id: str, team_id: str, repository_id: str) -> bool:
        """Drop one team's two way sync to one way, only while it is two way with `repository_id`.

        Conditioned so that two deliveries racing on one visibility change demote
        once, and the caller records the change once, and so that a link whose team
        allows two way sync on a public repository is never demoted.
        """
        key = {"workspace_id": workspace_id, "github_key": team_sync_key(team_id)}
        now = utc_now().isoformat()
        try:
            self._repository.set_attributes(
                key,
                {"direction": "github_to_standupless", "public_demoted_at": now, "updated_at": now},
                condition=Attr("repository_id").eq(repository_id)
                & Attr("direction").eq("two_way")
                & (Attr("allow_public_two_way").not_exists() | Attr("allow_public_two_way").eq(False)),
            )
        except ConditionFailed:
            return False
        return True

    def delete_team_sync(self, workspace_id: str, team_id: str) -> bool:
        """Stop one team syncing, releasing its repository claim."""
        previous = self.get_team_sync(workspace_id, team_id)
        if previous is None:
            return False
        self._release_repository(workspace_id, previous.repository_id, team_id)
        return self._delete(workspace_id, team_sync_key(team_id))

    def _release_repository(self, workspace_id: str, repository_id: str, team_id: str) -> None:
        """Drop a repository claim, but only one this team holds."""
        key = {"workspace_id": workspace_id, "github_key": sync_repo_key(repository_id)}
        item = self._repository.get(key)
        if item is not None and str(item.get("target_id", "")) == team_id:
            self._repository.delete(key)

    def get_issue_sync(self, workspace_id: str, issue_id: str) -> IssueSync | None:
        """One issue's sync state, or `None`."""
        if not workspace_id or not issue_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "github_key": issue_sync_key(issue_id)})
        return IssueSync.model_validate(dict(item)) if item is not None else None

    def issue_sync_for_github(self, workspace_id: str, repository_id: str, number: int) -> IssueSync | None:
        """The sync state of the issue a GitHub issue mirrors, or `None`."""
        if not workspace_id or not repository_id or not number:
            return None
        item = self._repository.get(
            {"workspace_id": workspace_id, "github_key": github_issue_key(repository_id, number)}
        )
        if item is None:
            return None
        return self.get_issue_sync(workspace_id, str(item.get("target_id", "")))

    def claim_issue_sync(self, sync: IssueSync, *, stale_before: datetime | None = None) -> bool:
        """Write a new issue's sync row, refusing when one is already there.

        A `pending` row older than `stale_before` is taken over, so an outbound
        create that died between its claim and GitHub's answer does not strand the
        issue forever. A row that already names a GitHub issue claims that issue's
        pointer first, so two deliveries importing one GitHub issue under two new
        ids cannot both win.
        """
        if sync.number:
            pointer = SyncPointer(
                workspace_id=sync.workspace_id,
                github_key=github_issue_key(sync.repository_id, sync.number),
                target_id=sync.issue_id,
                issue_id=sync.issue_id,
            )
            try:
                self._repository.put(
                    as_item(pointer),
                    condition=Attr("github_key").not_exists() | Attr("target_id").eq(sync.issue_id),
                )
            except ConditionFailed:
                return False
        condition = Attr("github_key").not_exists()
        if stale_before is not None:
            condition = condition | (Attr("state").eq("pending") & Attr("synced_at").lt(_stored_time(stale_before)))
        try:
            self._repository.put(as_item(sync), condition=condition)
        except ConditionFailed:
            return False
        return True

    def save_issue_sync(self, sync: IssueSync, *, expected_version: int) -> IssueSync:
        """Replace one issue's sync row if nobody has moved it since `expected_version`.

        Raises `ConditionFailed` on a lost race, which a consumer lets propagate so
        the queue redelivers and the retry diffs against the winner's snapshot.
        """
        saved = sync.model_copy(update={"version": expected_version + 1, "synced_at": utc_now()})
        self._repository.put(as_item(saved), condition=Attr("version").eq(expected_version))
        if saved.number:
            self._put_github_issue_pointer(saved)
        return saved

    def rehome_issue_sync(self, workspace_id: str, issue_id: str, team_id: str, *, attempts: int = 3) -> bool:
        """Point one issue's sync row at the team the issue moved to, answering whether it changed.

        Written under the row's version guard like every snapshot save, retried on a
        lost race. A `pending` row is left alone, because the outbound create holding
        it saves against the version it claimed and would lose the GitHub issue it
        just opened.
        """
        for _ in range(attempts):
            sync = self.get_issue_sync(workspace_id, issue_id)
            if sync is None or sync.team_id == team_id or sync.state == "pending":
                return False
            try:
                self.save_issue_sync(sync.model_copy(update={"team_id": team_id}), expected_version=sync.version)
            except ConditionFailed:
                continue
            return True
        return False

    def _put_github_issue_pointer(self, sync: IssueSync) -> None:
        """Point the GitHub issue at the issue it syncs with."""
        pointer = SyncPointer(
            workspace_id=sync.workspace_id,
            github_key=github_issue_key(sync.repository_id, sync.number),
            target_id=sync.issue_id,
            issue_id=sync.issue_id,
        )
        self._repository.put(as_item(pointer))

    def delete_issue_sync(self, workspace_id: str, issue_id: str) -> int:
        """Forget one issue's sync state, its GitHub pointer and its comments' sync rows."""
        removed = 0
        sync = self.get_issue_sync(workspace_id, issue_id)
        if sync is not None and sync.number:
            removed += int(self._delete(workspace_id, github_issue_key(sync.repository_id, sync.number)))
        for item in self._query(workspace_id, f"{COMMENT_SYNC_PREFIX}{issue_id}#", 1000):
            github_comment_id = str(item.get("github_comment_id", ""))
            if github_comment_id:
                removed += int(self._delete(workspace_id, github_comment_key(github_comment_id)))
            self._repository.delete({"workspace_id": workspace_id, "github_key": item["github_key"]})
            removed += 1
        removed += int(self._delete(workspace_id, backlink_key(issue_id)))
        removed += int(self._delete(workspace_id, issue_sync_key(issue_id)))
        return removed

    def list_issue_syncs(self, workspace_id: str, team_id: str, *, limit: int = 1000) -> list[IssueSync]:
        """Every linked issue sync row of one team, for a backlink backfill."""
        rows = [IssueSync.model_validate(dict(item)) for item in self._query(workspace_id, ISSUE_SYNC_PREFIX, limit)]
        return [row for row in rows if row.team_id == team_id and row.state == "linked" and row.number]

    def get_backlink(self, workspace_id: str, issue_id: str) -> IssueBacklink | None:
        """One issue's backlink comment row, or `None`."""
        if not workspace_id or not issue_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "github_key": backlink_key(issue_id)})
        return IssueBacklink.model_validate(dict(item)) if item is not None else None

    def claim_backlink(self, row: IssueBacklink, *, stale_before: datetime) -> bool:
        """Take the right to post one issue's backlink, refusing while another job holds it.

        A `pending` claim older than `stale_before` is taken over, so a job that
        died mid post does not leave the issue without a backlink forever.
        """
        condition = Attr("github_key").not_exists() | (
            Attr("state").eq("pending") & Attr("claimed_at").lt(_stored_time(stale_before))
        )
        try:
            self._repository.put(as_item(row), condition=condition)
        except ConditionFailed:
            return False
        return True

    def save_backlink(self, row: IssueBacklink) -> IssueBacklink:
        """Store one issue's backlink row as posted or updated."""
        self._repository.put(as_item(row))
        return row

    def delete_backlink(self, workspace_id: str, issue_id: str) -> bool:
        """Forget one issue's backlink row, so the next job posts afresh."""
        return self._delete(workspace_id, backlink_key(issue_id))

    def get_comment_sync(self, workspace_id: str, issue_id: str, comment_id: str) -> CommentSync | None:
        """One comment's sync state, or `None`."""
        if not workspace_id or not issue_id or not comment_id:
            return None
        item = self._repository.get(
            {"workspace_id": workspace_id, "github_key": comment_sync_key(issue_id, comment_id)}
        )
        return CommentSync.model_validate(dict(item)) if item is not None else None

    def comment_sync_for_github(self, workspace_id: str, github_comment_id: str) -> CommentSync | None:
        """The sync state of the comment a GitHub comment mirrors, or `None`."""
        if not workspace_id or not github_comment_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "github_key": github_comment_key(github_comment_id)})
        if item is None:
            return None
        return self.get_comment_sync(workspace_id, str(item.get("issue_id", "")), str(item.get("target_id", "")))

    def claim_comment_sync(self, sync: CommentSync, *, stale_before: datetime | None = None) -> bool:
        """Write a new comment's sync row, refusing when one is already there.

        A row that already names a GitHub comment claims that comment's pointer
        first, so one GitHub comment delivered twice becomes one comment here.
        """
        if sync.github_comment_id:
            try:
                self._put_github_comment_pointer(
                    sync, condition=Attr("github_key").not_exists() | Attr("target_id").eq(sync.comment_id)
                )
            except ConditionFailed:
                return False
        condition = Attr("github_key").not_exists()
        if stale_before is not None:
            condition = condition | (Attr("state").eq("pending") & Attr("synced_at").lt(_stored_time(stale_before)))
        try:
            self._repository.put(as_item(sync), condition=condition)
        except ConditionFailed:
            return False
        return True

    def tombstone_github_issue(self, workspace_id: str, repository_id: str, number: int) -> None:
        """Remember that a GitHub issue was deleted, so no late delivery imports it.

        GitHub never reuses an issue number inside a repository, so the tombstone
        cannot block a real issue. It expires after `TOMBSTONE_RETENTION_SECONDS`,
        by which point SQS has let go of every delivery that could name it.
        """
        if not workspace_id or not repository_id or not number:
            return
        pointer = SyncPointer(
            workspace_id=workspace_id,
            github_key=github_issue_key(repository_id, number),
            target_id="",
        )
        expires_at = int(utc_now().timestamp()) + TOMBSTONE_RETENTION_SECONDS
        self._repository.put(as_item(pointer, state="deleted", expires_at=expires_at))

    def advance_comment_sync(self, sync: CommentSync) -> bool:
        """Replace a linked comment's sync row unless it already holds a later GitHub edit.

        Conditioned on `github_updated_ms`, so an older `edited` delivery landing
        after a newer one is refused rather than rolling the text back, and on the
        row still being `linked`, so an edit landing after a delete does nothing.
        A delivery carrying no timestamp is ordered only by the state check.
        Returns whether the row was written.
        """
        condition = Attr("state").eq("linked")
        if sync.github_updated_ms:
            condition = condition & (
                Attr("github_updated_ms").not_exists() | Attr("github_updated_ms").lte(sync.github_updated_ms)
            )
        saved = sync.model_copy(update={"synced_at": utc_now()})
        try:
            self._repository.put(as_item(saved), condition=condition)
        except ConditionFailed:
            return False
        return True

    def tombstone_comment_sync(self, sync: CommentSync) -> None:
        """Mark one comment's sync row and its GitHub pointer deleted, to expire later.

        A tombstone rather than a delete, because a delete forgets the GitHub
        comment id and a redriven `created` would then import the comment again.
        """
        expires_at = int(utc_now().timestamp()) + TOMBSTONE_RETENTION_SECONDS
        tombstone = sync.model_copy(update={"state": "deleted", "body": "", "synced_at": utc_now()})
        self._repository.put(as_item(tombstone, expires_at=expires_at))
        if sync.github_comment_id:
            pointer = SyncPointer(
                workspace_id=sync.workspace_id,
                github_key=github_comment_key(sync.github_comment_id),
                target_id=sync.comment_id,
                issue_id=sync.issue_id,
            )
            self._repository.put(as_item(pointer, expires_at=expires_at))

    def save_comment_sync(self, sync: CommentSync) -> CommentSync:
        """Replace one comment's sync row and its GitHub pointer."""
        saved = sync.model_copy(update={"synced_at": utc_now()})
        self._repository.put(as_item(saved))
        if saved.github_comment_id:
            self._put_github_comment_pointer(saved)
        return saved

    def _put_github_comment_pointer(self, sync: CommentSync, *, condition: Any = None) -> None:
        """Point the GitHub comment at the comment it syncs with."""
        pointer = SyncPointer(
            workspace_id=sync.workspace_id,
            github_key=github_comment_key(sync.github_comment_id),
            target_id=sync.comment_id,
            issue_id=sync.issue_id,
        )
        self._repository.put(as_item(pointer), condition=condition)

    def _query(
        self, workspace_id: str, prefix: str, limit: int, *, consistent: bool = False
    ) -> list[Mapping[str, Any]]:
        """Every row of one workspace under a sort key prefix."""
        if not workspace_id or not prefix:
            return []
        return list(
            self._repository.iter_query(
                Key("workspace_id").eq(workspace_id) & Key("github_key").begins_with(prefix),
                max_items=limit,
                consistent=consistent,
            )
        )

    def _delete(self, workspace_id: str, github_key: str) -> bool:
        """Remove one row, reporting whether one was there."""
        key = {"workspace_id": workspace_id, "github_key": github_key}
        if self._repository.get(key) is None:
            return False
        self._repository.delete(key)
        return True
