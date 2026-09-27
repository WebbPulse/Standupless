"""The `standupless` command: issues, teams, cycles and projects from the terminal.

The command surface is curated rather than one command per endpoint, shaped after
`gh` and the Linear CLI: nouns, then verbs, names instead of ids, a table by default
and `--json` for scripts.
"""

from __future__ import annotations

import sys
import webbrowser
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Annotated, Any, cast

import typer
from typer.core import TyperGroup

from standupless_cli import __version__, output
from standupless_cli._generated.models import CommentRead, IssueCreate, IssueUpdate
from standupless_cli.branch import branch_name
from standupless_cli.client import ApiError, Issue, StanduplessClient
from standupless_cli.config import (
    ConfigError,
    Settings,
    delete_keyring,
    forget_host,
    read_keyring,
    remember_host,
    resolve_settings,
    write_keyring,
)
from standupless_cli.resolve import OPEN_CATEGORIES, Context, ResolveError, compact

KEY_PREFIX = "wpk_"


class HandledErrors(TyperGroup):
    """Turns the errors a user can fix into one red line and exit status 1, not a traceback."""

    def invoke(self, ctx: Any) -> Any:
        """Run the command, reporting API, lookup and config errors on stderr."""
        try:
            return super().invoke(ctx)
        except (ApiError, ResolveError, ConfigError) as exc:
            output.error(str(exc))
            raise typer.Exit(1) from exc


app = typer.Typer(
    cls=HandledErrors,
    help="Standupless from the terminal.",
    no_args_is_help=True,
    rich_markup_mode=None,
    pretty_exceptions_enable=False,
)
auth_app = typer.Typer(help="Log in with an API key, log out, and check the current login.", no_args_is_help=True)
issue_app = typer.Typer(help="List, view, create and change issues.", no_args_is_help=True)
team_app = typer.Typer(help="Teams in the workspace.", no_args_is_help=True)
cycle_app = typer.Typer(help="A team's cycles.", no_args_is_help=True)
project_app = typer.Typer(help="Projects in the workspace.", no_args_is_help=True)
app.add_typer(auth_app, name="auth")
app.add_typer(issue_app, name="issue")
app.add_typer(team_app, name="team")
app.add_typer(cycle_app, name="cycle")
app.add_typer(project_app, name="project")


class Priority(StrEnum):
    """Issue priorities as the API spells them."""

    none = "none"
    urgent = "urgent"
    high = "high"
    medium = "medium"
    low = "low"


class CloseReason(StrEnum):
    """Whether closing means the work was done or dropped."""

    completed = "completed"
    canceled = "canceled"


class CycleStatus(StrEnum):
    """Cycle statuses as the API spells them."""

    upcoming = "upcoming"
    active = "active"
    completed = "completed"
    cancelled = "cancelled"


class ProjectStatus(StrEnum):
    """Project statuses as the API spells them."""

    backlog = "backlog"
    planned = "planned"
    in_progress = "in_progress"
    paused = "paused"
    completed = "completed"
    canceled = "canceled"


@dataclass
class State:
    """The global flags, and the connection built from them on first use."""

    env: str | None = None
    base_url: str | None = None
    workspace: str | None = None
    _settings: Settings | None = None
    _context: Context | None = None
    _clients: list[StanduplessClient] = field(default_factory=list)

    def settings(self) -> Settings:
        """Settings resolved from flags, env and config, once."""
        if self._settings is None:
            self._settings = resolve_settings(self.env, self.base_url, self.workspace)
        return self._settings

    def client(self, api_key: str) -> StanduplessClient:
        """A client for the resolved base URL, closed when the command ends."""
        settings = self.settings()
        client = StanduplessClient(settings.base_url, api_key, settings.extra_headers)
        self._clients.append(client)
        return client

    def context(self) -> Context:
        """The workspace context for commands that need a logged in key."""
        if self._context is None:
            settings = self.settings()
            api_key = settings.api_key()
            if not api_key:
                raise ConfigError(
                    f"Not logged in to {settings.base_url}. Run `standupless auth login` or set STANDUPLESS_API_KEY."
                )
            self._context = Context(settings, self.client(api_key))
        return self._context

    def close(self) -> None:
        """Close every client this invocation opened."""
        for client in self._clients:
            client.close()


