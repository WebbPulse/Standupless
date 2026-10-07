"""The `standupless` command: issues, teams, cycles and projects from the terminal.

The command surface is curated rather than one command per endpoint, shaped after
`gh` and the Linear CLI: nouns, then verbs, names instead of ids, a table by default
and `--json` for scripts.
"""

from __future__ import annotations

import sys
import webbrowser
from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Annotated, Any, cast, get_args, get_type_hints

import typer
from typer.core import TyperGroup

from standupless_cli import __version__, output
from standupless_cli._generated.models import (
    CommentRead,
    CycleSettingsUpdate,
    IssueCreate,
    IssueUpdate,
    LabelCreate,
    LabelRead,
    LabelUpdate,
    OverrideUpdate,
    StatusCreate,
    StatusRead,
    StatusUpdate,
    TeamRead,
    TeamUpdate,
    ViewRead,
    WorkspaceUpdate,
)
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
status_app = typer.Typer(
    help="Workflow statuses: the workspace set every team inherits, and each team's own.", no_args_is_help=True
)
label_app = typer.Typer(
    help="Labels: the workspace set every team inherits, and each team's own.", no_args_is_help=True
)
workspace_app = typer.Typer(help="The workspace's own settings.", no_args_is_help=True)
app.add_typer(auth_app, name="auth")
app.add_typer(issue_app, name="issue")
app.add_typer(team_app, name="team")
app.add_typer(cycle_app, name="cycle")
app.add_typer(project_app, name="project")
app.add_typer(status_app, name="status")
app.add_typer(label_app, name="label")
app.add_typer(workspace_app, name="workspace")


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


def _choices(field_name: str) -> list[str]:
    """The values a status field allows, read from the generated models so the CLI tracks the API."""
    pending: list[Any] = [get_type_hints(StatusCreate)[field_name]]
    values: list[str] = []
    while pending:
        hint = pending.pop(0)
        if isinstance(hint, str):
            values.append(hint)
        else:
            pending.extend(get_args(hint))
    return values


STATUS_CATEGORIES = _choices("category")
STATUS_COLORS = _choices("color")
STATUS_ICONS = _choices("icon")
RESET = "default"
CATEGORY_HELP = f"One of {', '.join(STATUS_CATEGORIES)}."
COLOR_HELP = f"A palette color: {', '.join(STATUS_COLORS)}."
ICON_HELP = (
    "An icon of the status's category. backlog: dashed, dotted, question; unstarted: circle, circle_dot; "
    "started: progress, quarter, half, three_quarters, paused, blocked; completed: check, check_outline; "
    "cancelled: cross, cross_outline, duplicate."
)


