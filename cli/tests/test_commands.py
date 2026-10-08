"""Commands end to end against a mocked API: what they send and what they print."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import parse_qs

import httpx
import pytest
import respx
from typer.testing import CliRunner

from standupless_cli.config import load_config
from tests.conftest import BASE, TEAM, WORKSPACE, WS, MemoryKeyring, invoke, make_issue

pytestmark = pytest.mark.usefixtures("logged_in")


def _query(route: respx.Route) -> dict[str, list[str]]:
    """The last request's query string as a multi-dict."""
    return parse_qs(route.calls.last.request.url.query.decode())


def _json(route: respx.Route) -> Any:
    """The last request's JSON body."""
    return json.loads(route.calls.last.request.content)


def test_issue_list_defaults_to_open_issues(runner: CliRunner, api: respx.MockRouter) -> None:
    """No status filter means open categories only, and the table resolves names."""
    route = api.get(f"/api/workspaces/{WS}/issues").respond(json={"issues": [make_issue()]})
    result = invoke(runner, "issue", "list")
    assert result.exit_code == 0, result.output
    query = _query(route)
    assert query["status_category"] == ["backlog", "unstarted", "started"]
    assert route.calls.last.request.headers["authorization"] == "Bearer wpk_test"
    assert "ENG-12" in result.stdout
    assert "Todo" in result.stdout
    assert "Ada" in result.stdout
    assert "High" in result.stdout


def test_issue_list_filters_resolve_names(runner: CliRunner, api: respx.MockRouter) -> None:
    """Team, assignee, status, label, priority and search become the API's params."""
    route = api.get(f"/api/workspaces/{WS}/issues").respond(json={"issues": []})
    result = invoke(
        runner,
        "issue",
        "list",
        "-t",
        "eng",
        "-a",
        "me",
        "-s",
        "in progress",
        "-s",
        "done",
        "-s",
        "cancelled",
        "-l",
        "bug",
        "--priority",
        "urgent",
        "-q",
        "login",
        "-L",
        "5",
    )
    assert result.exit_code == 0, result.output
    query = _query(route)
    assert query["team_id"] == ["team-1"]
    assert query["assignee_id"] == ["me"]
    assert query["status_id"] == ["st-doing", "st-done"]
    assert query["status_category"] == ["cancelled"]
    assert query["label_id"] == ["lb-bug"]
    assert query["priority"] == ["urgent"]
    assert query["q"] == ["login"]
    assert query["limit"] == ["5"]
    assert "No issues match." in result.stderr


def test_issue_list_filters_on_estimate(runner: CliRunner, api: respx.MockRouter) -> None:
    """`--estimate` repeats as any-of and `--estimate-not none` leaves out unestimated issues."""
    route = api.get(f"/api/workspaces/{WS}/issues").respond(json={"issues": []})
    result = invoke(runner, "issue", "list", "-e", "M", "--estimate", "none", "--estimate-not", "XL")
    assert result.exit_code == 0, result.output
    query = _query(route)
    assert query["estimate"] == ["M", "none"]
    assert query["estimate_not"] == ["XL"]


def test_issue_list_cycle_current_and_project(runner: CliRunner, api: respx.MockRouter) -> None:
    """`--cycle current` finds the active cycle and `--project` resolves by name."""
    api.get(f"/api/workspaces/{WS}/cycles", params={"status": "active"}).respond(
        json={"cycles": [{"cycle_id": "cy-7", "name": "Cycle 7", "team_id": "team-1"}]}
    )
    api.get(f"/api/workspaces/{WS}/projects").respond(
        json={"projects": [{"project_id": "pr-1", "name": "Launch", "status": "planned"}]}
    )
    route = api.get(f"/api/workspaces/{WS}/issues").respond(json={"issues": []})
    result = invoke(runner, "issue", "list", "--cycle", "current", "--project", "launch", "--all")
    assert result.exit_code == 0, result.output
    query = _query(route)
    assert query["cycle_id"] == ["cy-7"]
    assert query["project_id"] == ["pr-1"]
    assert "status_category" not in query


def test_issue_list_follows_cursors_up_to_the_limit(runner: CliRunner, api: respx.MockRouter) -> None:
    """Pages are followed until `--limit` issues are in hand."""
    route = api.get(f"/api/workspaces/{WS}/issues").mock(
        side_effect=[
            httpx.Response(200, json={"issues": [make_issue(key="ENG-1")], "next_cursor": "c2"}),
            httpx.Response(200, json={"issues": [make_issue(key="ENG-2"), make_issue(key="ENG-3")]}),
        ]
    )
    result = invoke(runner, "issue", "list", "--json", "-L", "2")
    assert result.exit_code == 0, result.output
    assert [issue["key"] for issue in json.loads(result.stdout)] == ["ENG-1", "ENG-2"]
    assert _query(route)["cursor"] == ["c2"]


def test_issue_view_json_and_comments(runner: CliRunner, api: respx.MockRouter) -> None:
    """`--json` prints the API's issue, with comments when asked."""
    api.get(f"/api/workspaces/{WS}/issues/by-key/ENG-12").respond(json=make_issue())
    api.get(f"/api/workspaces/{WS}/issues/is-12/comments").respond(
        json={"comments": [{"comment_id": "c1", "body": "Looks good", "author": {"user_id": "u-me"}}]}
    )
    result = invoke(runner, "issue", "view", "eng-12", "--comments", "--json")
    assert result.exit_code == 0, result.output
    data = json.loads(result.stdout)
    assert data["key"] == "ENG-12"
    assert data["comments"][0]["body"] == "Looks good"


def test_issue_view_labels_comments_made_through_a_client(runner: CliRunner, api: respx.MockRouter) -> None:
    """A comment made over MCP says so, and a web comment carries no label."""
    api.get(f"/api/workspaces/{WS}/issues/by-key/ENG-12").respond(json=make_issue())
    api.get(f"/api/workspaces/{WS}/issues/is-12/comments").respond(
        json={
            "comments": [
                {"comment_id": "c1", "body": "From an agent", "author": {"display_name": "Ada"}, "source": "mcp"},
                {"comment_id": "c2", "body": "From the page", "author": {"display_name": "Bo"}, "source": "web"},
            ]
        }
    )
    result = invoke(runner, "issue", "view", "ENG-12", "--comments")
    assert result.exit_code == 0, result.output
    assert result.stdout.count("via MCP") == 1
    assert "via Web" not in result.stdout


def test_issue_view_renders_fields(runner: CliRunner, api: respx.MockRouter) -> None:
    """The human view shows status, assignee, labels, body and the web link."""
    api.get(f"/api/workspaces/{WS}/issues/by-key/ENG-12").respond(json=make_issue())
    result = invoke(runner, "issue", "view", "ENG-12")
    assert result.exit_code == 0, result.output
    for text in (
        "Fix the login page",
        "Todo",
        "Ada",
        "Bug",
        "Steps to reproduce.",
        "https://web.test/w/acme/issues/ENG-12",
    ):
        assert text in result.stdout