def _state(ctx: typer.Context) -> State:
    """The invocation's `State`, set by the root callback."""
    return cast(State, ctx.find_root().obj)


def _version(value: bool) -> None:
    """Print the version and stop."""
    if value:
        typer.echo(f"standupless {__version__}")
        raise typer.Exit()


@app.callback()
def root(
    ctx: typer.Context,
    env: Annotated[
        str | None, typer.Option("--env", help="Target environment: prod or staging. Env: STANDUPLESS_ENV.")
    ] = None,
    base_url: Annotated[
        str | None, typer.Option("--base-url", help="API base URL, overriding --env. Env: STANDUPLESS_BASE_URL.")
    ] = None,
    workspace: Annotated[
        str | None,
        typer.Option("--workspace", "-w", help="Workspace id, slug or name. Env: STANDUPLESS_WORKSPACE."),
    ] = None,
    version: Annotated[
        bool, typer.Option("--version", callback=_version, is_eager=True, help="Show the version and exit.")
    ] = False,
) -> None:
    """Standupless from the terminal. Log in once with `standupless auth login`."""
    state = State(env=env, base_url=base_url, workspace=workspace)
    ctx.obj = state
    ctx.call_on_close(state.close)


JsonFlag = Annotated[bool, typer.Option("--json", help="Print the API's JSON instead of a table.")]


def _read_body(body: str | None, body_file: Path | None) -> str | None:
    """A body from `--body`, or from `--body-file`, where `-` means stdin."""
    if body is not None and body_file is not None:
        raise ConfigError("Pass --body or --body-file, not both.")
    if body_file is None:
        return body
    if str(body_file) == "-":
        return sys.stdin.read()
    return body_file.read_text()


def _open(url: str) -> None:
    """Open a URL in the browser, saying where in case no browser is available."""
    output.success(f"Opening {url} in your browser.")
    webbrowser.open(url)


@auth_app.command("login")
def auth_login(
    ctx: typer.Context,
    with_token: Annotated[bool, typer.Option("--with-token", help="Read the API key from stdin.")] = False,
) -> None:
    """Store an API key in the OS keyring and remember its workspace.

    Create a key in the web app under Settings, API keys. The environment named by
    --env or --base-url becomes the default for later commands.
    """
    state = _state(ctx)
    settings = state.settings()
    if with_token:
        api_key = sys.stdin.read().strip()
    else:
        api_key = typer.prompt(f"API key for {settings.base_url}", hide_input=True).strip()
    if not api_key.startswith(KEY_PREFIX):
        raise ConfigError(f"That does not look like a Standupless API key; keys start with {KEY_PREFIX}.")
    context = Context(settings, state.client(api_key))
    workspace = context.workspace if settings.workspace else context.bound_workspace()
    context.use_workspace(workspace)
    values: dict[str, Any] = {"workspace_id": workspace["id"], "workspace_slug": workspace["slug"]}
    try:
        values["user_id"] = context.my_user_id()
    except (ResolveError, ApiError):
        pass
    write_keyring(settings.base_url, api_key)
    path = remember_host(settings.base_url, values)
    output.success(f"Logged in to {workspace['name']} ({workspace['slug']}) on {settings.base_url}.")
    output.success(f"Settings saved to {path}.")


@auth_app.command("logout")
def auth_logout(ctx: typer.Context) -> None:
    """Remove the stored key and remembered workspace for the current environment."""
    settings = _state(ctx).settings()
    removed = delete_keyring(settings.base_url)
    forget_host(settings.base_url)
    output.success(f"Logged out of {settings.base_url}." if removed else f"No stored key for {settings.base_url}.")


