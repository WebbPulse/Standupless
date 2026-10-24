"""The tag and GitHub Release release sources, with GitHub's tag, Release and commit reads stood in for.

These hold that a pushed tag matching a pinned repository's pattern records a
release named after the repository and tag, carrying its version, its GitHub page
and the issues named since the previous matching tag, and moves the issues it
closes to the team's Done, or the configured status, or nowhere when moves are
off. A tag outside the pattern, a branch, a draft or a repository releasing from
deployments records nothing, and a deployment of a tag repository is ignored. A
published Release records under its own source, and a backfill walks the tags
newest first through a cursor without moving any issue, passing over a tag GitHub
will not read. A tag's commit is read through its full ref, so annotated and
lightweight tags both resolve.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import httpx
import pytest
from webbpulse.integrations.github import GitHubUnprocessable

from app.common.api.schemas.releases import ReleaseBackfill
from app.common.db.dynamo.github import RepositoryReleaseSource
from app.domains.integrations.deployments import backfill, handle_deployment_status
from app.domains.integrations.github_deployments import PublishedRelease, TagRef
from app.domains.integrations.tag_releases import (
    handle_create,
    handle_release,
    matches,
    resolve_release_source,
    version_key,
    version_of,
)
from tests.domains.integrations.conftest import (
    INSTALLATION_ID,
    REPOSITORY_FULL_NAME,
    REPOSITORY_ID,
    TEAM,
    WORKSPACE,
    seed_issue,
)

FIRST = "1" * 40

SECOND = "2" * 40

THIRD = "3" * 40

FIRST_ISSUE = "01JB0000000000000000000IS1"

SECOND_ISSUE = "01JB0000000000000000000IS3"


@dataclass
class FakeGitHub:
    """What the stood-in tag, Release and commit reads answer, and the ranges they were asked for."""

    messages: dict[str, str] = field(default_factory=dict)
    tags: list[TagRef] = field(default_factory=list)
    releases: list[PublishedRelease] = field(default_factory=list)
    compares: list[tuple[str, str]] = field(default_factory=list)
    dates: dict[str, int] = field(default_factory=dict)
    unreadable: set[str] = field(default_factory=set)


@pytest.fixture
def github(monkeypatch: pytest.MonkeyPatch) -> FakeGitHub:
    """Stand in for the installation token and every GitHub read a tag release takes."""
    from app.domains.integrations import github_deployments, github_issues

    state = FakeGitHub()

    def compare(token: str, repository_id: Any, base: str, head: str) -> list[tuple[str, str]]:
        """Every known commit after the base, in order."""
        state.compares.append((base, head))
        shas = list(state.messages)
        start = shas.index(base) + 1 if base in shas else 0
        return [(sha, state.messages[sha]) for sha in shas[start : shas.index(head) + 1]]

    def tag_commit(token: str, repository_id: Any, tag: str) -> tuple[str, datetime | None] | None:
        """The stood-in tag's commit, committed on the day of October `dates` names, else the first."""
        if tag in state.unreadable:
            raise GitHubUnprocessable(f"No commit found for SHA: tags/{tag}", status_code=422)
        sha = next((row.sha for row in state.tags if row.name == tag), None)
        return (sha, datetime(2026, 10, state.dates.get(tag, 1), tzinfo=timezone.utc)) if sha else None

    monkeypatch.setattr(github_issues, "installation_token", lambda installation_id: "token")
    monkeypatch.setattr(github_issues, "compare_commits", compare)
    monkeypatch.setattr(github_issues, "commit", lambda token, repo, sha: (sha, state.messages.get(sha, "")))
    monkeypatch.setattr(github_deployments, "merged_pull_for_commit", lambda token, repo, sha: None)
    monkeypatch.setattr(github_deployments, "pull_request", lambda token, repo, number: None)
    monkeypatch.setattr(github_deployments, "list_tags", lambda token, repo: list(state.tags))
    monkeypatch.setattr(github_deployments, "list_releases", lambda token, repo: list(state.releases))
    monkeypatch.setattr(github_deployments, "tag_commit", tag_commit)
    return state


