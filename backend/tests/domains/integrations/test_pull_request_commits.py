"""Reading a pull request's commit messages from GitHub, across pages and past the 250 cap."""

from __future__ import annotations

import httpx

from app.domains.integrations import github_issues
from tests.domains.integrations.conftest import REPOSITORY_ID

BASE_SHA = "a" * 40
HEAD_SHA = "b" * 40


def commits(count: int, start: int = 0) -> list[dict[str, object]]:
    """A page of commit objects in GitHub's shape."""
    return [{"sha": f"{index:040x}", "commit": {"message": f"change {index}"}} for index in range(start, start + count)]


def test_a_short_pull_request_is_read_from_its_commit_list() -> None:
    """Pages are read until a short one, and the compare is never asked for."""
    paths: list[str] = []

    def answer(request: httpx.Request) -> httpx.Response:
        """A full first page, then a short second one."""
        paths.append(request.url.path)
        page = int(request.url.params["page"])
        return httpx.Response(200, json=commits(100 if page == 1 else 20, (page - 1) * 100))

    with httpx.Client(transport=httpx.MockTransport(answer)) as http:
        messages = github_issues.pull_request_commit_messages(
            "ghs_test", REPOSITORY_ID, 7, base_sha=BASE_SHA, head_sha=HEAD_SHA, client=http
        )

    assert len(messages) == 120
    assert messages[0] == "change 0"
    assert paths == [f"/repositories/{REPOSITORY_ID}/pulls/7/commits"] * 2


def test_a_pull_request_past_the_cap_is_read_through_a_compare() -> None:
    """At 250 commits the list stops, so the compare pages carry the rest."""
    compare_pages: list[str] = []

    def answer(request: httpx.Request) -> httpx.Response:
        """The pull request list capped at 250, then a 320 commit compare."""
        page = int(request.url.params["page"])
        if "/compare/" in request.url.path:
            compare_pages.append(str(page))
            assert request.url.path.endswith(f"/compare/{BASE_SHA}...{HEAD_SHA}")
            size = 100 if page <= 3 else 20
            return httpx.Response(200, json={"commits": commits(size, (page - 1) * 100)})
        size = {1: 100, 2: 100, 3: 50}.get(page, 0)
        return httpx.Response(200, json=commits(size, (page - 1) * 100))

    with httpx.Client(transport=httpx.MockTransport(answer)) as http:
        messages = github_issues.pull_request_commit_messages(
            "ghs_test", REPOSITORY_ID, 7, base_sha=BASE_SHA, head_sha=HEAD_SHA, client=http
        )

    assert len(messages) == 320
    assert messages[-1] == "change 319"
    assert compare_pages == ["1", "2", "3", "4"]


def test_a_capped_list_without_shas_is_kept_as_read() -> None:
    """With no usable base and head the compare is skipped rather than guessed at."""

    def answer(request: httpx.Request) -> httpx.Response:
        """A pull request list capped at 250."""
        assert "/compare/" not in request.url.path
        page = int(request.url.params["page"])
        return httpx.Response(200, json=commits({1: 100, 2: 100, 3: 50}.get(page, 0)))

    with httpx.Client(transport=httpx.MockTransport(answer)) as http:
        messages = github_issues.pull_request_commit_messages(
            "ghs_test", REPOSITORY_ID, 7, base_sha="main", head_sha="", client=http
        )

    assert len(messages) == 250