@auth_app.command("status")
def auth_status(ctx: typer.Context, as_json: JsonFlag = False) -> None:
    """Show which environment, key and workspace commands will use, and check the key works."""
    state = _state(ctx)
    settings = state.settings()
    source = "STANDUPLESS_API_KEY" if settings.api_key_env else ("keyring" if read_keyring(settings.base_url) else None)
    report: dict[str, Any] = {"base_url": settings.base_url, "web_url": settings.web_url, "key_source": source}
    if source:
        workspace = state.context().workspace
        report["workspace"] = {"id": workspace["id"], "slug": workspace["slug"], "name": workspace["name"]}
    if as_json:
        output.print_json(report)
        return
    output.console.print(f"API       {settings.base_url}", highlight=False)
    output.console.print(f"Web       {settings.web_url}", highlight=False)
    output.console.print(f"Key       {source or 'not logged in'}", highlight=False)
    if "workspace" in report:
        output.console.print(
            f"Workspace {report['workspace']['name']} ({report['workspace']['slug']})", highlight=False
        )
    if not source:
        raise typer.Exit(1)


@issue_app.command("list")
def issue_list(
    ctx: typer.Context,
    team: Annotated[str | None, typer.Option("--team", "-t", help="Team key prefix, name or id.")] = None,
    assignee: Annotated[
        str | None, typer.Option("--assignee", "-a", help="`me`, `none`, an email, a name or a user id.")
    ] = None,
    creator: Annotated[str | None, typer.Option("--creator", help="`me`, an email, a name or a user id.")] = None,
    status: Annotated[
        list[str] | None, typer.Option("--status", "-s", help="Status name or category; repeat for several.")
    ] = None,
    label: Annotated[list[str] | None, typer.Option("--label", "-l", help="Label name; repeat for several.")] = None,
    cycle: Annotated[str | None, typer.Option("--cycle", "-c", help="`current`, `none`, a name or an id.")] = None,
    project: Annotated[str | None, typer.Option("--project", "-p", help="Project name, id or `none`.")] = None,
    priority: Annotated[list[Priority] | None, typer.Option("--priority", help="Repeat for several.")] = None,
    search: Annotated[str | None, typer.Option("--search", "-q", help="Match text in the key or title.")] = None,
    include_closed: Annotated[bool, typer.Option("--all", help="Include completed and cancelled issues.")] = False,
    sort: Annotated[
        str, typer.Option("--sort", help="updated_desc, created_desc, key_asc, priority_desc or due_asc.")
    ] = "updated_desc",
    limit: Annotated[int, typer.Option("--limit", "-L", min=1, help="Most issues to fetch.")] = 50,
    as_json: JsonFlag = False,
) -> None:
    """List issues. Without --status or --all, only open issues are shown."""
    context = _state(ctx).context()
    teams = context.scoped_teams(team)
    params: dict[str, Any] = {"sort": sort}
    if team:
        params["team_id"] = teams[0]["id"]
    if assignee:
        params["assignee_id"] = [context.user_filter(assignee)]
    if creator:
        params["creator_id"] = [context.user_filter(creator)]
    if status:
        categories, ids = context.status_filter(teams, status)
        if categories:
            params["status_category"] = categories
        if ids:
            params["status_id"] = ids
    elif not include_closed:
        params["status_category"] = list(OPEN_CATEGORIES)
    if label:
        params["label_id"] = context.label_ids(teams, label)
    if cycle:
        params["cycle_id"] = context.cycle_ids(teams, cycle)
    if project:
        params["project_id"] = [context.project_filter(project)]
    if priority:
        params["priority"] = [item.value for item in priority]
    if search:
        params["q"] = search
    issues = context.client.list_issues(context.workspace_id, params, limit=limit)
    if as_json:
        output.print_json(issues)
        return
    statuses: dict[str, str] = {}
    for team_id in {issue["team_id"] for issue in issues}:
        statuses.update(context.status_names(team_id))
    output.table(
        ["ID", "STATUS", "PRIORITY", "ASSIGNEE", "TITLE"],
        output.issue_rows(issues, statuses, context.member_names() if issues else {}),
        "No issues match.",
    )