def _source(repositories: Any, **fields: Any) -> None:
    """Pin the installed repository to the home team with this release source."""
    stored = repositories.github.get_repository(WORKSPACE, REPOSITORY_ID)
    source = RepositoryReleaseSource.model_validate({"kind": "tags", **fields})
    repositories.github.put_repository(stored.model_copy(update={"team_id": TEAM, "release_source": source}))


def _create(ref: str, ref_type: str = "tag") -> dict[str, Any]:
    """A `create` delivery as GitHub sends it, trimmed to what the source reads."""
    return {
        "ref": ref,
        "ref_type": ref_type,
        "repository": {"id": int(REPOSITORY_ID), "full_name": REPOSITORY_FULL_NAME},
        "installation": {"id": int(INSTALLATION_ID)},
    }


def _published(tag: str, *, draft: bool = False, action: str = "published") -> dict[str, Any]:
    """A `release` delivery as GitHub sends it, trimmed to what the source reads."""
    return {
        "action": action,
        "release": {
            "tag_name": tag,
            "draft": draft,
            "html_url": f"https://github.com/{REPOSITORY_FULL_NAME}/releases/tag/{tag}",
            "published_at": "2026-10-02T12:00:00Z",
        },
        "repository": {"id": int(REPOSITORY_ID), "full_name": REPOSITORY_FULL_NAME},
        "installation": {"id": int(INSTALLATION_ID)},
    }


def _releases(repositories: Any) -> list[Any]:
    """Every release of the home team, newest first."""
    return repositories.releases.list_for_team(WORKSPACE, TEAM, limit=50)[0]


def _statuses(repositories: Any) -> dict[str, Any]:
    """The home team's statuses by name."""
    return {row.name: row for row in repositories.team_config.list_statuses(WORKSPACE, TEAM)}


def _status_of(repositories: Any, issue_id: str) -> str:
    """The status id an issue now holds."""
    return repositories.issues.get(WORKSPACE, issue_id).status_id


def _two_tags(github: FakeGitHub) -> None:
    """Two version tags, the second fixing ABC-2 and only mentioning ABC-1."""
    github.messages = {FIRST: "Fixes ABC-1 (#1)", SECOND: "Fixes ABC-2 (#2)"}
    github.tags = [TagRef(name="v1.1.0", sha=SECOND), TagRef(name="v1.0.0", sha=FIRST)]


def test_versions_read_from_the_first_digit_and_sort_numerically() -> None:
    """A prefixed tag reads its version, and 1.10 sorts above 1.9 with a release above its pre-release."""
    assert version_of("python-v0.89.0") == "0.89.0"
    assert version_of("latest") == "latest"
    assert version_key("v1.10.0") > version_key("v1.9.0")
    assert version_key("v2.0.0") > version_key("v2.0.0-rc.1")
    source = RepositoryReleaseSource(kind="tags", tag_pattern="v*.*.*")
    assert matches(source, "v3.24.0")
    assert not matches(source, "v3")
    assert matches(RepositoryReleaseSource(kind="tags"), "anything")


def test_a_pushed_tag_records_a_release_of_the_issues_since_the_previous_tag(
    repositories: Any, installed: str, github: FakeGitHub
) -> None:
    """The release is named after the repository and tag, links the tag, and moves its issues to Done."""
    _source(repositories, tag_pattern="v*")
    seed_issue(repositories, WORKSPACE, TEAM, FIRST_ISSUE, "ABC", 1)
    second = seed_issue(repositories, WORKSPACE, TEAM, SECOND_ISSUE, "ABC", 2)
    _two_tags(github)

    handle_create(repositories, WORKSPACE, _create("v1.1.0"))

    [release] = _releases(repositories)
    assert release.name == "standupless v1.1.0"
    assert release.version == "1.1.0"
    assert release.source == "github_tag"
    assert release.url == f"https://github.com/{REPOSITORY_FULL_NAME}/releases/tag/v1.1.0"
    assert release.sha == SECOND
    assert release.previous_sha == FIRST
    assert release.issue_ids == [second.issue_id]
    assert github.compares == [(FIRST, SECOND)]
    assert _status_of(repositories, SECOND_ISSUE) == _statuses(repositories)["Done"].status_id


