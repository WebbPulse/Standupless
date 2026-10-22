"""Search beyond issue titles: status on issue hits, projects, initiatives and comments.

Every kind keeps the visibility its own read applies. A project shows through any
one of its teams, an initiative is hidden from guests, and a comment shows only
while its issue exists in a team the caller sees.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.comments import build_comment
from app.common.db.dynamo.planning import Initiative, Project, initiative_key, project_key
from app.common.db.dynamo.search_index import comment_doc, comment_terms
from app.domains.views.endpoints.search import snippet, text_matches
from tests.domains.helpers import GUEST, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import OTHER_TEAM, TEAM, seed_issue
from tests.domains.views.test_search import index_issue

PROJECT = "01JB000000000000000000PJT1"

OTHER_PROJECT = "01JB000000000000000000PJT2"

INITIATIVE = "01JB000000000000000000INI1"


def _search(client: TestClient, workspace: str, **params: Any) -> "dict[str, Any]":
    """One search, failing loudly on anything but a 200."""
    response = client.get(f"/api/workspaces/{workspace}/search", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def _project(repositories: Any, workspace: str, project_id: str, team_id: str, **fields: Any) -> None:
    """One project written straight into the planning table."""
    values: "dict[str, Any]" = {"name": "Unnamed", "created_by": OWNER}
    values.update(fields)
    repositories.planning.create_project(
        Project(
            workspace_id=workspace,
            planning_key=project_key(project_id),
            project_id=project_id,
            team_ids=[team_id],
            **values,
        )
    )


def _initiative(repositories: Any, workspace: str, **fields: Any) -> None:
    """One initiative written straight into the planning table."""
    values: "dict[str, Any]" = {"name": "Unnamed", "created_by": OWNER}
    values.update(fields)
    repositories.planning.create_initiative(
        Initiative(workspace_id=workspace, planning_key=initiative_key(INITIATIVE), initiative_id=INITIATIVE, **values)
    )


def _comment(repositories: Any, workspace: str, issue: "dict[str, Any]", body: str, team_id: str = TEAM) -> str:
    """Write one comment and post it the way the search consumer would, answering its id."""
    comment = repositories.comments.create(build_comment(workspace, issue["id"], team_id, OWNER, body))
    repositories.search_index.apply(
        workspace,
        team_id,
        comment_doc(comment.comment_id, issue["id"]),
        appeared=comment_terms({"body": body}),
        departed=set(),
    )
    return comment.comment_id


def test_an_issue_hit_carries_its_status_and_assignee(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A row draws its status icon and assignee from the hit alone."""
    sign_in(issues_client, OWNER)
    started = statuses["started"]
    issue = seed_issue(
        issues_client, workspace, title="Widget overhaul", status_id=started.status_id, assignee_id=OWNER
    )
    index_issue(repositories, workspace, TEAM, issue)

    sign_in(client, OWNER)
    hit = _search(client, workspace, q="widget")["results"][0]

    assert hit["status_id"] == started.status_id
    assert hit["status_name"] == started.name
    assert hit["status_category"] == "started"
    assert hit["status_color"] == started.color
    assert hit["assignee_id"] == OWNER


def test_a_status_filter_narrows_the_issue_hits(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Category and id filters keep only the issues in those statuses."""
    sign_in(issues_client, OWNER)
    done = seed_issue(issues_client, workspace, title="Widget shipped", status_id=statuses["completed"].status_id)
    open_one = seed_issue(issues_client, workspace, title="Widget pending", status_id=statuses["started"].status_id)
    index_issue(repositories, workspace, TEAM, done)
    index_issue(repositories, workspace, TEAM, open_one)

    sign_in(client, OWNER)
    by_category = _search(client, workspace, q="widget", status_category=["completed"])
    by_id = _search(client, workspace, q="widget", status_id=[statuses["started"].status_id])

    assert [row["issue_id"] for row in by_category["results"]] == [done["id"]]
    assert [row["issue_id"] for row in by_id["results"]] == [open_one["id"]]


def test_a_status_filter_applies_to_a_key_lookup(
    client: TestClient, issues_client: TestClient, workspace: str, statuses: Any
) -> None:
    """A key outside the filtered statuses answers nothing rather than ignoring the filter."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Anything", status_id=statuses["started"].status_id)

    sign_in(client, OWNER)

    assert _search(client, workspace, q=issue["key"], status_category=["completed"])["results"] == []
    assert len(_search(client, workspace, q=issue["key"], status_category=["started"])["results"]) == 1