def _describe(context: Context, issue: Issue, comments: list[CommentRead]) -> None:
    """Print one issue with its names resolved."""
    team_id = issue["team_id"]
    labels = {label["id"]: label["name"] for label in context.labels(team_id)}
    cycle_name = None
    if issue.get("cycle_id"):
        cycle_name = next(
            (c["name"] for c in context.cycles(team_id) if c["cycle_id"] == issue.get("cycle_id")),
            issue.get("cycle_id"),
        )
    project_name = None
    if issue.get("project_id"):
        project_name = next(
            (p["name"] for p in context.projects() if p["project_id"] == issue.get("project_id")),
            issue.get("project_id"),
        )
    people = context.member_names()
    assignee_id = issue.get("assignee_id") or ""
    output.issue_detail(
        issue,
        status=context.status_names(team_id).get(issue["status_id"], issue["status_id"]),
        assignee=people.get(assignee_id, assignee_id),
        labels=[labels.get(label_id, label_id) for label_id in issue.get("label_ids", [])],
        cycle=cycle_name,
        project=project_name,
        url=context.issue_url(issue["key"]),
        comments=comments,
    )


@issue_app.command("view")
def issue_view(
    ctx: typer.Context,
    key: Annotated[str, typer.Argument(help="Issue key, such as ENG-12.")],
    web: Annotated[bool, typer.Option("--web", help="Open the issue in the browser.")] = False,
    comments: Annotated[bool, typer.Option("--comments", help="Include the comments.")] = False,
    as_json: JsonFlag = False,
) -> None:
    """Show an issue, or open it in the browser with --web."""
    context = _state(ctx).context()
    if web:
        _open(context.issue_url(key))
        return
    issue = context.issue(key)
    thread = context.client.list_comments(context.workspace_id, issue["id"]) if comments else []
    if as_json:
        output.print_json({**issue, "comments": thread} if comments else issue)
        return
    _describe(context, issue, thread)


def _assignee_id(context: Context, assignee: str) -> str | None:
    """An assignee for a write, where `none` clears it and the server resolves `me`."""
    choice = assignee.strip().casefold()
    if choice == "none":
        return None
    return "me" if choice == "me" else context.user_id(assignee)


@issue_app.command("create")
def issue_create(
    ctx: typer.Context,
    title: Annotated[str | None, typer.Option("--title", help="Issue title; prompted for when left out.")] = None,
    team: Annotated[
        str | None, typer.Option("--team", "-t", help="Team key prefix, name or id; needed with several teams.")
    ] = None,
    body: Annotated[str | None, typer.Option("--body", "-b", help="Description in Markdown.")] = None,
    body_file: Annotated[
        Path | None, typer.Option("--body-file", "-F", help="Read the description from a file, or - for stdin.")
    ] = None,
    assignee: Annotated[str | None, typer.Option("--assignee", "-a", help="`me`, an email, a name or an id.")] = None,
    status: Annotated[str | None, typer.Option("--status", "-s", help="Status name or category.")] = None,
    label: Annotated[list[str] | None, typer.Option("--label", "-l", help="Label name; repeat for several.")] = None,
    priority: Annotated[Priority | None, typer.Option("--priority")] = None,
    cycle: Annotated[str | None, typer.Option("--cycle", "-c", help="`current`, a name or an id.")] = None,
    project: Annotated[str | None, typer.Option("--project", "-p", help="Project name or id.")] = None,
    estimate: Annotated[str | None, typer.Option("--estimate", help="Estimate on the team's scale.")] = None,
    due: Annotated[str | None, typer.Option("--due", help="Due date, YYYY-MM-DD.")] = None,
    parent: Annotated[str | None, typer.Option("--parent", help="Parent issue key.")] = None,
    web: Annotated[bool, typer.Option("--web", help="Open the new issue in the browser.")] = False,
    as_json: JsonFlag = False,
) -> None:
    """Create an issue and print its key."""
    context = _state(ctx).context()
    if team:
        chosen = context.team(team)
    else:
        teams = context.teams()
        if len(teams) != 1:
            raise ConfigError("This workspace has several teams; pass --team.")
        chosen = teams[0]
    text = _read_body(body, body_file)
    if title is None:
        title = typer.prompt("Title")
    team_id = chosen["id"]
    assignee_id = _assignee_id(context, assignee) if assignee else None
    payload = compact(
        {
            "team_id": team_id,
            "title": title,
            "body": text,
            "assignee_id": assignee_id,
            "status_id": context.status_id(team_id, status) if status else None,
            "label_ids": context.label_ids([chosen], label) if label else None,
            "priority": priority.value if priority else None,
            "cycle_id": context.cycle_id(team_id, cycle) if cycle else None,
            "project_id": context.project(project)["project_id"] if project else None,
            "estimate": estimate,
            "due_date": due,
            "parent_id": context.issue(parent)["id"] if parent else None,
        }
    )
    created = context.client.create_issue(context.workspace_id, cast(IssueCreate, payload))
    if as_json:
        output.print_json(created)
    else:
        output.success(f"Created {created['key']}: {created['title']}")
        typer.echo(context.issue_url(created["key"]))
    if web:
        _open(context.issue_url(created["key"]))