def _one_of(allowed: list[str]) -> Any:
    """An option callback holding a value to a fixed set, naming the set when it is not in it."""

    def check(value: str | None) -> str | None:
        """Pass an allowed or absent value through, or fail the option."""
        if value is not None and value not in allowed:
            raise typer.BadParameter(f"{value!r} is not one of {', '.join(allowed)}.")
        return value

    return check


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
        str | None, typer.Option("--env", hidden=True, help="Named environment. Env: STANDUPLESS_ENV.")
    ] = None,
    base_url: Annotated[
        str | None, typer.Option("--base-url", help="API base URL, when not production. Env: STANDUPLESS_BASE_URL.")
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

    Create a key in the web app under Settings, API keys. The API named by
    --base-url becomes the default for later commands.
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


def _issue_filters(
    context: Context,
    teams: list[TeamRead],
    *,
    team: str | None,
    assignee: str | None,
    creator: str | None,
    status: list[str] | None,
    label: list[str] | None,
    cycle: str | None,
    project: str | None,
    priority: list[Priority] | None,
    search: str | None,
    include_closed: bool,
) -> dict[str, Any]:
    """The issue list query params for the shared filter options of `issue list` and `issue export`."""
    params: dict[str, Any] = {}
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
    return params


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
    params = _issue_filters(
        context,
        teams,
        team=team,
        assignee=assignee,
        creator=creator,
        status=status,
        label=label,
        cycle=cycle,
        project=project,
        priority=priority,
        search=search,
        include_closed=include_closed,
    )
    params["sort"] = sort
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


@issue_app.command("export")
def issue_export(
    ctx: typer.Context,
    team: Annotated[str | None, typer.Option("--team", "-t", help="Team key prefix, name or id.")] = None,
    view: Annotated[
        str | None, typer.Option("--view", "-V", help="Saved view name or id; exports what it shows.")
    ] = None,
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
    open_only: Annotated[bool, typer.Option("--open", help="Only backlog, unstarted and started issues.")] = False,
    archived: Annotated[bool, typer.Option("--archived", help="Include archived issues.")] = False,
    out: Annotated[Path | None, typer.Option("--output", "-o", help="Write the CSV here instead of stdout.")] = None,
) -> None:
    """Export issues as CSV, every status unless --open or --status narrows it.

    Without --team or --view the export spans every team you can see. --view starts
    from the saved view's own filters, and any other option given narrows them further.
    """
    context = _state(ctx).context()
    params: dict[str, Any] = {}
    if view:
        params.update(_view_params(_find_view(context, view)))
    if team or not params.get("team_id"):
        teams = context.scoped_teams(team)
    else:
        teams = [context.team(str(params["team_id"]))]
    params.update(
        _issue_filters(
            context,
            teams,
            team=team,
            assignee=assignee,
            creator=creator,
            status=status,
            label=label,
            cycle=cycle,
            project=project,
            priority=priority,
            search=search,
            include_closed=not open_only,
        )
    )
    if archived:
        params["include_archived"] = True
    pages = context.client.export_issues(context.workspace_id, params)
    if out is None:
        for page in pages:
            sys.stdout.write(page)
        return
    with out.open("w", encoding="utf-8", newline="") as handle:
        for page in pages:
            handle.write(page)
    typer.echo(f"Wrote {out}.", err=True)


def _find_view(context: Context, ref: str) -> ViewRead:
    """One saved view the caller may read, by id or by name."""
    views = context.client.list_views(context.workspace_id)
    for view in views:
        if ref == view["view_id"]:
            return view
    wanted = ref.strip().casefold()
    matches = [view for view in views if view["name"].strip().casefold() == wanted]
    if len(matches) == 1:
        return matches[0]
    if matches:
        raise ResolveError(f"Several views are named {ref!r}; use the view id.")
    raise ResolveError(f"No saved view matches {ref!r}.")


def _view_params(view: ViewRead) -> dict[str, Any]:
    """The issue list query a saved view runs: its filter, its team and its archive setting."""
    params: dict[str, Any] = {
        key: value for key, value in (view.get("filter") or {}).items() if value not in (None, "", [])
    }
    params.pop("sort", None)
    team_id = view.get("team_id")
    if team_id:
        params["team_id"] = team_id
    if view.get("show_archived"):
        params["include_archived"] = True
    return params


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


@issue_app.command("move")
def issue_move(
    ctx: typer.Context,
    key: Annotated[str, typer.Argument(help="Issue key, such as ENG-12.")],
    team: Annotated[str, typer.Option("--team", "-t", help="The team to move it to: key prefix, name or id.")],
    as_json: JsonFlag = False,
) -> None:
    """Move an issue to another team. It gets that team's next key, and the old key keeps working."""
    context = _state(ctx).context()
    issue = context.issue(key)
    target = context.team(team)
    moved = context.client.move_issue(context.workspace_id, issue["id"], target["id"])
    if as_json:
        output.print_json(moved)
        return
    if moved["key"] == issue["key"]:
        output.success(f"{issue['key']} is already in {target['name']}.")
        return
    output.success(f"Moved {issue['key']} to {target['name']} as {moved['key']}.")


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
        ["KEY", "NAME", "MEMBERS", "PRIVATE", "ID"],
        [
            [t["key_prefix"], t["name"], t.get("member_count", ""), "yes" if t.get("private") else "", t["id"]]
            for t in teams
        ],
        "No teams yet.",
    )


TeamOption = Annotated[str, typer.Option("--team", "-t", help="Team key prefix, name or id.")]


