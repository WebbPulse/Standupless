"""The GitHub reads and writes the release source makes: deployments, pull requests and Releases.

Kept apart from `github_issues`, which the issue sync shares, and built on its
request helper, so these calls address repositories by id, refuse redirects and
raise the same `GitHubError` subclasses. Every read is capped, because a
deployment is recorded inside one queue message.

Reading deployments and their statuses needs the App's Deployments read
permission, reading a commit's pull requests needs Pull requests read, and
publishing a Release needs Contents write.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Mapping
from urllib.parse import quote

import httpx
from webbpulse.integrations.github import GitHubError, GitHubNotFound

from app.domains.integrations.github_issues import _identifier, _is_sha, _object, _request, repository_path

DEPLOYMENT_PAGE_SIZE = 30

DEPLOYMENTS_SCANNED = 60
"""How many deployments one read looks through for successful ones, newest first."""

STATUS_PAGE_SIZE = 20

SUCCESS = "success"

RELEASE_BRANCH_PREFIXES = ("promote/", "promotion/", "release/", "releases/")

NAME_MAX = 120

TAG_MAX = 100

_PULL_SUFFIX = re.compile(r"\s*\(#\d+\)\s*$")

_TAG_UNSAFE = re.compile(r"[^A-Za-z0-9._/-]+")


@dataclass(frozen=True)
class PullRef:
    """One pull request as the release source reads it: its number, title, branch and link."""

    number: int
    title: str
    head_ref: str
    url: str | None


@dataclass(frozen=True)
class DeploymentRef:
    """One deployment of an environment: its id, the commit it deployed, and when."""

    deployment_id: int
    sha: str
    created_at: datetime | None


def _pull(body: Mapping[str, Any]) -> PullRef | None:
    """A pull request object read into its reference, or `None` when it has no number."""
    number = body.get("number")
    if not isinstance(number, int) or number <= 0:
        return None
    head = body.get("head")
    head_ref = str(head.get("ref") or "") if isinstance(head, Mapping) else ""
    url = body.get("html_url")
    return PullRef(
        number=number,
        title=str(body.get("title") or ""),
        head_ref=head_ref,
        url=url if isinstance(url, str) and url.startswith("https://") else None,
    )


def merged_pull_for_commit(
    token: str, repository_id: int | str, sha: str, *, client: httpx.Client | None = None
) -> PullRef | None:
    """The merged pull request whose merge commit is this sha, or `None` when it is no PR's merge."""
    if not _is_sha(sha):
        return None
    path = f"{repository_path(repository_id)}/commits/{sha}/pulls?per_page=10"
    body = _request("GET", path, token=token, client=client)
    if not isinstance(body, list):
        return None
    for entry in body:
        if not isinstance(entry, Mapping) or not entry.get("merged_at"):
            continue
        if str(entry.get("merge_commit_sha") or "").lower() != sha.lower():
            continue
        return _pull(entry)
    return None


def pull_request(
    token: str, repository_id: int | str, number: int, *, client: httpx.Client | None = None
) -> PullRef | None:
    """One pull request's title and branch by number, or `None` when GitHub has none."""
    path = f"{repository_path(repository_id)}/pulls/{_identifier(number, 'number')}"
    try:
        body = _object(_request("GET", path, token=token, client=client), "pull request")
    except GitHubNotFound:
        return None
    return _pull(body)


def _timestamp(value: Any) -> datetime | None:
    """A GitHub ISO timestamp, or `None` when it is absent or unreadable."""
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _succeeded(token: str, repository_id: int | str, deployment_id: int, *, client: httpx.Client | None) -> bool:
    """Whether any status of one deployment is a success, since an older one turns inactive later."""
    path = f"{repository_path(repository_id)}/deployments/{deployment_id}/statuses?per_page={STATUS_PAGE_SIZE}"
    body = _request("GET", path, token=token, client=client)
    if not isinstance(body, list):
        return False
    return any(isinstance(entry, Mapping) and entry.get("state") == SUCCESS for entry in body)


@dataclass(frozen=True)
class DeploymentPage:
    """Successful deployments found, whether more remain, and the list page the scan stopped on."""

    deployments: list[DeploymentRef]
    more: bool
    page: int


LIST_PAGES_MAX = 40
"""How many deployment list pages one scan reads at most, skipped ones included."""