@issue_app.command("edit")
def issue_edit(
    ctx: typer.Context,
    key: Annotated[str, typer.Argument(help="Issue key, such as ENG-12.")],
    title: Annotated[str | None, typer.Option("--title", help="New title.")] = None,
    body: Annotated[str | None, typer.Option("--body", "-b", help="New description in Markdown.")] = None,
    body_file: Annotated[
        Path | None, typer.Option("--body-file", "-F", help="Read the description from a file, or - for stdin.")
    ] = None,
    assignee: Annotated[
        str | None, typer.Option("--assignee", "-a", help="`me`, `none`, an email, a name or an id.")
    ] = None,
    status: Annotated[str | None, typer.Option("--status", "-s", help="Status name or category.")] = None,
    add_label: Annotated[list[str] | None, typer.Option("--add-label", help="Label to add; repeatable.")] = None,
    remove_label: Annotated[
        list[str] | None, typer.Option("--remove-label", help="Label to remove; repeatable.")
    ] = None,
    priority: Annotated[Priority | None, typer.Option("--priority")] = None,
    cycle: Annotated[str | None, typer.Option("--cycle", "-c", help="`current`, `none`, a name or an id.")] = None,
    project: Annotated[str | None, typer.Option("--project", "-p", help="Project name, id or `none`.")] = None,
    estimate: Annotated[str | None, typer.Option("--estimate", help="Estimate, or `none` to clear.")] = None,
    due: Annotated[str | None, typer.Option("--due", help="Due date YYYY-MM-DD, or `none` to clear.")] = None,
    as_json: JsonFlag = False,
) -> None:
    """Change an issue's fields; only the options given are touched."""
    context = _state(ctx).context()
    issue = context.issue(key)
    team_id = issue["team_id"]
    team = context.team_by_id(team_id) or context.team(key.split("-")[0])
    patch: dict[str, Any] = {}
    if title is not None:
        patch["title"] = title
    text = _read_body(body, body_file)
    if text is not None:
        patch["body"] = text
    if assignee is not None:
        patch["assignee_id"] = _assignee_id(context, assignee)
    if status is not None:
        patch["status_id"] = context.status_id(team_id, status)
    if add_label or remove_label:
        current = list(issue.get("label_ids", []))
        adding = context.label_ids([team], add_label or [])
        removing = set(context.label_ids([team], remove_label or []))
        patch["label_ids"] = [lid for lid in dict.fromkeys([*current, *adding]) if lid not in removing]
    if priority is not None:
        patch["priority"] = priority.value
    if cycle is not None:
        patch["cycle_id"] = None if cycle.strip().casefold() == "none" else context.cycle_id(team_id, cycle)
    if project is not None:
        patch["project_id"] = None if project.strip().casefold() == "none" else context.project(project)["project_id"]
    if estimate is not None:
        patch["estimate"] = None if estimate.strip().casefold() == "none" else estimate
    if due is not None:
        patch["due_date"] = None if due.strip().casefold() == "none" else due
    if not patch:
        raise ConfigError("Nothing to change; pass at least one option. See `standupless issue edit --help`.")
    updated = context.client.update_issue(context.workspace_id, issue["id"], cast(IssueUpdate, patch))
    if as_json:
        output.print_json(updated)
        return
    output.success(f"Updated {updated['key']}.")


def _move_to_category(context: Context, key: str, category: str) -> Issue:
    """Move an issue to the first status, in board order, of a category."""
    issue = context.issue(key)
    team_id = issue["team_id"]
    target = next((s for s in context.statuses(team_id) if s["category"] == category), None)
    if target is None:
        raise ResolveError(f"The team has no {category} status.")
    return context.client.update_issue(context.workspace_id, issue["id"], {"status_id": target["id"]})