@team_app.command("update")
def team_update(
    ctx: typer.Context,
    team: TeamOption,
    sync_pr_labels: Annotated[
        bool | None,
        typer.Option(
            "--sync-pr-labels/--no-sync-pr-labels",
            help="Whether linked pull requests carry the labels of this team's issues.",
        ),
    ] = None,
    private: Annotated[
        bool | None,
        typer.Option(
            "--private/--public",
            help="Make the team private to its members, or open to the workspace. Private needs the Business plan.",
        ),
    ] = None,
    as_json: JsonFlag = False,
) -> None:
    """Change a team's settings. Needs team admin."""
    body: TeamUpdate = {}
    if sync_pr_labels is not None:
        body["sync_pr_labels"] = sync_pr_labels
    if private is not None:
        body["private"] = private
    if not body:
        raise ConfigError("Nothing to change. Pass --sync-pr-labels, --no-sync-pr-labels, --private or --public.")
    context = _state(ctx).context()
    found = context.team(team)
    updated = context.client.update_team(context.workspace_id, found["id"], body)
    if as_json:
        output.print_json(updated)
        return
    if sync_pr_labels is not None:
        state = "on" if updated.get("sync_pr_labels", True) else "off"
        output.success(f"Pull request label sync is {state} for {updated['key_prefix']}.")
    if private is not None:
        visibility = "private" if updated.get("private", False) else "open"
        output.success(f"{updated['key_prefix']} is now {visibility}.")


PUBLIC_TWO_WAY_WARNING = (
    "Two way sync is allowed on a public repository: this team's issues, comments and labels are written "
    "to GitHub where anyone can read them."
)


def _sync_line(link: Mapping[str, Any]) -> str:
    """One team sync link as a sentence."""
    direction = "both ways" if link.get("direction") == "two_way" else "GitHub to Standupless only"
    state = "on" if link.get("enabled", True) else "paused"
    visibility = "private" if link.get("repository_private", True) else "public"
    allowed = ", two way allowed on public" if link.get("allow_public_two_way") else ""
    return f"Syncs {direction} with {link['full_name']} ({visibility}{allowed}), {state}."


@team_app.command("sync")
def team_sync(
    ctx: typer.Context,
    team: TeamOption,
    repository: Annotated[str | None, typer.Option("--repository", "-r", help="Repository id to sync with.")] = None,
    direction: Annotated[
        str | None, typer.Option("--direction", "-d", help="two_way or github_to_standupless.")
    ] = None,
    enabled: Annotated[bool | None, typer.Option("--on/--pause", help="Run or pause the sync.")] = None,
    sync_labels: Annotated[
        bool | None, typer.Option("--sync-labels/--no-sync-labels", help="Whether labels follow between sides.")
    ] = None,
    allow_public_two_way: Annotated[
        bool | None,
        typer.Option(
            "--allow-public-two-way/--no-allow-public-two-way",
            help="Allow two way sync on a public repository, publishing this team's issues there.",
        ),
    ] = None,
    as_json: JsonFlag = False,
) -> None:
    """Show the team's GitHub issue sync, or change it keeping every setting not given. Needs team admin to change."""
    if direction is not None and direction not in ("two_way", "github_to_standupless"):
        raise ConfigError("--direction is two_way or github_to_standupless.")
    context = _state(ctx).context()
    found = context.team(team)
    current = context.client.get_team_sync(context.workspace_id, found["id"])
    changes: dict[str, Any] = {
        name: value
        for name, value in (
            ("direction", direction),
            ("enabled", enabled),
            ("sync_labels", sync_labels),
            ("allow_public_two_way", allow_public_two_way),
        )
        if value is not None
    }
    if repository is None and not changes:
        if as_json:
            output.print_json(current)
            return
        if current is None:
            output.success(f"{found['key_prefix']} does not sync with GitHub.")
            return
        output.success(_sync_line(current))
        return
    body: dict[str, Any] = {}
    if current is not None:
        body = {
            "repository_id": current["repository_id"],
            "direction": current["direction"],
            "enabled": current["enabled"],
            "sync_labels": current["sync_labels"],
            "allow_public_two_way": current.get("allow_public_two_way", False),
        }
    if repository is not None:
        body["repository_id"] = repository
    if "repository_id" not in body:
        raise ConfigError(f"{found['key_prefix']} does not sync yet. Pass --repository.")
    body.update(changes)
    updated = context.client.put_team_sync(context.workspace_id, found["id"], cast(Any, body))
    if as_json:
        output.print_json(updated)
        return
    if updated.get("allow_public_two_way") and not updated.get("repository_private", True):
        output.error(PUBLIC_TWO_WAY_WARNING)
    output.success(_sync_line(updated))