def test_a_configured_status_or_no_moves_is_honoured(repositories: Any, installed: str, github: FakeGitHub) -> None:
    """A release status set by name is where issues go, and move_issues false leaves them where they are."""
    seed_issue(repositories, WORKSPACE, TEAM, FIRST_ISSUE, "ABC", 1)
    seed_issue(repositories, WORKSPACE, TEAM, SECOND_ISSUE, "ABC", 2)
    _two_tags(github)
    statuses = _statuses(repositories)
    started = next(row for row in statuses.values() if row.category == "started")
    source = resolve_release_source(repositories, WORKSPACE, TEAM, kind="tags", status=started.name.upper())
    assert source.status_id == started.status_id
    _source(repositories, status_id=started.status_id)

    handle_create(repositories, WORKSPACE, _create("v1.1.0"))
    assert _status_of(repositories, SECOND_ISSUE) == started.status_id

    before = _status_of(repositories, FIRST_ISSUE)
    _source(repositories, move_issues=False)
    github.tags = [TagRef(name="v1.0.0", sha=FIRST)]
    handle_create(repositories, WORKSPACE, _create("v1.0.0"))
    assert _status_of(repositories, FIRST_ISSUE) == before
    assert len(_releases(repositories)) == 2


def test_a_release_source_refuses_an_unknown_status_and_an_unpinned_repository(
    repositories: Any, installed: str
) -> None:
    """A tag source needs a pinned team and a status that team has."""
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as unknown:
        resolve_release_source(repositories, WORKSPACE, TEAM, kind="tags", status="Nowhere")
    assert unknown.value.status_code == 422
    with pytest.raises(HTTPException) as unpinned:
        resolve_release_source(repositories, WORKSPACE, None, kind="tags")
    assert unpinned.value.status_code == 422
    assert resolve_release_source(repositories, WORKSPACE, None, kind="deployments").kind == "deployments"


@pytest.mark.parametrize(
    ("delivery", "fields"),
    [
        (_create("python-v1.1.0"), {"tag_pattern": "v*"}),
        (_create("v1.1.0", "branch"), {}),
        (_create("v1.1.0"), {"kind": "deployments"}),
        (_create("v1.1.0"), {"kind": "github_releases"}),
    ],
)
def test_a_tag_outside_the_source_records_nothing(
    repositories: Any, installed: str, github: FakeGitHub, delivery: dict[str, Any], fields: dict[str, Any]
) -> None:
    """A tag outside the pattern, a branch, or a repository whose source is not tags makes no release."""
    _source(repositories, **fields)
    _two_tags(github)

    handle_create(repositories, WORKSPACE, delivery)

    assert _releases(repositories) == []


def test_a_published_release_records_under_its_own_source(
    repositories: Any, installed: str, github: FakeGitHub
) -> None:
    """A Release's page is the link, and the previous published Release starts the range; drafts are ignored."""
    _source(repositories, kind="github_releases")
    seed_issue(repositories, WORKSPACE, TEAM, FIRST_ISSUE, "ABC", 1)
    second = seed_issue(repositories, WORKSPACE, TEAM, SECOND_ISSUE, "ABC", 2)
    _two_tags(github)
    github.releases = [
        PublishedRelease(tag="v1.0.0", url=None, published_at=None),
        PublishedRelease(tag="v1.1.0", url=None, published_at=None),
    ]

    handle_release(repositories, WORKSPACE, _published("v1.1.0", draft=True))
    handle_release(repositories, WORKSPACE, _published("v1.1.0", action="edited"))
    assert _releases(repositories) == []

    handle_release(repositories, WORKSPACE, _published("v1.1.0"))

    [release] = _releases(repositories)
    assert release.source == "github_release"
    assert release.url == f"https://github.com/{REPOSITORY_FULL_NAME}/releases/tag/v1.1.0"
    assert release.previous_sha == FIRST
    assert release.issue_ids == [second.issue_id]