def successful_deployments(
    token: str,
    repository_id: int | str,
    environment: str,
    *,
    before_id: int | None = None,
    exclude_sha: str | None = None,
    count: int,
    scan: int = DEPLOYMENTS_SCANNED,
    start_page: int = 1,
    client: httpx.Client | None = None,
) -> DeploymentPage:
    """Up to `count` successful deployments of one environment older than `before_id`, newest first.

    GitHub lists deployments newest first with no way to start before one, so a
    caller paging back through history passes the page it stopped on as a hint:
    a new deployment only pushes older ones to later pages, so starting there
    misses nothing. Deployments of `exclude_sha` are passed over, and at most
    `scan` deployments have their statuses read.
    """
    found: list[DeploymentRef] = []
    scanned = 0
    excluded = exclude_sha.lower() if exclude_sha else None
    base = f"{repository_path(repository_id)}/deployments?environment={quote(environment, safe='')}"
    first = max(1, start_page)
    for page in range(first, first + LIST_PAGES_MAX):
        body = _request("GET", f"{base}&per_page={DEPLOYMENT_PAGE_SIZE}&page={page}", token=token, client=client)
        if not isinstance(body, list):
            raise GitHubError("the deployments call answered no list")
        for entry in body:
            if not isinstance(entry, Mapping):
                continue
            deployment_id = entry.get("id")
            sha = str(entry.get("sha") or "").lower()
            if not isinstance(deployment_id, int) or not _is_sha(sha) or sha == excluded:
                continue
            if before_id is not None and deployment_id >= before_id:
                continue
            if len(found) >= count or scanned >= scan:
                return DeploymentPage(found, True, page)
            scanned += 1
            if _succeeded(token, repository_id, deployment_id, client=client):
                found.append(DeploymentRef(deployment_id, sha, _timestamp(entry.get("created_at"))))
        if len(body) < DEPLOYMENT_PAGE_SIZE:
            return DeploymentPage(found, False, page)
    return DeploymentPage(found, True, first + LIST_PAGES_MAX - 1)


SEED_SCANNED = 20
"""How many earlier deployments a first deployment looks back through for its range's start."""


def previous_successful_sha(
    token: str,
    repository_id: int | str,
    environment: str,
    sha: str,
    *,
    deployment_id: int | None = None,
    client: httpx.Client | None = None,
) -> str | None:
    """The commit the environment last deployed successfully before this deployment, or `None`.

    This seeds the range of the first deployment Standupless sees for a
    repository and stage, so its first release carries what that deployment
    shipped rather than only its head commit.
    """
    found = successful_deployments(
        token,
        repository_id,
        environment,
        before_id=deployment_id,
        exclude_sha=sha,
        count=1,
        scan=SEED_SCANNED,
        client=client,
    )
    return found.deployments[0].sha if found.deployments else None


def release_name(pull: PullRef) -> str:
    """A release's name from the pull request whose merge deployed it.

    A promotion or release branch names it by what follows its prefix, so
    `promote/2026-10-07-b` reads `2026-10-07-b`; any other pull request names it
    by its title.
    """
    for prefix in RELEASE_BRANCH_PREFIXES:
        if pull.head_ref.startswith(prefix) and pull.head_ref[len(prefix) :].strip("/"):
            return pull.head_ref[len(prefix) :].strip("/")[:NAME_MAX]
    title = _PULL_SUFFIX.sub("", pull.title).strip()
    return (title or f"#{pull.number}")[:NAME_MAX]


def tag_for(name: str) -> str:
    """A git tag made from a release name: unsafe characters to dashes, no empty or dotted ends."""
    tag = _TAG_UNSAFE.sub("-", name.strip())
    tag = re.sub(r"\.{2,}", ".", tag)
    tag = re.sub(r"/{2,}", "/", tag)
    tag = re.sub(r"-{2,}", "-", tag)
    tag = tag[:TAG_MAX].strip("./-")
    if tag.endswith(".lock"):
        tag = tag[: -len(".lock")].strip("./-")
    return tag or "release"


def publish_release(
    token: str,
    repository_id: int | str,
    *,
    tag: str,
    sha: str,
    name: str,
    body: str,
    prerelease: bool,
    client: httpx.Client | None = None,
) -> str | None:
    """Create the GitHub Release for this tag at this commit, or update its notes, returning its link.

    A Release that already holds the tag keeps its commit and has its name, notes
    and pre-release flag brought up to date, so publishing again is idempotent.
    """
    if not _is_sha(sha):
        raise ValueError("a release needs a commit sha")
    base = f"{repository_path(repository_id)}/releases"
    fields = {"name": name, "body": body, "prerelease": prerelease}
    try:
        existing = _object(_request("GET", f"{base}/tags/{quote(tag, safe='')}", token=token, client=client), "release")
    except GitHubNotFound:
        existing = None
    if existing is not None and isinstance(existing.get("id"), int):
        answer = _request("PATCH", f"{base}/{existing['id']}", token=token, json=fields, client=client)
    else:
        answer = _request(
            "POST", base, token=token, json={"tag_name": tag, "target_commitish": sha, **fields}, client=client
        )
    url = answer.get("html_url") if isinstance(answer, Mapping) else None
    return url if isinstance(url, str) and url.startswith("https://") else None