@workspace_app.command("view")
def workspace_view(ctx: typer.Context, as_json: JsonFlag = False) -> None:
    """Show the workspace's name, slug, plan and accent color."""
    context = _state(ctx).context()
    found = context.client.get_workspace(context.workspace_id)
    if as_json:
        output.print_json(found)
        return
    output.table(
        ["NAME", "SLUG", "PLAN", "ACCENT", "ID"],
        [[found["name"], found["slug"], found["plan"], found.get("accent_color") or "default", found["id"]]],
        "No workspace.",
    )


@workspace_app.command("update")
def workspace_update(
    ctx: typer.Context,
    name: Annotated[str | None, typer.Option("--name", help="A new workspace name.")] = None,
    accent_color: Annotated[
        str | None, typer.Option("--accent-color", help="The accent color as #rrggbb, applied for every member.")
    ] = None,
    reset_accent: Annotated[
        bool, typer.Option("--reset-accent", help="Return the accent to the Standupless default.")
    ] = False,
    as_json: JsonFlag = False,
) -> None:
    """Rename the workspace or change its accent color. Needs workspace admin."""
    if accent_color is not None and reset_accent:
        raise ConfigError("Pass --accent-color or --reset-accent, not both.")
    patch: dict[str, Any] = {}
    if name is not None:
        patch["name"] = name
    if accent_color is not None:
        patch["accent_color"] = accent_color
    if reset_accent:
        patch["accent_color"] = None
    if not patch:
        raise ConfigError("Nothing to change. Pass --name, --accent-color or --reset-accent.")
    context = _state(ctx).context()
    updated = context.client.update_workspace(context.workspace_id, cast(WorkspaceUpdate, patch))
    if as_json:
        output.print_json(updated)
        return
    output.success(f"Updated {updated['name']}; accent is {updated.get('accent_color') or 'the default'}.")


OptionalTeam = Annotated[
    str | None, typer.Option("--team", "-t", help="Team key prefix, name or id. Omit with --shared.")
]
SharedFlag = Annotated[
    bool,
    typer.Option("--shared", help="Act on the workspace set every team inherits. Needs workspace admin to change."),
]
HiddenFlag = Annotated[bool, typer.Option("--include-hidden", help="Also list inherited records the team hides.")]


def _scope_team(context: Context, team: str | None, shared: bool) -> str | None:
    """The team id a command acts on, or None for the workspace set; exactly one of the two must be named."""
    if shared and team:
        raise ConfigError("Pass either --team or --shared, not both.")
    if not shared and not team:
        raise ConfigError("Pass --team for a team, or --shared for the workspace set.")
    return context.team(team)["id"] if team else None


def _display_name(record: StatusRead | LabelRead) -> str:
    """A record's name, with the workspace name beside a team rename."""
    inherited = record.get("inherited_name")
    return f"{record['name']} ({inherited})" if inherited else record["name"]


def _scope_cell(record: StatusRead | LabelRead) -> str:
    """Where a record lives, and whether the team hides it."""
    scope = record.get("scope") or "team"
    return f"{scope}, hidden" if record.get("hidden") else scope


def _status_rows(statuses: list[StatusRead]) -> list[list[Any]]:
    """Table rows for statuses, with `default` where no color or icon was chosen."""
    return [
        [_display_name(s), s["category"], s.get("color") or RESET, s.get("icon") or RESET, _scope_cell(s), s["id"]]
        for s in statuses
    ]


STATUS_COLUMNS = ["NAME", "CATEGORY", "COLOR", "ICON", "SCOPE", "ID"]


def _scoped_statuses(context: Context, team_id: str | None, include_hidden: bool = False) -> list[StatusRead]:
    """A team's effective statuses, or the workspace set, in board order."""
    if team_id is None:
        found = context.client.list_workspace_statuses(context.workspace_id)
    else:
        found = context.client.list_statuses(context.workspace_id, team_id, include_hidden=include_hidden)
    return sorted(found, key=lambda status: status.get("position", 0))