@issue_app.command("close")
def issue_close(
    ctx: typer.Context,
    key: Annotated[str, typer.Argument(help="Issue key, such as ENG-12.")],
    reason: Annotated[
        CloseReason, typer.Option("--reason", "-r", help="completed, or canceled when the work was dropped.")
    ] = CloseReason.completed,
    comment: Annotated[str | None, typer.Option("--comment", "-m", help="Leave a closing comment.")] = None,
    as_json: JsonFlag = False,
) -> None:
    """Close an issue by moving it to the team's first completed or cancelled status."""
    context = _state(ctx).context()
    category = "completed" if reason is CloseReason.completed else "cancelled"
    updated = _move_to_category(context, key, category)
    if comment:
        context.client.create_comment(context.workspace_id, updated["id"], {"body": comment})
    if as_json:
        output.print_json(updated)
        return
    status = context.status_names(updated["team_id"]).get(updated["status_id"], category)
    output.success(f"Closed {updated['key']} as {status}.")


@issue_app.command("reopen")
def issue_reopen(
    ctx: typer.Context,
    key: Annotated[str, typer.Argument(help="Issue key, such as ENG-12.")],
    as_json: JsonFlag = False,
) -> None:
    """Reopen an issue by moving it to the team's first unstarted status."""
    context = _state(ctx).context()
    updated = _move_to_category(context, key, "unstarted")
    if as_json:
        output.print_json(updated)
        return
    status = context.status_names(updated["team_id"]).get(updated["status_id"], "unstarted")
    output.success(f"Reopened {updated['key']} as {status}.")


@issue_app.command("comment")
def issue_comment(
    ctx: typer.Context,
    key: Annotated[str, typer.Argument(help="Issue key, such as ENG-12.")],
    body: Annotated[str | None, typer.Option("--body", "-b", help="Comment in Markdown.")] = None,
    body_file: Annotated[
        Path | None, typer.Option("--body-file", "-F", help="Read the comment from a file, or - for stdin.")
    ] = None,
    as_json: JsonFlag = False,
) -> None:
    """Add a comment to an issue."""
    context = _state(ctx).context()
    text = _read_body(body, body_file)
    if text is None:
        text = typer.prompt("Comment")
    if not text.strip():
        raise ConfigError("A comment needs a body.")
    issue = context.issue(key)
    created = context.client.create_comment(context.workspace_id, issue["id"], {"body": text})
    if as_json:
        output.print_json(created)
        return
    output.success(f"Commented on {issue['key']}.")


@issue_app.command("branch")
def issue_branch(
    ctx: typer.Context,
    key: Annotated[str, typer.Argument(help="Issue key, such as ENG-12.")],
) -> None:
    """Print the git branch name for an issue, the same one the web app suggests.

    Try `git switch -c "$(standupless issue branch ENG-12)"`.
    """
    context = _state(ctx).context()
    issue = context.issue(key)
    typer.echo(branch_name(issue["key"], issue["title"]))


@team_app.command("list")
def team_list(ctx: typer.Context, as_json: JsonFlag = False) -> None:
    """List the workspace's teams."""
    context = _state(ctx).context()
    teams = context.teams()
    if as_json:
        output.print_json(teams)
        return
    output.table(
        ["KEY", "NAME", "MEMBERS", "ID"],
        [[t["key_prefix"], t["name"], t.get("member_count", ""), t["id"]] for t in teams],
        "No teams yet.",
    )


def _cycle_rows(context: Context, cycles: list[Any]) -> list[list[Any]]:
    """Table rows for cycles, with the team's key and issue counts."""
    rows = []
    for cycle in cycles:
        team = context.team_by_id(cycle["team_id"])
        counts = cycle.get("counts") or {}
        progress = f"{counts.get('done', 0)}/{counts.get('total', 0)}"
        rows.append(
            [
                team["key_prefix"] if team else "",
                cycle["name"],
                cycle["status"],
                cycle["start_date"],
                cycle["end_date"],
                progress,
            ]
        )
    return rows


CYCLE_COLUMNS = ["TEAM", "NAME", "STATUS", "START", "END", "DONE"]