def test_a_tag_repository_ignores_its_deployments(repositories: Any, installed: str, github: FakeGitHub) -> None:
    """A repository releasing from tags records nothing from a successful deployment."""
    _source(repositories)
    github.messages = {FIRST: "ABC-1"}

    handle_deployment_status(
        repositories,
        WORKSPACE,
        {
            "action": "created",
            "deployment_status": {"state": "success", "environment": "production"},
            "deployment": {"sha": FIRST, "environment": "production"},
            "repository": {"id": int(REPOSITORY_ID), "full_name": REPOSITORY_FULL_NAME},
            "installation": {"id": int(INSTALLATION_ID)},
        },
    )

    assert _releases(repositories) == []


def test_a_backfill_walks_the_tags_newest_first_without_moving_issues(
    repositories: Any, installed: str, github: FakeGitHub
) -> None:
    """Each page records the next tags through a cursor, each from its previous tag, and no issue moves."""
    _source(repositories, tag_pattern="v*")
    seed_issue(repositories, WORKSPACE, TEAM, FIRST_ISSUE, "ABC", 1)
    seed_issue(repositories, WORKSPACE, TEAM, SECOND_ISSUE, "ABC", 2)
    github.messages = {FIRST: "ABC-1", SECOND: "ABC-2", THIRD: "Bump"}
    github.tags = [
        TagRef(name="v1.0.0", sha=FIRST),
        TagRef(name="v1.10.0", sha=THIRD),
        TagRef(name="v1.9.0", sha=SECOND),
        TagRef(name="python-v9.0.0", sha=THIRD),
    ]
    github.dates = {"v1.0.0": 3, "v1.9.0": 5, "v1.10.0": 7}
    before = {issue: _status_of(repositories, issue) for issue in (FIRST_ISSUE, SECOND_ISSUE)}

    page = backfill(repositories, WORKSPACE, TEAM, ReleaseBackfill(limit=2))
    assert page.source == "github_tag"
    assert page.releases_created == 2
    assert page.next_cursor == f"tag:{REPOSITORY_ID}:v1.9.0"
    rest = backfill(repositories, WORKSPACE, TEAM, ReleaseBackfill(limit=2, cursor=page.next_cursor))
    assert rest.releases_created == 1
    assert rest.next_cursor is None

    newest, middle, oldest = _releases(repositories)
    assert [newest.name, middle.name, oldest.name] == [
        "standupless v1.10.0",
        "standupless v1.9.0",
        "standupless v1.0.0",
    ]
    assert middle.previous_sha == FIRST
    assert oldest.previous_sha is None
    assert {issue: _status_of(repositories, issue) for issue in before} == before

    again = backfill(repositories, WORKSPACE, TEAM, ReleaseBackfill(limit=5))
    assert again.releases_created == 0
    assert again.deployments_skipped == 3


def test_a_backfill_passes_over_a_tag_github_will_not_read(
    repositories: Any, installed: str, github: FakeGitHub
) -> None:
    """An unreadable tag is named in unreadable_tags, the tags around it are recorded, and the cursor moves past it."""
    _source(repositories, tag_pattern="v*")
    github.messages = {FIRST: "ABC-1", SECOND: "ABC-2", THIRD: "Bump"}
    github.tags = [
        TagRef(name="v1.2.0", sha=THIRD),
        TagRef(name="v1.1.0", sha=SECOND),
        TagRef(name="v1.0.0", sha=FIRST),
    ]
    github.unreadable = {"v1.1.0"}

    page = backfill(repositories, WORKSPACE, TEAM, ReleaseBackfill(limit=2))
    assert page.releases_created == 1
    assert page.unreadable_tags == ["v1.1.0"]
    assert page.deployments_scanned == 2
    assert page.next_cursor == f"tag:{REPOSITORY_ID}:v1.1.0"

    rest = backfill(repositories, WORKSPACE, TEAM, ReleaseBackfill(limit=2, cursor=page.next_cursor))
    assert rest.releases_created == 1
    assert rest.unreadable_tags == []
    assert rest.next_cursor is None
    assert {row.name for row in _releases(repositories)} == {"standupless v1.2.0", "standupless v1.0.0"}


