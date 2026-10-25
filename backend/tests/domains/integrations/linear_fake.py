"""A fake Linear GraphQL server, for the importer's unit tests and the local stack e2e case.

It answers exactly the operations `app.common.linear_api` sends, found by their
operation name, from a workspace held in memory in Linear's own node shapes.
Connections page by `first` and an opaque `after` cursor, and nested connections
page by `nested_page_size`, so pagination at both levels is exercised. A key not
in `keys` is refused the way Linear refuses one, and `rate_limit_next` answers
that many requests with HTTP 429 and a reset time before serving again. An
operation in `rejected_operations` is refused as a schema mismatch.

The module is standard library only apart from `transport`, which builds an
`httpx` transport lazily, so the e2e group can run `serve` without the backend's
dependencies. No real Linear key or workspace is ever involved.
"""

from __future__ import annotations

import json
import re
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

FAKE_KEY = "lin_api_fake_0000000000000000000000000000"
"""The key the fake accepts by default. It is not a Linear key and opens nothing anywhere else."""

OPERATION = re.compile(r"query\s+(\w+)")


@dataclass
class Request:
    """One request the fake answered: its operation, variables and whether the key was accepted."""

    operation: str
    variables: dict[str, Any]
    authorized: bool


@dataclass
class FakeLinear:
    """A Linear workspace in memory and the GraphQL answers it gives."""

    keys: set[str] = field(default_factory=lambda: {FAKE_KEY})
    teams: list[dict[str, Any]] = field(default_factory=list)
    cycles: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    projects: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    issues: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    initiatives: list[dict[str, Any]] = field(default_factory=list)
    project_relations: list[dict[str, Any]] = field(default_factory=list)
    states: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    templates: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    labels: list[dict[str, Any]] = field(default_factory=list)
    rejected_operations: set[str] = field(default_factory=set)
    nested_page_size: int = 50
    rate_limit_next: int = 0
    requests: list[Request] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def answer(self, body: dict[str, Any], authorization: str) -> tuple[int, dict[str, str], dict[str, Any]]:
        """The status, headers and JSON body Linear would answer one GraphQL request with."""
        document = str(body.get("query") or "")
        variables = dict(body.get("variables") or {})
        found = OPERATION.search(document)
        operation = found.group(1) if found else ""
        authorized = authorization in self.keys
        with self._lock:
            self.requests.append(Request(operation=operation, variables=variables, authorized=authorized))
            if self.rate_limit_next > 0:
                self.rate_limit_next -= 1
                reset = str(int((time.time() + 1.5) * 1000))
                return (
                    429,
                    {"X-RateLimit-Requests-Reset": reset, "X-RateLimit-Requests-Remaining": "0"},
                    {"errors": [{"message": "Rate limit exceeded", "extensions": {"code": "RATELIMITED"}}]},
                )
        if not authorized:
            return (
                401,
                {},
                {"errors": [{"message": "Authentication required", "extensions": {"code": "AUTHENTICATION_ERROR"}}]},
            )
        handler = getattr(self, f"_op_{operation}", None)
        if operation in self.rejected_operations:
            message = f"Cannot query field on type Query in {operation}"
            return 400, {}, {"errors": [{"message": message, "extensions": {"code": "GRAPHQL_VALIDATION_FAILED"}}]}
        if handler is None:
            return 400, {}, {"errors": [{"message": f"Unknown operation {operation}"}]}
        return 200, {}, {"data": handler(variables)}

    def operations(self) -> list[str]:
        """The operation name of every request answered so far, in order."""
        return [request.operation for request in self.requests]

    def transport(self) -> Any:
        """An `httpx` transport that answers from this fake without a socket."""
        import httpx

        def handle(request: httpx.Request) -> httpx.Response:
            """Answer one request the client sent."""
            status, headers, payload = self.answer(
                json.loads(request.content or b"{}"), request.headers.get("Authorization", "")
            )
            return httpx.Response(status, headers=headers, json=payload)

        return httpx.MockTransport(handle)

    def serve(self, host: str = "127.0.0.1", port: int = 8765) -> ThreadingHTTPServer:
        """Serve this fake over HTTP on a daemon thread, answering at `/graphql`, until `shutdown`."""
        fake = self

        class Handler(BaseHTTPRequestHandler):
            """Hands each POST to the fake."""

            def do_POST(self) -> None:
                """Answer one GraphQL request."""
                length = int(self.headers.get("Content-Length") or 0)
                try:
                    body = json.loads(self.rfile.read(length) or b"{}")
                except ValueError:
                    body = {}
                status, headers, payload = fake.answer(body, self.headers.get("Authorization", ""))
                encoded = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                for name, value in headers.items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, format: str, *args: Any) -> None:
                """Keep the request log quiet."""

        server = ThreadingHTTPServer((host, port), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server

    def _connection(self, nodes: list[dict[str, Any]], first: Any, after: Any) -> dict[str, Any]:
        """One page of a connection, with Linear's `pageInfo`."""
        start = int(str(after)[1:]) if after else 0
        size = int(first or 50)
        page = nodes[start : start + size]
        has_next = start + size < len(nodes)
        return {
            "nodes": page,
            "pageInfo": {"hasNextPage": has_next, "endCursor": f"c{start + len(page)}" if page else None},
        }

    def _nested(self, nodes: list[dict[str, Any]], paged: bool = True) -> dict[str, Any]:
        """A nested connection's first page, held to `nested_page_size`."""
        if not paged:
            return {"nodes": list(nodes)}
        return self._connection(nodes, self.nested_page_size, None)

    def _project(self, linear_id: str) -> Optional[dict[str, Any]]:
        """One stored project, whichever team holds it."""
        for projects in self.projects.values():
            for project in projects:
                if project["id"] == linear_id:
                    return project
        return None

    def _issue(self, linear_id: str) -> Optional[dict[str, Any]]:
        """One stored issue, whichever team holds it."""
        for issues in self.issues.values():
            for issue in issues:
                if issue["id"] == linear_id:
                    return issue
        return None

    def _op_Teams(self, variables: dict[str, Any]) -> dict[str, Any]:
        """The teams the key can read."""
        teams = [{"id": team["id"], "key": team["key"], "name": team["name"]} for team in self.teams]
        return {"teams": self._connection(teams, variables.get("first"), variables.get("after"))}

    def _op_WorkflowStates(self, variables: dict[str, Any]) -> dict[str, Any]:
        """One team's workflow states."""
        states = self.states.get(str(variables.get("team")), [])
        return {"team": {"states": self._connection(states, variables.get("first"), variables.get("after"))}}

    def _op_Templates(self, variables: dict[str, Any]) -> dict[str, Any]:
        """One team's templates, of every type."""
        templates = self.templates.get(str(variables.get("team")), [])
        return {"team": {"templates": self._connection(templates, variables.get("first"), variables.get("after"))}}

    def _op_IssueLabels(self, variables: dict[str, Any]) -> dict[str, Any]:
        """Every label the key can read."""
        return {"issueLabels": self._connection(list(self.labels), variables.get("first"), variables.get("after"))}

    def _op_Cycles(self, variables: dict[str, Any]) -> dict[str, Any]:
        """One team's cycles."""
        cycles = self.cycles.get(str(variables.get("team")), [])
        return {"team": {"cycles": self._connection(cycles, variables.get("first"), variables.get("after"))}}

    def _project_node(self, project: dict[str, Any]) -> dict[str, Any]:
        """One project as the projects query answers it, its milestones and updates nested."""
        node = {key: value for key, value in project.items() if key not in ("milestones", "updates")}
        node["projectMilestones"] = self._nested(project.get("milestones", []))
        node["projectUpdates"] = self._nested(project.get("updates", []))
        return node

    def _op_Projects(self, variables: dict[str, Any]) -> dict[str, Any]:
        """One team's projects."""
        projects = [self._project_node(project) for project in self.projects.get(str(variables.get("team")), [])]
        return {"team": {"projects": self._connection(projects, variables.get("first"), variables.get("after"))}}

    def _op_ProjectMilestones(self, variables: dict[str, Any]) -> dict[str, Any]:
        """The rest of one project's milestones."""
        project = self._project(str(variables.get("project"))) or {}
        connection = self._connection(project.get("milestones", []), variables.get("first"), variables.get("after"))
        return {"project": {"projectMilestones": connection}}

    def _op_ProjectUpdates(self, variables: dict[str, Any]) -> dict[str, Any]:
        """The rest of one project's updates."""
        project = self._project(str(variables.get("project"))) or {}
        connection = self._connection(project.get("updates", []), variables.get("first"), variables.get("after"))
        return {"project": {"projectUpdates": connection}}

    def _issue_node(self, issue: dict[str, Any]) -> dict[str, Any]:
        """One issue as the issues query answers it."""
        skip = ("labels", "attachments", "comments", "parent", "relations")
        node = {key: value for key, value in issue.items() if key not in skip}
        node["labels"] = self._nested(issue.get("labels", []), paged=False)
        node["attachments"] = self._nested(issue.get("attachments", []), paged=False)
        node["comments"] = self._nested(issue.get("comments", []))
        return node

    def _op_Issues(self, variables: dict[str, Any]) -> dict[str, Any]:
        """One team's issues with their labels, attachments and first comments."""
        issues = [self._issue_node(issue) for issue in self.issues.get(str(variables.get("team")), [])]
        return {"team": {"issues": self._connection(issues, variables.get("first"), variables.get("after"))}}

    def _op_IssueComments(self, variables: dict[str, Any]) -> dict[str, Any]:
        """The rest of one issue's comments."""
        issue = self._issue(str(variables.get("issue"))) or {}
        connection = self._connection(issue.get("comments", []), variables.get("first"), variables.get("after"))
        return {"issue": {"comments": connection}}

    def _op_IssueLinks(self, variables: dict[str, Any]) -> dict[str, Any]:
        """One team's issues with their parents and relations."""
        nodes = [
            {
                "id": issue["id"],
                "createdAt": issue.get("createdAt"),
                "parent": issue.get("parent"),
                "relations": {"nodes": list(issue.get("relations", []))},
            }
            for issue in self.issues.get(str(variables.get("team")), [])
        ]
        return {"team": {"issues": self._connection(nodes, variables.get("first"), variables.get("after"))}}

    def _op_Initiatives(self, variables: dict[str, Any]) -> dict[str, Any]:
        """The workspace's initiatives with their projects."""
        nodes = [
            {
                **{key: value for key, value in initiative.items() if key != "projects"},
                "projects": {"nodes": list(initiative.get("projects", []))},
            }
            for initiative in self.initiatives
        ]
        return {"initiatives": self._connection(nodes, variables.get("first"), variables.get("after"))}

    def _op_ProjectRelations(self, variables: dict[str, Any]) -> dict[str, Any]:
        """The workspace's project dependencies."""
        relations = list(self.project_relations)
        return {"projectRelations": self._connection(relations, variables.get("first"), variables.get("after"))}


def ref(node: dict[str, Any]) -> dict[str, Any]:
    """A nested reference to a stored node, as Linear answers one."""
    return {"id": node["id"], "createdAt": node.get("createdAt")}


def sample(member_email: str, *, prefix: str = "ENG", tag: str = "") -> FakeLinear:
    """A small Linear workspace touching every field the importer reads.

    One team keyed `prefix` with five workflow states, two issue templates and
    a project template, a cycle, a project with two milestones
    and an update, an initiative holding the project, and four issues: a parent
    with a grouped label, a sub-issue, an issue the parent blocks, and a
    duplicate. `member_email` is the person a Standupless member matches;
    everyone else is someone the workspace does not know. `tag` makes the
    Linear ids distinct between runs that share one Standupless workspace.
    """
    team_id = f"team-{prefix.lower()}{tag}"
    stranger = {"name": "Riley Stranger", "email": "riley@linear-only.example"}
    member = {"name": "Matched Member", "email": member_email}
    created = "2026-07-01T09:00:00.000Z"
    states = [
        {"id": f"state-backlog{tag}", "name": "Backlog", "type": "backlog", "position": 0, "color": "#bec2c8"},
        {"id": f"state-todo{tag}", "name": "Todo", "type": "unstarted", "position": 1, "color": "#e2e2e2"},
        {"id": f"state-doing{tag}", "name": "Doing", "type": "started", "position": 2, "color": "#f2c94c"},
        {"id": f"state-shipped{tag}", "name": "Shipped", "type": "completed", "position": 3, "color": "#5e6ad2"},
        {"id": f"state-dropped{tag}", "name": "Dropped", "type": "canceled", "position": 4, "color": "#95a2b3"},
    ]
    states = [{**state, "createdAt": created} for state in states]
    cycle = {
        "id": f"cycle-1{tag}",
        "number": 7,
        "name": "",
        "description": "Ship the importer",
        "startsAt": "2026-09-01T00:00:00.000Z",
        "endsAt": "2026-09-14T00:00:00.000Z",
        "createdAt": "2026-08-30T10:00:00.000Z",
    }
    milestones = [
        {
            "id": f"milestone-beta{tag}",
            "name": "Beta",
            "description": "First users",
            "targetDate": "2026-10-01",
            "sortOrder": 2.0,
            "createdAt": "2026-08-02T10:00:00.000Z",
        },
        {
            "id": f"milestone-alpha{tag}",
            "name": "Alpha",
            "description": None,
            "targetDate": "2026-09-15",
            "sortOrder": 1.0,
            "createdAt": "2026-08-01T10:00:00.000Z",
        },
    ]
    updates = [
        {
            "id": f"update-1{tag}",
            "body": "Going well, the API importer is in review.",
            "health": "atRisk",
            "createdAt": "2026-09-05T12:00:00.000Z",
            "user": stranger,
        }
    ]
    project = {
        "id": f"project-1{tag}",
        "name": f"Importer {prefix}{tag}",
        "description": "Move off Linear",
        "content": "Move every team off Linear in one go.",
        "url": f"https://linear.app/acme/project/importer-{prefix.lower()}{tag}",
        "createdAt": "2026-08-01T09:00:00.000Z",
        "startDate": "2026-08-01",
        "targetDate": "2026-10-31",
        "priority": 2,
        "health": None,
        "status": {"type": "started"},
        "lead": {"email": member_email},
        "milestones": milestones,
        "updates": updates,
    }
    label_group = {"id": f"label-type{tag}", "name": "Type", "color": "#5e6ad2", "groupType": "multiSelect"}
    bug = {"id": f"label-bug{tag}", "name": "Bug", "color": "#eb5757", "parent": label_group}
    frontend = {"id": f"label-frontend{tag}", "name": "Frontend", "color": "not-a-colour", "parent": None}

    def issue(number: int, title: str, state: dict[str, Any], created: str, **extra: Any) -> dict[str, Any]:
        """One Linear issue with the defaults the sample shares."""
        identifier = f"{prefix}-{number}"
        return {
            "id": f"issue-{prefix.lower()}-{number}{tag}",
            "identifier": identifier,
            "url": f"https://linear.app/acme/issue/{identifier.lower()}{tag}",
            "title": title,
            "description": None,
            "priority": 0,
            "estimate": None,
            "dueDate": None,
            "createdAt": created,
            "state": {"id": state["id"], "name": state["name"], "type": state["type"]},
            "assignee": None,
            "creator": None,
            "cycle": None,
            "project": None,
            "projectMilestone": None,
            "labels": [],
            "attachments": [],
            "comments": [],
            "parent": None,
            "relations": [],
            **extra,
        }

    parent = issue(
        1,
        "Import a Linear workspace",
        {**states[2], "name": "In Progress"},
        "2026-09-01T09:00:00.000Z",
        description="Read Linear's API and write every team.",
        priority=1,
        estimate=3,
        dueDate="2026-09-30",
        assignee={"email": member_email},
        creator={"email": member_email},
        cycle=ref(cycle),
        project=ref(project),
        projectMilestone=ref(milestones[1]),
        labels=[bug, frontend],
        attachments=[
            {"title": "Design [draft]", "url": "https://example.com/design"},
            {"title": "Local file", "url": "file:///etc/passwd"},
        ],
        comments=[
            {
                "id": f"comment-1{tag}",
                "body": "First pass is up.",
                "createdAt": "2026-09-02T09:00:00.000Z",
                "parent": None,
                "user": member,
            },
            {
                "id": f"comment-2{tag}",
                "body": "Looks good to me.",
                "createdAt": "2026-09-02T10:00:00.000Z",
                "parent": None,
                "user": stranger,
            },
            {
                "id": f"comment-3{tag}",
                "body": "Agreed, thanks.",
                "createdAt": "2026-09-02T11:00:00.000Z",
                "parent": {"id": f"comment-2{tag}", "createdAt": "2026-09-02T10:00:00.000Z"},
                "user": member,
            },
        ],
    )
    child = issue(
        2,
        "Map workflow states by type",
        states[1],
        "2026-09-01T10:00:00.000Z",
        priority=3,
        estimate=7,
        assignee={"email": "nobody@linear-only.example"},
        parent=ref(parent),
    )
    blocked = issue(3, "Write the summary page", states[3], "2026-09-01T11:00:00.000Z", priority=4)
    duplicate = issue(4, "Linear importer", states[4], "2026-09-01T12:00:00.000Z")
    parent["relations"] = [
        {"type": "blocks", "relatedIssue": ref(blocked)},
        {"type": "similar", "relatedIssue": ref(duplicate)},
    ]
    duplicate["relations"] = [
        {"type": "duplicate", "relatedIssue": ref(parent)},
        {"type": "related", "relatedIssue": ref(child)},
    ]
    initiative = {
        "id": f"initiative-1{tag}",
        "name": f"Leave Linear {prefix}{tag}",
        "description": "One tracker",
        "status": "Active",
        "targetDate": "2026-12-31",
        "createdAt": "2026-07-01T09:00:00.000Z",
        "owner": {"email": member_email},
        "projects": [ref(project)],
    }
    templates = [
        {
            "id": f"template-bug{tag}",
            "name": "Bug report",
            "type": "issue",
            "createdAt": created,
            "templateData": {
                "title": "Bug: ",
                "description": "## Steps\n\n1. ",
                "priority": 2,
                "labelIds": [bug["id"]],
                "estimate": 3,
            },
        },
        {
            "id": f"template-spike{tag}",
            "name": "Spike",
            "type": "issue",
            "createdAt": created,
            "templateData": json.dumps(
                {
                    "descriptionData": {
                        "type": "doc",
                        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Timebox it."}]}],
                    },
                    "priority": 0,
                }
            ),
        },
        {"id": f"template-launch{tag}", "name": "Launch", "type": "project", "createdAt": created, "templateData": {}},
    ]
    return FakeLinear(
        teams=[{"id": team_id, "key": prefix, "name": f"Engineering {prefix}"}],
        states={team_id: states},
        templates={team_id: templates},
        labels=[label_group, bug, frontend],
        cycles={team_id: [cycle]},
        projects={team_id: [project]},
        issues={team_id: [parent, child, blocked, duplicate]},
        initiatives=[initiative],
    )