def test_issue_view_web_opens_the_browser(
    runner: CliRunner, api: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`--web` opens the issue page without fetching the issue."""
    opened: list[str] = []
    monkeypatch.setattr("webbrowser.open", lambda url: opened.append(url))
    result = invoke(runner, "issue", "view", "ENG-12", "--web")
    assert result.exit_code == 0, result.output
    assert opened == ["https://web.test/w/acme/issues/ENG-12"]


def test_issue_create_resolves_fields(runner: CliRunner, api: respx.MockRouter) -> None:
    """Create sends ids for the names it was given and prints the new key and link."""
    route = api.post(f"/api/workspaces/{WS}/issues").respond(json=make_issue(key="ENG-13"))
    result = invoke(
        runner,
        "issue",
        "create",
        "--title",
        "New thing",
        "-b",
        "Details",
        "-a",
        "ada@example.com",
        "-s",
        "backlog",
        "-l",
        "UI",
        "--priority",
        "low",
        "--estimate",
        "3",
        "--due",
        "2026-10-01",
    )
    assert result.exit_code == 0, result.output
    assert _json(route) == {
        "team_id": "team-1",
        "title": "New thing",
        "body": "Details",
        "assignee_id": "u-ada",
        "status_id": "st-backlog",
        "label_ids": ["lb-ui"],
        "priority": "low",
        "estimate": "3",
        "due_date": "2026-10-01",
    }
    assert "Created ENG-13" in result.stderr
    assert result.stdout.strip() == "https://web.test/w/acme/issues/ENG-13"


def test_issue_create_sends_me_for_the_server_to_resolve(runner: CliRunner, api: respx.MockRouter) -> None:
    """`me` goes to the server as is, in one create call with no lookup."""
    create = api.post(f"/api/workspaces/{WS}/issues").respond(json=make_issue(key="ENG-1", assignee_id="u-me"))
    result = invoke(runner, "issue", "create", "--title", "First", "-a", "me", "--json")
    assert result.exit_code == 0, result.output
    assert _json(create)["assignee_id"] == "me"
    assert json.loads(result.stdout)["assignee_id"] == "u-me"


def test_issue_edit_sends_me_for_the_server_to_resolve(runner: CliRunner, api: respx.MockRouter) -> None:
    """An edit to `me` patches with `me` rather than looking the user up."""
    api.get(f"/api/workspaces/{WS}/issues/by-key/ENG-12").respond(json=make_issue())
    route = api.patch(f"/api/workspaces/{WS}/issues/is-12").respond(json=make_issue(assignee_id="u-me"))
    result = invoke(runner, "issue", "edit", "ENG-12", "-a", "me")
    assert result.exit_code == 0, result.output
    assert _json(route) == {"assignee_id": "me"}


def test_issue_edit_patches_only_what_was_given(runner: CliRunner, api: respx.MockRouter) -> None:
    """Labels add and remove against the current set; unset options are left out."""
    api.get(f"/api/workspaces/{WS}/issues/by-key/ENG-12").respond(json=make_issue())
    route = api.patch(f"/api/workspaces/{WS}/issues/is-12").respond(json=make_issue())
    result = invoke(
        runner, "issue", "edit", "ENG-12", "--add-label", "UI", "--remove-label", "bug", "-a", "none", "--due", "none"
    )
    assert result.exit_code == 0, result.output
    assert _json(route) == {"label_ids": ["lb-ui"], "assignee_id": None, "due_date": None}


def test_issue_edit_with_nothing_to_change_fails(runner: CliRunner, api: respx.MockRouter) -> None:
    """An edit with no options is a usage error, not an empty patch."""
    api.get(f"/api/workspaces/{WS}/issues/by-key/ENG-12").respond(json=make_issue())
    result = invoke(runner, "issue", "edit", "ENG-12")
    assert result.exit_code == 1
    assert "Nothing to change" in result.stderr


@pytest.mark.parametrize(("reason", "status_id"), [("completed", "st-done"), ("canceled", "st-cancel")])
def test_issue_close(runner: CliRunner, api: respx.MockRouter, reason: str, status_id: str) -> None:
    """Close moves to the first status of the matching category and can comment."""
    api.get(f"/api/workspaces/{WS}/issues/by-key/ENG-12").respond(json=make_issue())
    route = api.patch(f"/api/workspaces/{WS}/issues/is-12").respond(json=make_issue(status_id=status_id))
    comment = api.post(f"/api/workspaces/{WS}/issues/is-12/comments").respond(json={"comment_id": "c"})
    result = invoke(runner, "issue", "close", "ENG-12", "--reason", reason, "-m", "Shipped")
    assert result.exit_code == 0, result.output
    assert _json(route) == {"status_id": status_id}
    assert _json(comment) == {"body": "Shipped"}


def test_issue_reopen(runner: CliRunner, api: respx.MockRouter) -> None:
    """Reopen moves to the first unstarted status."""
    api.get(f"/api/workspaces/{WS}/issues/by-key/ENG-12").respond(json=make_issue(status_id="st-done"))
    route = api.patch(f"/api/workspaces/{WS}/issues/is-12").respond(json=make_issue())
    result = invoke(runner, "issue", "reopen", "ENG-12")
    assert result.exit_code == 0, result.output
    assert _json(route) == {"status_id": "st-todo"}
    assert "Reopened ENG-12 as Todo" in result.stderr


def test_issue_move_resolves_the_team_and_reports_the_new_key(runner: CliRunner, api: respx.MockRouter) -> None:
    """`--team` takes a key prefix, and the success line names the old and new keys."""
    ops = {"id": "team-2", "name": "Operations", "key_prefix": "OPS"}
    api.get(f"/api/workspaces/{WS}/teams").respond(json={"teams": [TEAM, ops]})
    api.get(f"/api/workspaces/{WS}/issues/by-key/ENG-12").respond(json=make_issue())
    route = api.post(f"/api/workspaces/{WS}/issues/is-12/move").respond(
        json=make_issue(key="OPS-3", team_id="team-2", number=3)
    )
    result = invoke(runner, "issue", "move", "ENG-12", "--team", "ops")
    assert result.exit_code == 0, result.output
    assert _json(route) == {"team_id": "team-2"}
    assert "Moved ENG-12 to Operations as OPS-3" in result.stderr


def test_issue_comment_from_stdin(runner: CliRunner, api: respx.MockRouter) -> None:
    """`--body-file -` reads the comment from stdin."""
    api.get(f"/api/workspaces/{WS}/issues/by-key/ENG-12").respond(json=make_issue())
    route = api.post(f"/api/workspaces/{WS}/issues/is-12/comments").respond(json={"comment_id": "c"})
    result = invoke(runner, "issue", "comment", "ENG-12", "-F", "-", input="From a pipe\n")
    assert result.exit_code == 0, result.output
    assert _json(route) == {"body": "From a pipe\n"}


def test_issue_branch(runner: CliRunner, api: respx.MockRouter) -> None:
    """The branch name is the only thing on stdout, so it can feed `git switch -c`."""
    api.get(f"/api/workspaces/{WS}/issues/by-key/ENG-12").respond(json=make_issue())
    result = invoke(runner, "issue", "branch", "ENG-12")
    assert result.exit_code == 0, result.output
    assert result.stdout == "eng-12-fix-the-login-page\n"


def test_bad_issue_key_is_a_clean_error(runner: CliRunner, api: respx.MockRouter) -> None:
    """A malformed key fails before any request, with a message and no traceback."""
    result = invoke(runner, "issue", "view", "login-page")
    assert result.exit_code == 1
    assert "not an issue key" in result.stderr


def test_api_errors_show_the_envelope_message(runner: CliRunner, api: respx.MockRouter) -> None:
    """The server's message and code reach the user."""
    api.get(f"/api/workspaces/{WS}/issues/by-key/ENG-99").respond(
        404, json={"success": False, "status": 404, "message": "Issue not found", "error_code": "not_found"}
    )
    result = invoke(runner, "issue", "view", "ENG-99")
    assert result.exit_code == 1
    assert "Issue not found (HTTP 404 not_found)" in result.stderr


def test_team_list(runner: CliRunner, api: respx.MockRouter) -> None:
    """Teams list with their key prefix."""
    result = invoke(runner, "team", "list")
    assert result.exit_code == 0, result.output
    assert "ENG" in result.stdout
    assert "Engineering" in result.stdout


def test_team_update_turns_pull_request_label_sync_off(runner: CliRunner, api: respx.MockRouter) -> None:
    """The flag patches the team and the reply names the new state."""
    patched = api.patch(f"/api/workspaces/{WS}/teams/team-1").respond(
        json={"id": "team-1", "key_prefix": "ENG", "name": "Engineering", "sync_pr_labels": False}
    )
    result = invoke(runner, "team", "update", "-t", "ENG", "--no-sync-pr-labels")
    assert result.exit_code == 0, result.output
    assert json.loads(patched.calls[0].request.content) == {"sync_pr_labels": False}
    assert "off for ENG" in result.output


SYNC = {
    "team_id": "team-1",
    "repository_id": "42",
    "full_name": "acme/site",
    "direction": "github_to_standupless",
    "enabled": True,
    "sync_labels": True,
    "allow_public_two_way": False,
    "repository_private": False,
    "created_by": "u",
    "created_at": "2026-10-01T00:00:00Z",
    "updated_at": "2026-10-01T00:00:00Z",
}


def test_team_sync_shows_the_link(runner: CliRunner, api: respx.MockRouter) -> None:
    """With no change named the link is read and described."""
    api.get(f"/api/workspaces/{WS}/teams/team-1/github-sync").respond(json=SYNC)
    result = invoke(runner, "team", "sync", "-t", "ENG")
    assert result.exit_code == 0, result.output
    assert "GitHub to Standupless only with acme/site (public)" in result.output


def test_team_sync_says_when_there_is_no_link(runner: CliRunner, api: respx.MockRouter) -> None:
    """A 404 reads as not synced rather than an error."""
    api.get(f"/api/workspaces/{WS}/teams/team-1/github-sync").respond(404, json={"message": "Not found"})
    result = invoke(runner, "team", "sync", "-t", "ENG")
    assert result.exit_code == 0, result.output
    assert "does not sync" in result.output


def test_team_sync_allows_two_way_on_a_public_repository(runner: CliRunner, api: respx.MockRouter) -> None:
    """The flags merge over the stored link, and the reply warns the issues are public."""
    api.get(f"/api/workspaces/{WS}/teams/team-1/github-sync").respond(json=SYNC)
    saved = {**SYNC, "direction": "two_way", "allow_public_two_way": True}
    put = api.put(f"/api/workspaces/{WS}/teams/team-1/github-sync").respond(json=saved)
    result = invoke(runner, "team", "sync", "-t", "ENG", "-d", "two_way", "--allow-public-two-way")
    assert result.exit_code == 0, result.output
    assert json.loads(put.calls[0].request.content) == {
        "repository_id": "42",
        "direction": "two_way",
        "enabled": True,
        "sync_labels": True,
        "allow_public_two_way": True,
    }
    assert "anyone can read them" in result.output


def test_team_sync_needs_a_repository_to_start(runner: CliRunner, api: respx.MockRouter) -> None:
    """A team with no link cannot be changed without naming a repository."""
    api.get(f"/api/workspaces/{WS}/teams/team-1/github-sync").respond(404, json={"message": "Not found"})
    result = invoke(runner, "team", "sync", "-t", "ENG", "--pause")
    assert result.exit_code != 0


def test_team_update_makes_a_team_private(runner: CliRunner, api: respx.MockRouter) -> None:
    """`--private` patches only the privacy flag and the reply says the team is private."""
    patched = api.patch(f"/api/workspaces/{WS}/teams/team-1").respond(
        json={"id": "team-1", "key_prefix": "ENG", "name": "Engineering", "private": True}
    )
    result = invoke(runner, "team", "update", "-t", "ENG", "--private")
    assert result.exit_code == 0, result.output
    assert json.loads(patched.calls[0].request.content) == {"private": True}
    assert "ENG is now private" in result.output


def test_team_update_sets_the_estimate_settings(runner: CliRunner, api: respx.MockRouter) -> None:
    """The scale and its three toggles patch together and the reply names them."""
    patched = api.patch(f"/api/workspaces/{WS}/teams/team-1").respond(
        json={
            "id": "team-1",
            "key_prefix": "ENG",
            "name": "Engineering",
            "estimate_scale": "exponential",
            "estimate_extended": True,
            "estimate_allow_zero": False,
            "estimate_count_unestimated": True,
        }
    )
    result = invoke(
        runner,
        "team",
        "update",
        "-t",
        "ENG",
        "--estimate-scale",
        "exponential",
        "--extended",
        "--no-allow-zero",
        "--count-unestimated",
    )
    assert result.exit_code == 0, result.output
    assert json.loads(patched.calls[0].request.content) == {
        "estimate_scale": "exponential",
        "estimate_extended": True,
        "estimate_allow_zero": False,
        "estimate_count_unestimated": True,
    }
    assert "exponential, extended, unestimated count as 1 point" in result.output


def test_team_update_needs_a_change(runner: CliRunner, api: respx.MockRouter) -> None:
    """With no setting named there is nothing to send."""
    result = invoke(runner, "team", "update", "-t", "ENG")
    assert result.exit_code != 0


CYCLE_SETTINGS = {
    "team_id": "team-1",
    "enabled": True,
    "duration_weeks": 1,
    "cooldown_weeks": 0,
    "start_weekday": 0,
    "upcoming_count": 2,
    "auto_add_started": True,
    "move_unfinished": True,
}


def test_cycle_settings_shows_the_team_settings(runner: CliRunner, api: respx.MockRouter) -> None:
    """With no flag the settings are read, not changed."""
    api.get(f"/api/workspaces/{WS}/teams/team-1/cycle-settings").respond(json=CYCLE_SETTINGS)
    result = invoke(runner, "cycle", "settings", "-t", "ENG")
    assert result.exit_code == 0, result.output
    assert "Move unfinished issues" in result.stdout
    assert "Monday" in result.stdout


def test_cycle_settings_turns_moving_unfinished_issues_off(runner: CliRunner, api: respx.MockRouter) -> None:
    """The flag patches only the setting it names."""
    patched = api.patch(f"/api/workspaces/{WS}/teams/team-1/cycle-settings").respond(
        json={**CYCLE_SETTINGS, "move_unfinished": False}
    )
    result = invoke(runner, "cycle", "settings", "-t", "ENG", "--no-move-unfinished", "--json")
    assert result.exit_code == 0, result.output
    assert json.loads(patched.calls[0].request.content) == {"move_unfinished": False}
    assert json.loads(result.stdout)["move_unfinished"] is False


def test_cycle_list_and_current(runner: CliRunner, api: respx.MockRouter) -> None:
    """Cycles list per team, and `current` asks for the active one."""
    cycle = {
        "cycle_id": "cy-7",
        "name": "Cycle 7",
        "team_id": "team-1",
        "status": "active",
        "start_date": "2026-09-21",
        "end_date": "2026-10-04",
        "counts": {"done": 3, "total": 8},
    }
    active = api.get(f"/api/workspaces/{WS}/cycles", params={"status": "active"}).respond(json={"cycles": [cycle]})
    api.get(f"/api/workspaces/{WS}/cycles").respond(json={"cycles": [cycle]})
    listed = invoke(runner, "cycle", "list", "-t", "ENG")
    assert listed.exit_code == 0, listed.output
    assert "Cycle 7" in listed.stdout
    assert "3/8" in listed.stdout
    current = invoke(runner, "cycle", "current", "-t", "ENG", "--json")
    assert current.exit_code == 0, current.output
    assert json.loads(current.stdout)["cycle_id"] == "cy-7"
    assert _query(active)["team_id"] == ["team-1"]


def test_project_list_and_view(runner: CliRunner, api: respx.MockRouter, monkeypatch: pytest.MonkeyPatch) -> None:
    """Projects list, view by name, and open in the browser."""
    project = {
        "project_id": "pr-1",
        "name": "Launch",
        "status": "in_progress",
        "lead_id": "u-ada",
        "team_ids": ["team-1"],
        "counts": {"done": 1, "cancelled": 1, "total": 5},
        "description": "Ship it.",
    }
    api.get(f"/api/workspaces/{WS}/projects").respond(json={"projects": [project]})
    api.get(f"/api/workspaces/{WS}/projects/pr-1").respond(json=project)
    listed = invoke(runner, "project", "list")
    assert listed.exit_code == 0, listed.output
    assert "Launch" in listed.stdout
    assert "Ada" in listed.stdout
    assert "1/4" in listed.stdout
    viewed = invoke(runner, "project", "view", "launch")
    assert viewed.exit_code == 0, viewed.output
    assert "Ship it." in viewed.stdout
    assert "1 of 4 done" in viewed.stdout
    opened: list[str] = []
    monkeypatch.setattr("webbrowser.open", lambda url: opened.append(url))
    assert invoke(runner, "project", "view", "pr-1", "--web").exit_code == 0
    assert opened == ["https://web.test/w/acme/projects/pr-1"]


def test_project_update_cadence(runner: CliRunner, api: respx.MockRouter) -> None:
    """The due state shows in the list and view, and `project cadence` patches the interval."""
    project = {
        "project_id": "pr-1",
        "name": "Launch",
        "status": "in_progress",
        "team_ids": ["team-1"],
        "counts": {},
        "update_interval_days": 7,
        "update_interval_inherited": True,
        "next_update_due_at": "2026-10-09T09:00:00+00:00",
        "update_due_state": "due",
    }
    api.get(f"/api/workspaces/{WS}/projects").respond(json={"projects": [project]})
    api.get(f"/api/workspaces/{WS}/projects/pr-1").respond(json=project)
    patched = api.patch(f"/api/workspaces/{WS}/projects/pr-1").respond(
        json={**project, "update_interval_days": 14, "update_interval_inherited": False, "update_due_state": "upcoming"}
    )

    listed = invoke(runner, "project", "list")
    viewed = invoke(runner, "project", "view", "pr-1")
    set_result = invoke(runner, "project", "cadence", "launch", "biweekly")
    inherit = invoke(runner, "project", "cadence", "launch", "inherit")
    refused = invoke(runner, "project", "cadence", "launch", "daily")

    assert "due 2026-10-09" in listed.stdout
    assert "every 7 days (workspace default)" in viewed.stdout
    assert set_result.exit_code == 0, set_result.output
    assert "every 14 days, next due 2026-10-09" in set_result.stdout
    assert json.loads(patched.calls[0].request.content) == {"update_interval_days": 14}
    assert json.loads(patched.calls[1].request.content) == {"update_interval_days": None}
    assert inherit.exit_code == 0
    assert refused.exit_code != 0


def test_extra_headers_are_sent(runner: CliRunner, api: respx.MockRouter, monkeypatch: pytest.MonkeyPatch) -> None:
    """Gate headers from `STANDUPLESS_EXTRA_HEADERS` go on every request."""
    monkeypatch.setenv("STANDUPLESS_EXTRA_HEADERS", '{"x-origin-verify": "gate"}')
    result = invoke(runner, "team", "list")
    assert result.exit_code == 0, result.output
    assert api.calls.last.request.headers["x-origin-verify"] == "gate"


class TestAuth:
    """Login, status and logout against the keyring and config file."""

    @pytest.fixture(autouse=True)
    def no_env_key(self, logged_in: None, monkeypatch: pytest.MonkeyPatch) -> None:
        """Auth tests exercise the keyring, so the env key and workspace are cleared."""
        monkeypatch.delenv("STANDUPLESS_API_KEY")
        monkeypatch.delenv("STANDUPLESS_WORKSPACE")

    def test_login_finds_the_bound_workspace(
        self, runner: CliRunner, memory_keyring: MemoryKeyring, api: respx.MockRouter
    ) -> None:
        """With several workspaces, the one whose teams answer is the key's."""
        other = {"id": "ws-0", "name": "Other", "slug": "other", "plan": "free", "created_at": "x"}
        api.get("/api/workspaces").respond(
            json={"workspaces": [other, {"id": WS, "name": "Acme", "slug": "acme", "plan": "free", "created_at": "x"}]}
        )
        api.get("/api/workspaces/ws-0/teams").respond(404, json={"message": "Not found"})
        api.get("/api/users/me").respond(json={"id": "u-me", "email": "me@acme.test", "display_name": "Me"})
        result = invoke(runner, "auth", "login", "--with-token", input="wpk_secret\n")
        assert result.exit_code == 0, result.output
        assert memory_keyring.store[("standupless", BASE)] == "wpk_secret"
        host = load_config()["hosts"][BASE]
        assert host == {"workspace_id": WS, "workspace_slug": "acme", "user_id": "u-me"}
        assert "Logged in to Acme" in result.stderr

        status = invoke(runner, "auth", "status", "--json")
        assert status.exit_code == 0, status.output
        assert json.loads(status.stdout)["workspace"]["slug"] == "acme"
        assert json.loads(status.stdout)["key_source"] == "keyring"

        logout = invoke(runner, "auth", "logout")
        assert logout.exit_code == 0, logout.output
        assert memory_keyring.store == {}
        assert BASE not in load_config().get("hosts", {})

    def test_login_with_a_workspace_key_remembers_no_user(
        self, runner: CliRunner, memory_keyring: MemoryKeyring, api: respx.MockRouter
    ) -> None:
        """A workspace key has no person, so login saves the workspace and no user id."""
        api.get("/api/workspaces").respond(
            json={"workspaces": [{"id": WS, "name": "Acme", "slug": "acme", "plan": "free", "created_at": "x"}]}
        )
        api.get("/api/users/me").respond(
            403, json={"error_code": "WORKSPACE_KEY_HAS_NO_USER", "message": "A workspace key has no user."}
        )
        result = invoke(runner, "auth", "login", "--with-token", input="wpk_workspace\n")
        assert result.exit_code == 0, result.output
        assert load_config()["hosts"][BASE] == {"workspace_id": WS, "workspace_slug": "acme"}

    def test_login_rejects_something_that_is_not_a_key(self, runner: CliRunner) -> None:
        """A pasted password or JWT is refused before any request."""
        result = invoke(runner, "auth", "login", "--with-token", input="eyJhbGciOi\n")
        assert result.exit_code == 1
        assert "keys start with wpk_" in result.stderr

    def test_commands_without_a_key_say_how_to_log_in(self, runner: CliRunner) -> None:
        """No key anywhere points the software engineer at `auth login`."""
        result = invoke(runner, "team", "list")
        assert result.exit_code == 1
        assert "standupless auth login" in result.stderr


def test_status_list_shows_color_and_icon(runner: CliRunner, api: respx.MockRouter) -> None:
    """Statuses read in board order, with default where none was chosen."""
    result = invoke(runner, "status", "list", "-t", "eng")
    assert result.exit_code == 0, result.output
    assert result.stdout.index("Backlog") < result.stdout.index("Done")
    assert "default" in result.stdout


def test_status_create_sends_color_and_icon(runner: CliRunner, api: respx.MockRouter) -> None:
    """Both fields go in the create body, validated against the API's own values."""
    route = api.post(f"/api/workspaces/{WS}/teams/team-1/statuses").respond(
        201, json={"id": "st-new", "name": "In Review", "category": "started", "position": 6}
    )
    result = invoke(
        runner, "status", "create", "In Review", "-t", "eng", "-c", "started", "--color", "green", "--icon", "half"
    )
    assert result.exit_code == 0, result.output
    assert _json(route) == {"name": "In Review", "category": "started", "color": "green", "icon": "half"}


def test_status_create_refuses_an_unknown_color(runner: CliRunner, api: respx.MockRouter) -> None:
    """A color outside the palette fails before any request."""
    result = invoke(runner, "status", "create", "X", "-t", "eng", "-c", "started", "--color", "chartreuse")
    assert result.exit_code != 0


def test_status_edit_resets_with_default(runner: CliRunner, api: respx.MockRouter) -> None:
    """`default` sends null, which clears the field back to the category default."""
    route = api.patch(f"/api/workspaces/{WS}/teams/team-1/statuses/st-doing").respond(
        json={"id": "st-doing", "name": "In Progress", "category": "started", "position": 2}
    )
    result = invoke(runner, "status", "edit", "in progress", "-t", "eng", "--color", "default", "--icon", "paused")
    assert result.exit_code == 0, result.output
    assert _json(route) == {"color": None, "icon": "paused"}


def test_status_edit_with_nothing_to_change_fails(runner: CliRunner, api: respx.MockRouter) -> None:
    """An edit that names no field is a clean error, not an empty patch."""
    result = invoke(runner, "status", "edit", "Done", "-t", "eng")
    assert result.exit_code == 1
    assert "Nothing to change" in result.stderr


WORKSPACE_STATUS = {
    "id": "st-ws",
    "name": "Review",
    "category": "started",
    "position": 3,
    "scope": "workspace",
    "hidden": False,
    "inherited_name": None,
}
WORKSPACE_LABEL = {"id": "lb-ws", "name": "Bug", "color": "#eb5757", "scope": "workspace"}


def test_status_list_needs_a_team_or_shared(runner: CliRunner, api: respx.MockRouter) -> None:
    """Neither flag, or both, is a clean error before any status request."""
    assert invoke(runner, "status", "list").exit_code == 1
    assert invoke(runner, "status", "list", "-t", "eng", "--shared").exit_code == 1


def test_status_list_shared_reads_the_workspace_set(runner: CliRunner, api: respx.MockRouter) -> None:
    """--shared lists the workspace statuses with their scope."""
    api.get(f"/api/workspaces/{WS}/statuses").respond(json={"statuses": [WORKSPACE_STATUS]})
    result = invoke(runner, "status", "list", "--shared")
    assert result.exit_code == 0, result.output
    assert "Review" in result.stdout
    assert "workspace" in result.stdout


def test_status_list_include_hidden_asks_for_hidden(runner: CliRunner, api: respx.MockRouter) -> None:
    """--include-hidden becomes the API's query flag."""
    result = invoke(runner, "status", "list", "-t", "eng", "--include-hidden")
    assert result.exit_code == 0, result.output
    request = api.calls.last.request
    assert request.url.path.endswith("/teams/team-1/statuses")
    assert parse_qs(request.url.query.decode()) == {"include_hidden": ["true"]}


def test_status_create_shared_posts_to_the_workspace(runner: CliRunner, api: respx.MockRouter) -> None:
    """A shared create goes to the workspace statuses route."""
    route = api.post(f"/api/workspaces/{WS}/statuses").respond(201, json=WORKSPACE_STATUS)
    result = invoke(runner, "status", "create", "Review", "--shared", "-c", "started")
    assert result.exit_code == 0, result.output
    assert _json(route) == {"name": "Review", "category": "started"}


def test_status_delete_shared(runner: CliRunner, api: respx.MockRouter) -> None:
    """A shared delete resolves the name in the workspace set."""
    api.get(f"/api/workspaces/{WS}/statuses").respond(json={"statuses": [WORKSPACE_STATUS]})
    route = api.delete(f"/api/workspaces/{WS}/statuses/st-ws").respond(204)
    result = invoke(runner, "status", "delete", "review", "--shared")
    assert result.exit_code == 0, result.output
    assert route.called


def test_status_delete_move_to_names_the_replacement(runner: CliRunner, api: respx.MockRouter) -> None:
    """--move-to resolves the replacement by name and sends its id as the query parameter."""
    done = {**WORKSPACE_STATUS, "id": "st-done", "name": "Done", "category": "completed"}
    api.get(f"/api/workspaces/{WS}/statuses").respond(json={"statuses": [WORKSPACE_STATUS, done]})
    route = api.delete(f"/api/workspaces/{WS}/statuses/st-ws").respond(204)
    result = invoke(runner, "status", "delete", "review", "--shared", "--move-to", "done")
    assert result.exit_code == 0, result.output
    assert parse_qs(route.calls.last.request.url.query.decode()) == {"replacement_status_id": ["st-done"]}
    assert "moved to Done" in result.output


def test_status_hide_and_rename_send_overrides(runner: CliRunner, api: respx.MockRouter) -> None:
    """Hide and rename patch the team override; clear-rename sends a null name; reset deletes it."""
    api.get(f"/api/workspaces/{WS}/teams/team-1/statuses").respond(json={"statuses": [WORKSPACE_STATUS]})
    path = f"/api/workspaces/{WS}/teams/team-1/statuses/st-ws/override"
    patch = api.patch(path).respond(json=WORKSPACE_STATUS)
    reset = api.delete(path).respond(json=WORKSPACE_STATUS)
    assert invoke(runner, "status", "hide", "Review", "-t", "eng").exit_code == 0
    assert _json(patch) == {"hidden": True}
    assert invoke(runner, "status", "rename", "Review", "QA", "-t", "eng").exit_code == 0
    assert _json(patch) == {"name": "QA"}
    assert invoke(runner, "status", "clear-rename", "Review", "-t", "eng").exit_code == 0
    assert _json(patch) == {"name": None}
    assert invoke(runner, "status", "reset", "Review", "-t", "eng").exit_code == 0
    assert reset.called


def test_label_list_for_a_team_shows_scope(runner: CliRunner, api: respx.MockRouter) -> None:
    """A team's labels list with their scope column."""
    result = invoke(runner, "label", "list", "-t", "eng")
    assert result.exit_code == 0, result.output
    assert "SCOPE" in result.stdout


def test_label_create_and_edit_shared(runner: CliRunner, api: respx.MockRouter) -> None:
    """Shared label writes go to the workspace labels routes."""
    created = api.post(f"/api/workspaces/{WS}/labels").respond(201, json=WORKSPACE_LABEL)
    api.get(f"/api/workspaces/{WS}/labels").respond(json={"labels": [WORKSPACE_LABEL]})
    edited = api.patch(f"/api/workspaces/{WS}/labels/lb-ws").respond(json=WORKSPACE_LABEL)
    assert invoke(runner, "label", "create", "Bug", "--shared", "--color", "#eb5757").exit_code == 0
    assert _json(created) == {"name": "Bug", "color": "#eb5757"}
    result = invoke(runner, "label", "edit", "bug", "--shared", "--color", "#000000")
    assert result.exit_code == 0, result.output
    assert _json(edited) == {"color": "#000000"}


def test_label_team_crud_and_overrides(runner: CliRunner, api: respx.MockRouter) -> None:
    """Team label writes and overrides reach the team routes."""
    team_label = {"id": "lb-team", "name": "Infra", "color": "#123456", "scope": "team"}
    api.get(f"/api/workspaces/{WS}/teams/team-1/labels").respond(json={"labels": [team_label, WORKSPACE_LABEL]})
    created = api.post(f"/api/workspaces/{WS}/teams/team-1/labels").respond(201, json=team_label)
    deleted = api.delete(f"/api/workspaces/{WS}/teams/team-1/labels/lb-team").respond(204)
    hidden = api.patch(f"/api/workspaces/{WS}/teams/team-1/labels/lb-ws/override").respond(json=WORKSPACE_LABEL)
    assert invoke(runner, "label", "create", "Infra", "-t", "eng", "--color", "#123456").exit_code == 0
    assert created.called
    assert invoke(runner, "label", "delete", "infra", "-t", "eng").exit_code == 0
    assert deleted.called
    assert invoke(runner, "label", "hide", "Bug", "-t", "eng").exit_code == 0
    assert _json(hidden) == {"hidden": True}


def test_issue_export_joins_every_page(runner: CliRunner, api: respx.MockRouter, tmp_path: Any) -> None:
    """Pages are fetched until the cursor runs out and written as one file, every status included."""
    route = api.get(f"/api/workspaces/{WS}/issues/export").mock(
        side_effect=[
            httpx.Response(200, json={"csv": "ID,Title\r\nENG-1,One\r\n", "rows": 1, "next_cursor": "c1"}),
            httpx.Response(200, json={"csv": "ENG-2,Two\r\n", "rows": 1, "next_cursor": None}),
        ]
    )
    target = tmp_path / "issues.csv"
    result = invoke(runner, "issue", "export", "-t", "eng", "-o", str(target))
    assert result.exit_code == 0, result.output
    assert target.read_bytes() == b"ID,Title\r\nENG-1,One\r\nENG-2,Two\r\n"
    first = parse_qs(route.calls[0].request.url.query.decode())
    assert first["team_id"] == ["team-1"]
    assert "status_category" not in first
    assert "cursor" not in first
    assert _query(route)["cursor"] == ["c1"]


def test_issue_export_starts_from_a_saved_view(runner: CliRunner, api: respx.MockRouter) -> None:
    """--view sends the view's own filter, team and archive setting, narrowed by any other option."""
    api.get(f"/api/workspaces/{WS}/views").respond(
        json={
            "views": [
                {
                    "view_id": "vw-1",
                    "name": "Urgent bugs",
                    "team_id": "team-1",
                    "filter": {"priority": ["urgent"], "label_id": ["lb-bug"], "q": ""},
                    "show_archived": True,
                }
            ]
        }
    )
    route = api.get(f"/api/workspaces/{WS}/issues/export").respond(
        json={"csv": "ID\r\nENG-1\r\n", "rows": 1, "next_cursor": None}
    )
    result = invoke(runner, "issue", "export", "--view", "urgent bugs", "--open")
    assert result.exit_code == 0, result.output
    assert result.stdout.splitlines() == ["ID", "ENG-1"]
    query = _query(route)
    assert query["team_id"] == ["team-1"]
    assert query["priority"] == ["urgent"]
    assert query["label_id"] == ["lb-bug"]
    assert query["include_archived"] == ["true"]
    assert query["status_category"] == ["backlog", "unstarted", "started"]
    assert "q" not in query


def test_issue_export_names_an_unknown_view(runner: CliRunner, api: respx.MockRouter) -> None:
    """A view that does not exist is an error, not an export of everything."""
    api.get(f"/api/workspaces/{WS}/views").respond(json={"views": []})
    result = invoke(runner, "issue", "export", "--view", "nope")
    assert result.exit_code == 1
    assert "No saved view matches" in result.output


def test_workspace_update_sets_the_accent(runner: CliRunner, api: respx.MockRouter) -> None:
    """The accent goes to the workspace PATCH as given, for the server to validate."""
    route = api.patch(f"/api/workspaces/{WS}").respond(json={**WORKSPACE, "accent_color": "#1f7ae0"})
    result = invoke(runner, "workspace", "update", "--accent-color", "#1F7AE0")
    assert result.exit_code == 0, result.output
    assert _json(route) == {"accent_color": "#1F7AE0"}
    assert "#1f7ae0" in result.output


def test_workspace_update_resets_the_accent(runner: CliRunner, api: respx.MockRouter) -> None:
    """A reset sends an explicit null, which returns the workspace to the default."""
    route = api.patch(f"/api/workspaces/{WS}").respond(json={**WORKSPACE, "accent_color": None})
    result = invoke(runner, "workspace", "update", "--reset-accent", "--json")
    assert result.exit_code == 0, result.output
    assert _json(route) == {"accent_color": None}
    assert json.loads(result.stdout)["accent_color"] is None


@pytest.mark.parametrize(
    "args", [(), ("--accent-color", "#123456", "--reset-accent")], ids=["nothing", "both accent flags"]
)
def test_workspace_update_refuses_an_unclear_change(
    runner: CliRunner, api: respx.MockRouter, args: tuple[str, ...]
) -> None:
    """Nothing to change, or a set and a reset together, is a usage error before any request."""
    route = api.patch(f"/api/workspaces/{WS}").respond(json=WORKSPACE)
    result = invoke(runner, "workspace", "update", *args)
    assert result.exit_code == 1
    assert not route.called


def test_workspace_view_shows_the_accent(runner: CliRunner, api: respx.MockRouter) -> None:
    """The view names the accent, or says the workspace uses the default."""
    api.get(f"/api/workspaces/{WS}").respond(json={**WORKSPACE, "accent_color": None})
    result = invoke(runner, "workspace", "view")
    assert result.exit_code == 0, result.output
    assert "default" in result.stdout
    assert "acme" in result.stdout


def test_issue_activity_names_the_client_and_filters(runner: CliRunner, api: respx.MockRouter) -> None:
    """History shows which client made each change and passes the source filter on."""
    api.get(f"/api/workspaces/{WS}/issues/by-key/ENG-12").respond(json=make_issue())
    route = api.get(f"/api/workspaces/{WS}/issues/is-12/activity").respond(
        json={
            "activity": [
                {
                    "activity_id": "a1",
                    "issue_id": "is-12",
                    "actor_id": "u1",
                    "actor_kind": "user",
                    "kind": "field_changed",
                    "field": "description",
                    "source": "mcp",
                    "created_at": "2026-10-07T00:00:00Z",
                }
            ],
            "next_cursor": None,
        }
    )
    result = invoke(runner, "issue", "activity", "ENG-12", "--source", "mcp")
    assert result.exit_code == 0, result.output
    assert "MCP" in result.stdout
    assert "description" in result.stdout
    assert route.calls.last.request.url.params["source"] == "mcp"


GROUP = {"id": "lb-area", "name": "Area", "color": "#123456", "scope": "team", "is_group": True}
GROUPED = {"id": "lb-web", "name": "Web", "color": "#123456", "scope": "team", "parent_id": "lb-area"}


def test_label_list_shows_each_group_before_its_labels(runner: CliRunner, api: respx.MockRouter) -> None:
    """The group column marks the group and names it beside its labels, which follow it."""
    api.get(f"/api/workspaces/{WS}/teams/team-1/labels").respond(json={"labels": [GROUPED, WORKSPACE_LABEL, GROUP]})
    result = invoke(runner, "label", "list", "-t", "eng")
    assert result.exit_code == 0, result.output
    assert "GROUP" in result.stdout
    assert result.stdout.index("lb-area") < result.stdout.index("lb-web")


def test_label_create_makes_a_group_and_a_label_inside_it(runner: CliRunner, api: respx.MockRouter) -> None:
    """--is-group makes a group, and --group names the group a new label goes in."""
    api.get(f"/api/workspaces/{WS}/teams/team-1/labels").respond(json={"labels": [GROUP]})
    created = api.post(f"/api/workspaces/{WS}/teams/team-1/labels").respond(201, json=GROUP)
    assert invoke(runner, "label", "create", "Area", "-t", "eng", "--color", "#123456", "--is-group").exit_code == 0
    assert _json(created) == {"name": "Area", "color": "#123456", "is_group": True}
    assert invoke(runner, "label", "create", "Web", "-t", "eng", "--color", "#123456", "--group", "area").exit_code == 0
    assert _json(created) == {"name": "Web", "color": "#123456", "parent_id": "lb-area"}
    refused = invoke(runner, "label", "create", "Web", "-t", "eng", "--color", "#123456", "--group", "nowhere")
    assert refused.exit_code != 0


def test_label_edit_moves_a_label_in_and_out_of_a_group(runner: CliRunner, api: respx.MockRouter) -> None:
    """--group moves a label in, --no-group takes it out, and a label is found by its path."""
    plain = {**GROUPED, "parent_id": None}
    api.get(f"/api/workspaces/{WS}/teams/team-1/labels").respond(json={"labels": [GROUP, GROUPED]})
    edited = api.patch(f"/api/workspaces/{WS}/teams/team-1/labels/lb-web").respond(json=plain)
    result = invoke(runner, "label", "edit", "Area/Web", "-t", "eng", "--no-group")
    assert result.exit_code == 0, result.output
    assert _json(edited) == {"parent_id": None}
    assert invoke(runner, "label", "edit", "web", "-t", "eng", "--group", "Area").exit_code == 0
    assert _json(edited) == {"parent_id": "lb-area"}
    assert invoke(runner, "label", "edit", "web", "-t", "eng", "--group", "Web").exit_code != 0


def test_triage_list_reads_the_teams_inbox(runner: CliRunner, api: respx.MockRouter) -> None:
    """The inbox is read for the named team and printed as the issue table."""
    route = api.get(f"/api/workspaces/{WS}/issues/triage").respond(json={"issues": [make_issue()]})
    result = invoke(runner, "triage", "list", "-t", "ENG")
    assert result.exit_code == 0, result.output
    assert _query(route)["team_id"] == ["team-1"]
    assert "ENG-12" in result.stdout


def test_triage_accept_resolves_the_status(runner: CliRunner, api: respx.MockRouter) -> None:
    """A status name is sent as its id, and the reply names where it landed."""
    api.get(f"/api/workspaces/{WS}/issues/by-key/ENG-12").respond(json=make_issue())
    route = api.post(f"/api/workspaces/{WS}/issues/is-12/triage/accept").respond(json=make_issue())
    result = invoke(runner, "triage", "accept", "ENG-12", "--status", "Todo")
    assert result.exit_code == 0, result.output
    assert _json(route) == {"status_id": "st-todo"}
    assert "Accepted ENG-12 into Todo" in result.output


def test_triage_decline_and_duplicate(runner: CliRunner, api: respx.MockRouter) -> None:
    """Decline sends the reason, and duplicate sends the other issue's id."""
    api.get(f"/api/workspaces/{WS}/issues/by-key/ENG-12").respond(json=make_issue())
    api.get(f"/api/workspaces/{WS}/issues/by-key/ENG-3").respond(json=make_issue(id="iss-3", key="ENG-3"))
    declined = api.post(f"/api/workspaces/{WS}/issues/is-12/triage/decline").respond(json=make_issue())
    duplicate = api.post(f"/api/workspaces/{WS}/issues/is-12/triage/duplicate").respond(json=make_issue())
    assert invoke(runner, "triage", "decline", "ENG-12", "-r", "Out of scope").exit_code == 0
    assert _json(declined) == {"reason": "Out of scope"}
    result = invoke(runner, "triage", "duplicate", "ENG-12", "--of", "ENG-3")
    assert result.exit_code == 0, result.output
    assert _json(duplicate) == {"duplicate_of_id": "iss-3"}


def test_triage_snooze_takes_a_duration_or_clear(runner: CliRunner, api: respx.MockRouter) -> None:
    """A duration becomes a moment, --clear sends null, and neither is refused."""
    api.get(f"/api/workspaces/{WS}/issues/by-key/ENG-12").respond(json=make_issue())
    route = api.post(f"/api/workspaces/{WS}/issues/is-12/triage/snooze").respond(json=make_issue())
    assert invoke(runner, "triage", "snooze", "ENG-12", "--for", "2d").exit_code == 0
    assert _json(route)["until"]
    assert invoke(runner, "triage", "snooze", "ENG-12", "--clear").exit_code == 0
    assert _json(route) == {"until": None}
    assert invoke(runner, "triage", "snooze", "ENG-12").exit_code != 0
    assert invoke(runner, "triage", "snooze", "ENG-12", "--for", "soon").exit_code != 0


def test_triage_enable_patches_the_switch(runner: CliRunner, api: respx.MockRouter) -> None:
    """Enable turns the team's triage inbox on."""
    route = api.patch(f"/api/workspaces/{WS}/teams/team-1/triage-settings").respond(
        json={"team_id": "team-1", "enabled": True, "updated_at": None}
    )
    result = invoke(runner, "triage", "enable", "-t", "ENG")
    assert result.exit_code == 0, result.output
    assert _json(route) == {"enabled": True}
    assert "Triage is on for ENG" in result.output


def test_insights_groups_and_draws_bars(runner: CliRunner, api: respx.MockRouter) -> None:
    """Options become the insights params, and each group and segment is a table row."""
    route = api.get(f"/api/workspaces/{WS}/views/insights").respond(
        json={
            "team_ids": ["team-1"],
            "group_by": "assignee",
            "segment_by": "priority",
            "measure": "points",
            "total": 8,
            "issue_count": 3,
            "groups": [
                {
                    "key": "u-ada",
                    "label": "Ada",
                    "value": 5,
                    "issue_count": 2,
                    "segments": [{"key": "high", "label": "High", "value": 5, "issue_count": 2}],
                },
                {"key": None, "label": "No assignee", "value": 3, "issue_count": 1, "segments": []},
            ],
            "truncated": True,
            "row_cap": 2000,
        }
    )
    result = invoke(
        runner, "insights", "-t", "eng", "-g", "assignee", "--segment-by", "priority", "-m", "points", "--open"
    )
    assert result.exit_code == 0, result.output
    query = _query(route)
    assert query["team_id"] == ["team-1"]
    assert query["group_by"] == ["assignee"]
    assert query["segment_by"] == ["priority"]
    assert query["measure"] == ["points"]
    assert query["status_category"] == ["backlog", "unstarted", "started"]
    assert "Ada" in result.stdout
    assert "No assignee" in result.stdout
    assert "High" in result.stdout
    assert "8 points over 3 issues" in result.stdout
    assert "first 2000 issues" in result.stderr


CHANNEL = {
    "channel_id": "ch-1",
    "team_id": "team-1",
    "provider": "slack",
    "label": "#eng",
    "events": ["issue_created", "issue_completed"],
    "enabled": True,
    "url_hint": "hooks.slack.com/…abcd",
    "created_by": "u-1",
    "created_at": "2026-10-07T00:00:00Z",
    "updated_at": "2026-10-07T00:00:00Z",
}


RELEASE = {
    "release_id": "01J0000000000000000000REL1",
    "team_id": "team-1",
    "workspace_id": WS,
    "name": "2026.10.07-1a2b3c4",
    "version": None,
    "source": "api",
    "sha": "1a2b3c4d5e",
    "repository": "acme/app",
    "issue_count": 1,
    "stages": [{"stage_id": "production", "name": "Production", "reached_at": "2026-10-07T00:00:00Z", "source": "api"}],
    "current_stage": {
        "stage_id": "production",
        "name": "Production",
        "reached_at": "2026-10-07T00:00:00Z",
        "source": "api",
    },
    "created_at": "2026-10-07T00:00:00Z",
    "updated_at": "2026-10-07T00:00:00Z",
}

CHANNELS_PATH = f"/api/workspaces/{WS}/teams/team-1/webhooks/channels"


def test_channel_list_shows_the_masked_url_and_never_the_full_one(runner: CliRunner, api: respx.MockRouter) -> None:
    """The table carries the hint, the provider, the events and the state."""
    api.get(CHANNELS_PATH).respond(json=[CHANNEL])
    result = invoke(runner, "channel", "list", "-t", "ENG")
    assert result.exit_code == 0, result.output
    assert "#eng" in result.stdout
    assert "abcd" in result.stdout
    assert "on" in result.stdout


def test_channel_add_reads_the_url_from_stdin(runner: CliRunner, api: respx.MockRouter) -> None:
    """The URL comes from stdin, not an argument, and the events go as given."""
    created = api.post(CHANNELS_PATH).respond(201, json=CHANNEL)
    result = invoke(
        runner,
        "channel",
        "add",
        "-t",
        "ENG",
        "--label",
        "#eng",
        "-e",
        "issue_created",
        "--url-stdin",
        input="https://hooks.slack.com/services/T0/B0/abcd\n",
    )
    assert result.exit_code == 0, result.output
    assert _json(created) == {
        "url": "https://hooks.slack.com/services/T0/B0/abcd",
        "label": "#eng",
        "events": ["issue_created"],
    }


def test_channel_add_refuses_an_unknown_event(runner: CliRunner, api: respx.MockRouter) -> None:
    """A typo in an event name fails before anything is sent."""
    result = invoke(runner, "channel", "add", "-t", "ENG", "-e", "issue_deleted", "--url-stdin", input="x\n")
    assert result.exit_code == 1
    assert "issue_deleted" in result.output


def test_channel_edit_finds_the_channel_by_label(runner: CliRunner, api: respx.MockRouter) -> None:
    """Edit resolves the label to an id and patches only what was asked."""
    api.get(CHANNELS_PATH).respond(json=[CHANNEL])
    patched = api.patch(f"{CHANNELS_PATH}/ch-1").respond(json={**CHANNEL, "enabled": False})
    result = invoke(runner, "channel", "edit", "#ENG", "-t", "ENG", "--off")
    assert result.exit_code == 0, result.output
    assert _json(patched) == {"enabled": False}


def test_channel_test_reports_a_failure_with_exit_1(runner: CliRunner, api: respx.MockRouter) -> None:
    """A test that did not land exits non-zero with the status."""
    api.get(CHANNELS_PATH).respond(json=[CHANNEL])
    api.post(f"{CHANNELS_PATH}/ch-1/test").respond(json={"delivered": False, "status_code": 404, "error": "HTTP 404"})
    result = invoke(runner, "channel", "test", "ch-1", "-t", "ENG")
    assert result.exit_code == 1
    assert "HTTP 404" in result.output


def test_release_list_and_view(runner: CliRunner, api: respx.MockRouter) -> None:
    """Releases list for a team, and a name resolves to the release it means."""
    releases = f"/api/workspaces/{WS}/teams/team-1/releases"
    api.get(releases).respond(json={"releases": [RELEASE]})
    detail = {**RELEASE, "issues": [], "notes": "ENG-1 Fix login", "skipped_issues": []}
    api.get(f"{releases}/{RELEASE['release_id']}").respond(json=detail)
    listed = invoke(runner, "release", "list", "-t", "ENG")
    assert listed.exit_code == 0, listed.output
    assert "Production" in listed.stdout
    assert "1a2b3c4" in listed.stdout
    viewed = invoke(runner, "release", "view", "2026.10.07-1a2b3c4", "-t", "ENG")
    assert viewed.exit_code == 0, viewed.output
    assert "ENG-1 Fix login" in viewed.stdout


def test_release_create_sends_the_commit_messages_of_a_range(
    runner: CliRunner, api: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
) -> None:
    """--git-range reads git log and sends each message for the server to find keys in."""
    calls: list[list[str]] = []

    def fake_run(args: list[str], **_: Any) -> Any:
        """Answer git log with two commits."""
        calls.append(args)
        return type("Done", (), {"stdout": "Fix ENG-1\n\x00Refs ENG-2\n\x00"})()

    monkeypatch.setattr("standupless_cli.main.subprocess.run", fake_run)
    detail = {**RELEASE, "issues": [], "notes": "", "skipped_issues": ["ENG-9"]}
    created = api.post(f"/api/workspaces/{WS}/teams/team-1/releases").respond(201, json=detail)
    result = invoke(
        runner, "release", "create", "-t", "ENG", "--sha", "1a2b3c4d5e", "--git-range", "v1..HEAD", "-i", "eng-9"
    )
    assert result.exit_code == 0, result.output
    assert calls[0][-1] == "v1..HEAD"
    body = _json(created)
    assert body["commit_messages"] == ["Fix ENG-1", "Refs ENG-2"]
    assert body["issues"] == ["ENG-9"]
    assert body["sha"] == "1a2b3c4d5e"
    assert "ENG-9" in result.output


def test_release_pipeline_keeps_stage_ids_when_replacing(runner: CliRunner, api: respx.MockRouter) -> None:
    """Replacing the stages reuses the id of a stage whose name is kept."""
    path = f"/api/workspaces/{WS}/teams/team-1/release-pipeline"
    current = {
        "team_id": "team-1",
        "configured": False,
        "stages": [{"stage_id": "production", "name": "Production", "github_environments": ["production"]}],
    }
    api.get(path).respond(json=current)
    saved = api.put(path).respond(json={**current, "configured": True})
    result = invoke(
        runner, "release", "pipeline", "-t", "ENG", "--stage", "Staging=staging", "--stage", "Production=production"
    )
    assert result.exit_code == 0, result.output
    assert _json(saved)["stages"] == [
        {"name": "Staging", "github_environments": ["staging"]},
        {"name": "Production", "github_environments": ["production"], "stage_id": "production"},
    ]


DIGEST = {
    "team_id": "team-1",
    "team_key": "ENG",
    "team_name": "Engineering",
    "date": "2026-10-06",
    "cadence": "daily",
    "timezone": "UTC",
    "send_time": "09:00",
    "window_start": "2026-10-05T09:00:00Z",
    "window_end": "2026-10-06T09:00:00Z",
    "generated_at": "2026-10-06T10:00:00Z",
    "people": [
        {
            "user_id": "u-ada",
            "display_name": "Ada",
            "note": "On the login page today",
            "completed": [
                {
                    "issue_id": "is-12",
                    "key": "ENG-12",
                    "title": "Fix the login page",
                    "status_id": "st-done",
                    "project_name": "Auth",
                }
            ],
        },
        {"user_id": "u-me", "display_name": "Me"},
    ],
}


def test_standup_prints_each_person_grouped_by_project(runner: CliRunner, api: respx.MockRouter) -> None:
    """The digest reads per person with the note, the section and the project, and quiet people are left out."""
    got = api.get(f"/api/workspaces/{WS}/teams/team-1/standup").respond(json=DIGEST)
    result = invoke(runner, "standup", "-t", "ENG", "--date", "2026-10-06", "--weekly")
    assert result.exit_code == 0, result.output
    assert dict(got.calls[0].request.url.params) == {"date": "2026-10-06", "cadence": "weekly"}
    assert "Ada" in result.output and "On the login page today" in result.output
    assert "Completed" in result.output and "Auth" in result.output and "ENG-12" in result.output
    assert "Me\n" not in result.output


def test_standup_needs_a_team(runner: CliRunner, api: respx.MockRouter) -> None:
    """With no subcommand and no team there is nothing to show."""
    result = invoke(runner, "standup")
    assert result.exit_code == 1
    assert "--team" in result.output


def test_standup_note_saves_for_the_next_digest(runner: CliRunner, api: respx.MockRouter) -> None:
    """The note goes up without a date, so the server files it under the next digest."""
    put = api.put(f"/api/workspaces/{WS}/teams/team-1/standup/note").respond(
        json={"team_id": "team-1", "user_id": "u-me", "date": "2026-10-07", "body": "On ENG-12"}
    )
    result = invoke(runner, "standup", "note", "-t", "ENG", "On ENG-12")
    assert result.exit_code == 0, result.output
    assert json.loads(put.calls[0].request.content) == {"body": "On ENG-12"}
    assert "2026-10-07" in result.output


def test_standup_settings_turns_the_weekly_digest_on(runner: CliRunner, api: respx.MockRouter) -> None:
    """Day names become the API's Monday-first index."""
    patched = api.patch(f"/api/workspaces/{WS}/teams/team-1/standup/settings").respond(
        json={
            "team_id": "team-1",
            "cadence": "weekly",
            "send_time": "10:30",
            "timezone": "Europe/Berlin",
            "weekday": 4,
            "next_digest_date": "2026-10-09",
        }
    )
    flags = ["--cadence", "weekly", "--send-time", "10:30", "--timezone", "Europe/Berlin", "--weekday", "friday"]
    result = invoke(runner, "standup", "settings", "-t", "ENG", *flags)
    assert result.exit_code == 0, result.output
    assert json.loads(patched.calls[0].request.content) == {
        "cadence": "weekly",
        "send_time": "10:30",
        "timezone": "Europe/Berlin",
        "weekday": 4,
    }
    assert "every Friday at 10:30 Europe/Berlin" in result.output


def _export(status: str, **extra: Any) -> dict[str, Any]:
    """One workspace export job as the API answers it."""
    return {
        "export_id": "ex-1",
        "workspace_id": WS,
        "status": status,
        "format_version": 1,
        "requested_by": "u-1",
        "emails_masked": False,
        "created_at": "2026-10-07T12:00:00Z",
        "size_bytes": 0,
        "counts": {},
        **extra,
    }


def test_workspace_export_waits_then_downloads(
    runner: CliRunner, api: respx.MockRouter, monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    """The command starts an export, polls it until ready, and saves the bundle the link points at."""
    import standupless_cli.main as main

    started = api.post(f"/api/workspaces/{WS}/exports").respond(202, json=_export("queued"))
    api.get(f"/api/workspaces/{WS}/exports/ex-1").mock(
        side_effect=[
            httpx.Response(200, json=_export("running")),
            httpx.Response(200, json=_export("ready", download_url="https://bucket.test/b.zip")),
        ]
    )
    fetched: list[str] = []

    def fake_download(url: str, target: Any) -> int:
        """Record the link and write a stand-in bundle."""
        fetched.append(url)
        target.write(b"PK")
        return 2

    monkeypatch.setattr(main, "download", fake_download)
    monkeypatch.setattr(main.time, "sleep", lambda _seconds: None)
    target = tmp_path / "out.zip"
    result = invoke(runner, "workspace", "export", "--mask-emails", "-o", str(target))
    assert result.exit_code == 0, result.output
    assert _json(started) == {"include_emails": False}
    assert fetched == ["https://bucket.test/b.zip"]
    assert target.read_bytes() == b"PK"


def test_workspace_export_no_wait_prints_the_id(runner: CliRunner, api: respx.MockRouter) -> None:
    """--no-wait starts the export and prints its id for a later --id download."""
    api.post(f"/api/workspaces/{WS}/exports").respond(202, json=_export("queued"))
    result = invoke(runner, "workspace", "export", "--no-wait")
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == "ex-1"


def test_workspace_export_reports_a_failed_export(
    runner: CliRunner, api: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failed export is an error rather than an empty file."""
    import standupless_cli.main as main

    monkeypatch.setattr(main.time, "sleep", lambda _seconds: None)
    api.get(f"/api/workspaces/{WS}/exports/ex-1").respond(json=_export("failed", error="RuntimeError"))
    result = invoke(runner, "workspace", "export", "--id", "ex-1")
    assert result.exit_code == 1
    assert "failed" in result.output