def test_a_tag_commit_reads_annotated_and_lightweight_tags_through_the_full_ref() -> None:
    """The full `refs/tags/` ref peels an annotated tag to its commit, where the bare `tags/` form answers 422."""
    from app.domains.integrations import github_deployments

    annotated = {"v2.0.0": SECOND}
    lightweight = {"v1.0.0": FIRST}
    paths: list[str] = []

    def answer(request: httpx.Request) -> httpx.Response:
        """GitHub's commit read: the full ref resolves every tag, the bare form only a lightweight one."""
        path = request.url.path
        paths.append(path)
        base = f"/repositories/{REPOSITORY_ID}/commits/"
        name = path.rsplit("/", 1)[-1]
        if path.startswith(f"{base}refs/tags/") or (path.startswith(f"{base}tags/") and name in lightweight):
            sha = annotated.get(name) or lightweight.get(name)
            if sha:
                return httpx.Response(200, json={"sha": sha, "commit": {"committer": {"date": "2026-10-03T00:00:00Z"}}})
            return httpx.Response(404, json={"message": "Not Found"})
        return httpx.Response(422, json={"message": f"No commit found for SHA: tags/{name}"})

    with httpx.Client(transport=httpx.MockTransport(answer)) as http:
        annotated_sha, annotated_at = github_deployments.tag_commit("ghs_test", REPOSITORY_ID, "v2.0.0", client=http)
        light_sha, light_at = github_deployments.tag_commit("ghs_test", REPOSITORY_ID, "v1.0.0", client=http)

    assert (annotated_sha, light_sha) == (SECOND, FIRST)
    assert annotated_at == light_at == datetime(2026, 10, 3, tzinfo=timezone.utc)
    assert paths == [
        f"/repositories/{REPOSITORY_ID}/commits/refs/tags/v2.0.0",
        f"/repositories/{REPOSITORY_ID}/commits/refs/tags/v1.0.0",
    ]


def test_the_repositories_route_sets_the_release_source_and_keeps_the_team(
    client: Any, repositories: Any, installed: str
) -> None:
    """A body with only release_source keeps the pin, a tag source needs one, and the read answers it."""
    from tests.domains.helpers import ADMIN, sign_in

    path = f"/api/workspaces/{WORKSPACE}/github/repositories/{REPOSITORY_ID}"
    sign_in(client, ADMIN)
    unpinned = client.patch(path, json={"release_source": {"kind": "tags"}})
    assert unpinned.status_code == 422, unpinned.text

    assert client.patch(path, json={"team_id": TEAM}).status_code == 200
    changed = client.patch(
        path, json={"release_source": {"kind": "tags", "tag_pattern": "v*", "status": "done", "move_issues": True}}
    )

    assert changed.status_code == 200, changed.text
    body = changed.json()
    assert body["team_id"] == TEAM
    assert body["release_source"] == {
        "kind": "tags",
        "tag_pattern": "v*",
        "status_id": _statuses(repositories)["Done"].status_id,
        "move_issues": True,
    }
    cleared = client.patch(path, json={"release_source": {"kind": "deployments", "tag_pattern": "v*"}})
    assert cleared.json()["release_source"]["tag_pattern"] is None


def test_a_tag_leaves_an_issue_a_commit_body_only_mentions(
    repositories: Any, installed: str, github: FakeGitHub
) -> None:
    """A tag ships the key in its commit's subject and never moves one the body mentions in prose."""
    _source(repositories, tag_pattern="v*")
    mentioned = seed_issue(repositories, WORKSPACE, TEAM, FIRST_ISSUE, "ABC", 1)
    second = seed_issue(repositories, WORKSPACE, TEAM, SECOND_ISSUE, "ABC", 2)
    github.messages = {
        FIRST: "Initial (#1)",
        SECOND: "ABC-2: Cap entries (#2)\n\nThe API lowered the cap in ABC-1 so it fits.",
    }
    github.tags = [TagRef(name="v1.1.0", sha=SECOND), TagRef(name="v1.0.0", sha=FIRST)]

    handle_create(repositories, WORKSPACE, _create("v1.1.0"))

    [release] = _releases(repositories)
    assert release.issue_ids == [second.issue_id]
    assert _status_of(repositories, SECOND_ISSUE) == _statuses(repositories)["Done"].status_id
    assert _status_of(repositories, FIRST_ISSUE) == mentioned.status_id