def _find_status(context: Context, team_id: str | None, ref: str) -> StatusRead:
    """One status by id or name, hidden ones included, so a hidden status can be shown again."""
    statuses = _scoped_statuses(context, team_id, include_hidden=True)
    found = next((s for s in statuses if ref == s["id"] or ref.casefold() == s["name"].casefold()), None)
    if found is None:
        found = next((s for s in statuses if ref.casefold() == (s.get("inherited_name") or "").casefold()), None)
    if found is None:
        names = ", ".join(s["name"] for s in statuses)
        raise ResolveError(f"No status matches {ref!r}. Statuses: {names}.")
    return found


@status_app.command("list")
def status_list(
    ctx: typer.Context,
    team: OptionalTeam = None,
    shared: SharedFlag = False,
    include_hidden: HiddenFlag = False,
    as_json: JsonFlag = False,
) -> None:
    """List a team's statuses, inherited and its own, or the workspace set, in board order."""
    context = _state(ctx).context()
    statuses = _scoped_statuses(context, _scope_team(context, team, shared), include_hidden)
    if as_json:
        output.print_json(statuses)
        return
    output.table(STATUS_COLUMNS, _status_rows(statuses), "No statuses.")


@status_app.command("create")
def status_create(
    ctx: typer.Context,
    name: Annotated[str, typer.Argument(help="The status name.")],
    category: Annotated[str, typer.Option("--category", "-c", callback=_one_of(STATUS_CATEGORIES), help=CATEGORY_HELP)],
    team: OptionalTeam = None,
    shared: SharedFlag = False,
    color: Annotated[str | None, typer.Option("--color", callback=_one_of(STATUS_COLORS), help=COLOR_HELP)] = None,
    icon: Annotated[
        str | None,
        typer.Option("--icon", callback=_one_of(STATUS_ICONS), help=ICON_HELP),
    ] = None,
    as_json: JsonFlag = False,
) -> None:
    """Add a team-only status, or with --shared a workspace status every team inherits."""
    context = _state(ctx).context()
    team_id = _scope_team(context, team, shared)
    body = cast(StatusCreate, compact({"name": name, "category": category, "color": color, "icon": icon}))
    if team_id is None:
        created = context.client.create_workspace_status(context.workspace_id, body)
    else:
        created = context.client.create_status(context.workspace_id, team_id, body)
    if as_json:
        output.print_json(created)
        return
    output.success(f"Created {created['name']} ({created['category']}).")


@status_app.command("edit")
def status_edit(
    ctx: typer.Context,
    status: Annotated[str, typer.Argument(help="Status name or id.")],
    team: OptionalTeam = None,
    shared: SharedFlag = False,
    name: Annotated[str | None, typer.Option("--name", help="A new name.")] = None,
    category: Annotated[
        str | None, typer.Option("--category", "-c", callback=_one_of(STATUS_CATEGORIES), help=CATEGORY_HELP)
    ] = None,
    color: Annotated[
        str | None,
        typer.Option(
            "--color",
            callback=_one_of([*STATUS_COLORS, RESET]),
            help=f"{COLOR_HELP} Or default to reset it.",
        ),
    ] = None,
    icon: Annotated[
        str | None,
        typer.Option(
            "--icon",
            callback=_one_of([*STATUS_ICONS, RESET]),
            help=f"{ICON_HELP} Or default to reset it.",
        ),
    ] = None,
    as_json: JsonFlag = False,
) -> None:
    """Rename, recategorise, recolor or change the icon of a team-only or, with --shared, a workspace status."""
    context = _state(ctx).context()
    team_id = _scope_team(context, team, shared)
    found = _find_status(context, team_id, status)
    patch: dict[str, Any] = compact({"name": name, "category": category})
    for field_name, value in (("color", color), ("icon", icon)):
        if value is not None:
            patch[field_name] = None if value == RESET else value
    if not patch:
        raise ConfigError("Nothing to change. Pass --name, --category, --color or --icon.")
    if team_id is None:
        updated = context.client.update_workspace_status(context.workspace_id, found["id"], cast(StatusUpdate, patch))
    else:
        updated = context.client.update_status(context.workspace_id, team_id, found["id"], cast(StatusUpdate, patch))
    if as_json:
        output.print_json(updated)
        return
    output.success(f"Updated {updated['name']}.")