def test_projects_match_on_name_and_description(client: TestClient, workspace: str, repositories: Any) -> None:
    """A name match ranks ahead of a description match, and a project matching neither is left out."""
    _project(repositories, workspace, PROJECT, TEAM, name="Quiet rollout", description="Ship the zephyr flag")
    _project(repositories, workspace, OTHER_PROJECT, TEAM, name="Zephyr launch")
    _project(repositories, workspace, "01JB000000000000000000PJT3", TEAM, name="Unrelated")

    sign_in(client, MEMBER)
    projects = _search(client, workspace, q="zephyr")["projects"]

    assert [row["project_id"] for row in projects] == [OTHER_PROJECT, PROJECT]
    assert projects[0]["team_ids"] == [TEAM]


def test_a_term_matches_inside_a_longer_project_name(client: TestClient, workspace: str, repositories: Any) -> None:
    """Projects are matched in memory, so a term finds the word it starts."""
    _project(repositories, workspace, PROJECT, TEAM, name="Onboarding revamp")

    sign_in(client, MEMBER)

    assert [row["project_id"] for row in _search(client, workspace, q="onboard")["projects"]] == [PROJECT]


def test_a_guest_sees_only_projects_on_their_teams(client: TestClient, workspace: str, repositories: Any) -> None:
    """A project shows through one of its teams, so a project on a team the guest is outside stays hidden."""
    _project(repositories, workspace, PROJECT, TEAM, name="Zephyr inside")
    _project(repositories, workspace, OTHER_PROJECT, OTHER_TEAM, name="Zephyr outside")

    sign_in(client, GUEST)

    assert [row["project_id"] for row in _search(client, workspace, q="zephyr")["projects"]] == [PROJECT]


def test_a_team_search_answers_that_teams_projects(client: TestClient, workspace: str, repositories: Any) -> None:
    """Narrowing to a team keeps the projects that team is on and drops the rest."""
    _project(repositories, workspace, PROJECT, TEAM, name="Zephyr one")
    _project(repositories, workspace, OTHER_PROJECT, OTHER_TEAM, name="Zephyr two")

    sign_in(client, OWNER)
    projects = _search(client, workspace, q="zephyr", team_id=OTHER_TEAM)["projects"]

    assert [row["project_id"] for row in projects] == [OTHER_PROJECT]