@cycle_app.command("list")
def cycle_list(
    ctx: typer.Context,
    team: Annotated[str | None, typer.Option("--team", "-t", help="Team key prefix, name or id.")] = None,
    status: Annotated[CycleStatus | None, typer.Option("--status", help="Only cycles in this status.")] = None,
    as_json: JsonFlag = False,
) -> None:
    """List cycles, for one team or every team."""
    context = _state(ctx).context()
    cycles = [
        cycle
        for chosen in context.scoped_teams(team)
        for cycle in context.cycles(chosen["id"], status=status.value if status else None)
    ]
    if as_json:
        output.print_json(cycles)
        return
    output.table(CYCLE_COLUMNS, _cycle_rows(context, cycles), "No cycles.")


@cycle_app.command("current")
def cycle_current(
    ctx: typer.Context,
    team: Annotated[str | None, typer.Option("--team", "-t", help="Team key prefix, name or id.")] = None,
    as_json: JsonFlag = False,
) -> None:
    """Show the active cycle, for one team or every team."""
    context = _state(ctx).context()
    cycles = [cycle for chosen in context.scoped_teams(team) if (cycle := context.current_cycle(chosen["id"]))]
    if as_json:
        output.print_json(cycles[0] if team and cycles else (None if team else cycles))
        return
    output.table(CYCLE_COLUMNS, _cycle_rows(context, cycles), "No active cycle.")


@project_app.command("list")
def project_list(
    ctx: typer.Context,
    team: Annotated[str | None, typer.Option("--team", "-t", help="Team key prefix, name or id.")] = None,
    status: Annotated[ProjectStatus | None, typer.Option("--status", help="Only projects in this status.")] = None,
    as_json: JsonFlag = False,
) -> None:
    """List projects in the workspace."""
    context = _state(ctx).context()
    team_id = context.team(team)["id"] if team else None
    projects = context.client.list_projects(
        context.workspace_id, team_id=team_id, status=status.value if status else None
    )
    if as_json:
        output.print_json(projects)
        return
    people = context.member_names() if projects else {}
    rows = []
    for project in projects:
        counts = project.get("counts") or {}
        lead = project.get("lead_id") or ""
        rows.append(
            [
                project["name"],
                project["status"],
                people.get(lead, lead),
                project.get("target_date") or "",
                f"{counts.get('done', 0)}/{counts.get('total', 0)}",
                project["project_id"],
            ]
        )
    output.table(["NAME", "STATUS", "LEAD", "TARGET", "DONE", "ID"], rows, "No projects.")


@project_app.command("view")
def project_view(
    ctx: typer.Context,
    project: Annotated[str, typer.Argument(help="Project name or id.")],
    web: Annotated[bool, typer.Option("--web", help="Open the project in the browser.")] = False,
    as_json: JsonFlag = False,
) -> None:
    """Show a project, or open it in the browser with --web."""
    context = _state(ctx).context()
    found = context.client.get_project(context.workspace_id, context.project(project)["project_id"])
    url = context.project_url(found["project_id"])
    if web:
        _open(url)
        return
    if as_json:
        output.print_json(found)
        return
    people = context.member_names()
    counts = found.get("counts") or {}
    teams = [t["key_prefix"] for tid in found["team_ids"] if (t := context.team_by_id(tid))]
    lead = found.get("lead_id") or ""
    output.console.print(f"[bold]{found['name']}[/bold]", highlight=False)
    fields = [
        ("Status", found["status"]),
        ("Health", found.get("health") or ""),
        ("Lead", people.get(lead, lead)),
        ("Teams", ", ".join(teams)),
        ("Start", found.get("start_date") or ""),
        ("Target", found.get("target_date") or ""),
        ("Progress", f"{counts.get('done', 0)} of {counts.get('total', 0)} done"),
    ]
    for name, value in fields:
        if value:
            output.console.print(f"[dim]{name:<9}[/dim] {value}", highlight=False)
    if found.get("description"):
        output.console.print()
        output.console.print(output.Markdown(found.get("description") or ""))
    output.console.print()
    output.console.print(f"[dim]{url}[/dim]", highlight=False)


def run() -> None:
    """Console script entry point."""
    app()