@status_app.command("delete")
def status_delete(
    ctx: typer.Context,
    status: Annotated[str, typer.Argument(help="Status name or id.")],
    team: OptionalTeam = None,
    shared: SharedFlag = False,
    move_to: Annotated[
        str | None,
        typer.Option("--move-to", help="Status name or id its issues move to; required while issues use it."),
    ] = None,
) -> None:
    """Delete a team-only status, or with --shared a workspace status, moving its issues with --move-to."""
    context = _state(ctx).context()
    team_id = _scope_team(context, team, shared)
    found = _find_status(context, team_id, status)
    replacement = _find_status(context, team_id, move_to) if move_to else None
    replacement_id = replacement["id"] if replacement else None
    if team_id is None:
        context.client.delete_workspace_status(context.workspace_id, found["id"], replacement_id)
    else:
        context.client.delete_status(context.workspace_id, team_id, found["id"], replacement_id)
    moved = f" Its issues moved to {replacement['name']}." if replacement else ""
    output.success(f"Deleted {found['name']}.{moved}")


def _override_status(ctx: typer.Context, status: str, team: str, body: OverrideUpdate, done: str) -> None:
    """Apply one team override to an inherited workspace status and report it."""
    context = _state(ctx).context()
    team_id = context.team(team)["id"]
    found = _find_status(context, team_id, status)
    updated = context.client.override_status(context.workspace_id, team_id, found["id"], body)
    output.success(f"{done} {updated['name']}.")


@status_app.command("hide")
def status_hide(
    ctx: typer.Context, status: Annotated[str, typer.Argument(help="Status name or id.")], team: TeamOption
) -> None:
    """Hide an inherited workspace status in one team."""
    _override_status(ctx, status, team, {"hidden": True}, "Hid")


@status_app.command("unhide")
def status_unhide(
    ctx: typer.Context, status: Annotated[str, typer.Argument(help="Status name or id.")], team: TeamOption
) -> None:
    """Show a hidden workspace status in one team again."""
    _override_status(ctx, status, team, {"hidden": False}, "Showed")


@status_app.command("rename")
def status_rename(
    ctx: typer.Context,
    status: Annotated[str, typer.Argument(help="Status name or id.")],
    name: Annotated[str, typer.Argument(help="The team's own name for it.")],
    team: TeamOption,
) -> None:
    """Give an inherited workspace status a team-only name."""
    _override_status(ctx, status, team, {"name": name}, "Renamed to")


@status_app.command("clear-rename")
def status_clear_rename(
    ctx: typer.Context, status: Annotated[str, typer.Argument(help="Status name or id.")], team: TeamOption
) -> None:
    """Go back to the workspace name for an inherited status in one team."""
    _override_status(ctx, status, team, {"name": None}, "Back to")


@status_app.command("reset")
def status_reset(
    ctx: typer.Context, status: Annotated[str, typer.Argument(help="Status name or id.")], team: TeamOption
) -> None:
    """Drop every team override on an inherited status: shown again, under its workspace name."""
    context = _state(ctx).context()
    team_id = context.team(team)["id"]
    found = _find_status(context, team_id, status)
    updated = context.client.clear_status_override(context.workspace_id, team_id, found["id"])
    output.success(f"Reset {updated['name']}.")


def _label_rows(labels: list[LabelRead]) -> list[list[Any]]:
    """Table rows for labels."""
    return [[_display_name(label), label["color"], _scope_cell(label), label["id"]] for label in labels]


LABEL_COLUMNS = ["NAME", "COLOR", "SCOPE", "ID"]


def _scoped_labels(context: Context, team_id: str | None, include_hidden: bool = False) -> list[LabelRead]:
    """A team's effective labels, or the workspace set."""
    if team_id is None:
        return context.client.list_workspace_labels(context.workspace_id)
    return context.client.list_labels(context.workspace_id, team_id, include_hidden=include_hidden)


def _find_label(context: Context, team_id: str | None, ref: str) -> LabelRead:
    """One label by id or name, hidden ones included, so a hidden label can be shown again."""
    labels = _scoped_labels(context, team_id, include_hidden=True)
    found = next((lb for lb in labels if ref == lb["id"] or ref.casefold() == lb["name"].casefold()), None)
    if found is None:
        found = next((lb for lb in labels if ref.casefold() == (lb.get("inherited_name") or "").casefold()), None)
    if found is None:
        names = ", ".join(lb["name"] for lb in labels)
        raise ResolveError(f"No label matches {ref!r}. Labels: {names}.")
    return found