def test_initiatives_are_found_by_members_and_hidden_from_guests(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """Initiatives are not shown to guests anywhere, so search does not show them either."""
    _initiative(repositories, workspace, name="Expand", description="Open the zephyr market")

    sign_in(client, MEMBER)
    found = _search(client, workspace, q="zephyr")["initiatives"]
    sign_in(client, GUEST)
    hidden = _search(client, workspace, q="zephyr")["initiatives"]

    assert [row["initiative_id"] for row in found] == [INITIATIVE]
    assert hidden == []


def test_a_team_search_skips_initiatives(client: TestClient, workspace: str, repositories: Any) -> None:
    """An initiative belongs to no team, as a document does."""
    _initiative(repositories, workspace, name="Zephyr goals")

    sign_in(client, MEMBER)

    assert _search(client, workspace, q="zephyr", team_id=TEAM)["initiatives"] == []


def test_a_comment_match_links_to_the_comment(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A comment hit names its issue and carries an excerpt around the match."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Login fails")
    comment_id = _comment(repositories, workspace, issue, "Traced it to the zephyr cache expiring early")

    sign_in(client, MEMBER)
    comments = _search(client, workspace, q="zephyr cache")["comments"]

    assert len(comments) == 1
    hit = comments[0]
    assert hit["comment_id"] == comment_id
    assert hit["issue_id"] == issue["id"]
    assert hit["issue_key"] == issue["key"]
    assert hit["issue_title"] == "Login fails"
    assert "zephyr cache" in hit["snippet"]


def test_a_guest_does_not_find_comments_outside_their_teams(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The comment partitions read are the visible teams', and the issue is checked again."""
    sign_in(issues_client, OWNER)
    inside = seed_issue(issues_client, workspace, title="Inside")
    outside = seed_issue(issues_client, workspace, title="Outside", team_id=OTHER_TEAM)
    _comment(repositories, workspace, inside, "zephyr inside")
    _comment(repositories, workspace, outside, "zephyr outside", team_id=OTHER_TEAM)

    sign_in(client, GUEST)
    comments = _search(client, workspace, q="zephyr")["comments"]

    assert [row["issue_id"] for row in comments] == [inside["id"]]


def test_a_comment_whose_issue_is_gone_is_skipped(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A stale posting is skipped rather than answered."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Doomed")
    repositories.search_index.apply(
        workspace, TEAM, comment_doc("01JB0000000000000000COMNT1", issue["id"]), appeared={"c:zephyr"}, departed=set()
    )

    sign_in(client, MEMBER)

    assert _search(client, workspace, q="zephyr")["comments"] == []


def test_comment_terms_never_answer_an_issue_search(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Comment postings sit under their own prefix, so an issue search ignores them."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Plain title")
    _comment(repositories, workspace, issue, "zephyr")

    sign_in(client, MEMBER)
    found = _search(client, workspace, q="zephyr")

    assert found["results"] == []
    assert len(found["comments"]) == 1


def test_the_type_filter_answers_only_the_kinds_asked_for(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Asking for projects alone reads and answers nothing else."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Zephyr issue")
    index_issue(repositories, workspace, TEAM, issue)
    _comment(repositories, workspace, issue, "zephyr comment")
    _project(repositories, workspace, PROJECT, TEAM, name="Zephyr project")

    sign_in(client, MEMBER)
    only_projects = _search(client, workspace, q="zephyr", type=["projects"])
    both = _search(client, workspace, q="zephyr", type=["issues", "comments"])

    assert only_projects["results"] == []
    assert only_projects["comments"] == []
    assert [row["project_id"] for row in only_projects["projects"]] == [PROJECT]
    assert [row["issue_id"] for row in both["results"]] == [issue["id"]]
    assert len(both["comments"]) == 1
    assert both["projects"] == []


def test_an_unknown_type_is_refused(client: TestClient, workspace: str) -> None:
    """The kinds are a closed set, so a typo is a 422 rather than an empty answer."""
    sign_in(client, MEMBER)

    response = client.get(f"/api/workspaces/{workspace}/search", params={"q": "zephyr", "type": "cycles"})

    assert response.status_code == 422


def test_the_snippet_centres_on_the_first_match() -> None:
    """A long comment is cut around the match, with ellipses where text was dropped."""
    body = "word " * 40 + "the zephyr appears here " + "tail " * 60

    excerpt = snippet(body, {"zephyr"})

    assert "zephyr" in excerpt
    assert excerpt.startswith("... ")
    assert excerpt.endswith(" ...")


def test_a_short_comment_snippet_is_the_whole_body() -> None:
    """Nothing is dropped, so nothing is marked as dropped."""
    assert snippet("Fixed the\nzephyr  bug", {"zephyr"}) == "Fixed the zephyr bug"


def test_text_matches_needs_every_term() -> None:
    """Matching is an intersection, case folded, across the parts given."""
    assert text_matches({"zephyr", "flag"}, "Zephyr", "ship the FLAG")
    assert not text_matches({"zephyr", "flag"}, "Zephyr", None)
    assert not text_matches({"zephyr"})
