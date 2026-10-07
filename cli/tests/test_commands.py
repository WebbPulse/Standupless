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
from tests.conftest import BASE, TEAM, WS, MemoryKeyring, invoke, make_issue

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


def test_team_update_needs_a_change(runner: CliRunner, api: respx.MockRouter) -> None:
    """With no setting named there is nothing to send."""
    result = invoke(runner, "team", "update", "-t", "ENG")
    assert result.exit_code != 0


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