@label_app.command("list")
def label_list(
    ctx: typer.Context,
    team: OptionalTeam = None,
    shared: SharedFlag = False,
    include_hidden: HiddenFlag = False,
    as_json: JsonFlag = False,
) -> None:
    """List a team's labels, inherited and its own, or the workspace set."""
    context = _state(ctx).context()
    labels = _scoped_labels(context, _scope_team(context, team, shared), include_hidden)
    if as_json:
        output.print_json(labels)
        return
    output.table(LABEL_COLUMNS, _label_rows(labels), "No labels.")


@label_app.command("create")
def label_create(
    ctx: typer.Context,
    name: Annotated[str, typer.Argument(help="The label name.")],
    color: Annotated[str, typer.Option("--color", help="A hex color such as #5e6ad2.")],
    team: OptionalTeam = None,
    shared: SharedFlag = False,
    as_json: JsonFlag = False,
) -> None:
    """Add a team-only label, or with --shared a workspace label every team inherits."""
    context = _state(ctx).context()
    team_id = _scope_team(context, team, shared)
    body = LabelCreate(name=name, color=color)
    if team_id is None:
        created = context.client.create_workspace_label(context.workspace_id, body)
    else:
        created = context.client.create_label(context.workspace_id, team_id, body)
    if as_json:
        output.print_json(created)
        return
    output.success(f"Created {created['name']}.")


@label_app.command("edit")
def label_edit(
    ctx: typer.Context,
    label: Annotated[str, typer.Argument(help="Label name or id.")],
    team: OptionalTeam = None,
    shared: SharedFlag = False,
    name: Annotated[str | None, typer.Option("--name", help="A new name.")] = None,
    color: Annotated[str | None, typer.Option("--color", help="A new hex color.")] = None,
    as_json: JsonFlag = False,
) -> None:
    """Rename or recolor a team-only label, or with --shared a workspace label."""
    context = _state(ctx).context()
    team_id = _scope_team(context, team, shared)
    found = _find_label(context, team_id, label)
    patch = cast(LabelUpdate, compact({"name": name, "color": color}))
    if not patch:
        raise ConfigError("Nothing to change. Pass --name or --color.")
    if team_id is None:
        updated = context.client.update_workspace_label(context.workspace_id, found["id"], patch)
    else:
        updated = context.client.update_label(context.workspace_id, team_id, found["id"], patch)
    if as_json:
        output.print_json(updated)
        return
    output.success(f"Updated {updated['name']}.")


@label_app.command("delete")
def label_delete(
    ctx: typer.Context,
    label: Annotated[str, typer.Argument(help="Label name or id.")],
    team: OptionalTeam = None,
    shared: SharedFlag = False,
) -> None:
    """Delete a team-only label, or with --shared a workspace label, and take it off every issue."""
    context = _state(ctx).context()
    team_id = _scope_team(context, team, shared)
    found = _find_label(context, team_id, label)
    if team_id is None:
        context.client.delete_workspace_label(context.workspace_id, found["id"])
    else:
        context.client.delete_label(context.workspace_id, team_id, found["id"])
    output.success(f"Deleted {found['name']}.")


def _override_label(ctx: typer.Context, label: str, team: str, body: OverrideUpdate, done: str) -> None:
    """Apply one team override to an inherited workspace label and report it."""
    context = _state(ctx).context()
    team_id = context.team(team)["id"]
    found = _find_label(context, team_id, label)
    updated = context.client.override_label(context.workspace_id, team_id, found["id"], body)
    output.success(f"{done} {updated['name']}.")


@label_app.command("hide")
def label_hide(
    ctx: typer.Context, label: Annotated[str, typer.Argument(help="Label name or id.")], team: TeamOption
) -> None:
    """Hide an inherited workspace label in one team."""
    _override_label(ctx, label, team, {"hidden": True}, "Hid")


@label_app.command("unhide")
def label_unhide(
    ctx: typer.Context, label: Annotated[str, typer.Argument(help="Label name or id.")], team: TeamOption
) -> None:
    """Show a hidden workspace label in one team again."""
    _override_label(ctx, label, team, {"hidden": False}, "Showed")


@label_app.command("rename")
def label_rename(
    ctx: typer.Context,
    label: Annotated[str, typer.Argument(help="Label name or id.")],
    name: Annotated[str, typer.Argument(help="The team's own name for it.")],
    team: TeamOption,
) -> None:
    """Give an inherited workspace label a team-only name."""
    _override_label(ctx, label, team, {"name": name}, "Renamed to")


@label_app.command("clear-rename")
def label_clear_rename(
    ctx: typer.Context, label: Annotated[str, typer.Argument(help="Label name or id.")], team: TeamOption
) -> None:
    """Go back to the workspace name for an inherited label in one team."""
    _override_label(ctx, label, team, {"name": None}, "Back to")


@label_app.command("reset")
def label_reset(
    ctx: typer.Context, label: Annotated[str, typer.Argument(help="Label name or id.")], team: TeamOption
) -> None:
    """Drop every team override on an inherited label: shown again, under its workspace name."""
    context = _state(ctx).context()
    team_id = context.team(team)["id"]
    found = _find_label(context, team_id, label)
    updated = context.client.clear_label_override(context.workspace_id, team_id, found["id"])
    output.success(f"Reset {updated['name']}.")


def _progress(counts: Any, separator: str = "/") -> str:
    """Done against scope, which leaves cancelled issues out as the web app does."""
    scope = counts.get("total", 0) - counts.get("cancelled", 0)
    return f"{counts.get('done', 0)}{separator}{max(scope, 0)}"


def _cycle_rows(context: Context, cycles: list[Any]) -> list[list[Any]]:
    """Table rows for cycles, with the team's key and issue counts."""
    rows = []
    for cycle in cycles:
        team = context.team_by_id(cycle["team_id"])
        counts = cycle.get("counts") or {}
        progress = _progress(counts)
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


WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def _on_off(value: bool) -> str:
    """A setting's state as one word."""
    return "on" if value else "off"


@cycle_app.command("settings")
def cycle_settings(
    ctx: typer.Context,
    team: TeamOption,
    enabled: Annotated[
        bool | None,
        typer.Option("--enabled/--disabled", help="Whether cycles are created automatically."),
    ] = None,
    move_unfinished: Annotated[
        bool | None,
        typer.Option(
            "--move-unfinished/--no-move-unfinished",
            help="Whether unfinished issues move to the next cycle when a cycle ends.",
        ),
    ] = None,
    auto_add_started: Annotated[
        bool | None,
        typer.Option(
            "--auto-add-started/--no-auto-add-started",
            help="Whether started issues join the current cycle.",
        ),
    ] = None,
    as_json: JsonFlag = False,
) -> None:
    """Show a team's cycle settings, or change them with a flag. Changing needs team admin."""
    context = _state(ctx).context()
    found = context.team(team)
    changes: CycleSettingsUpdate = {}
    if enabled is not None:
        changes["enabled"] = enabled
    if move_unfinished is not None:
        changes["move_unfinished"] = move_unfinished
    if auto_add_started is not None:
        changes["auto_add_started"] = auto_add_started
    if changes:
        settings = context.client.update_cycle_settings(context.workspace_id, found["id"], changes)
    else:
        settings = context.client.get_cycle_settings(context.workspace_id, found["id"])
    if as_json:
        output.print_json(settings)
        return
    weekday = settings["start_weekday"]
    output.table(
        ["SETTING", "VALUE"],
        [
            ["Automatic cycles", _on_off(settings["enabled"])],
            ["Length", f"{settings['duration_weeks']} weeks"],
            ["Cooldown", f"{settings['cooldown_weeks']} weeks"],
            ["Starts on", WEEKDAYS[weekday] if 0 <= weekday < len(WEEKDAYS) else weekday],
            ["Upcoming cycles", settings["upcoming_count"]],
            ["Add started issues", _on_off(settings["auto_add_started"])],
            ["Move unfinished issues", _on_off(settings.get("move_unfinished", True))],
        ],
        "No settings.",
    )


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
                _progress(counts),
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
        ("Progress", _progress(counts, " of ") + " done"),
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
