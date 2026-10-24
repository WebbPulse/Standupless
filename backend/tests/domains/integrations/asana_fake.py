"""A fake Asana REST API, answering the importer's unit tests from a recorded workspace.

It serves exactly the GET routes `app.domains.integrations.asana_api` calls, from
`fixtures/asana/workspace.json`, a workspace recorded in Asana's own response
shapes. Lists page by `limit` with an opaque `offset`, so pagination is
exercised. A token not in `tokens` is refused with 401 the way Asana refuses one,
and `rate_limit_next` answers that many requests with HTTP 429 and a
`Retry-After` before serving again. No real Asana token or workspace is ever
involved, and no request leaves the process.
"""

from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import httpx

FAKE_TOKEN = "2/1100000000000001/1700000000000001:fakeasanatoken0000000000"
"""The token the fake accepts. It is not an Asana token and opens nothing anywhere else."""

FIXTURE = Path(__file__).parent / "fixtures" / "asana" / "workspace.json"

PROJECT_GID = "1200000000000001"

ARCHIVED_GID = "1200000000000002"

STAGE_FIELD_GID = "1300000000000002"

PREFIX = "/api/1.0"


@dataclass
class Request:
    """One request the fake answered: its path, query and whether the token was accepted."""

    path: str
    params: dict[str, str]
    authorized: bool


def recorded() -> dict[str, Any]:
    """A fresh copy of the recorded workspace, so a test may change it freely."""
    return json.loads(FIXTURE.read_text())


@dataclass
class FakeAsana:
    """An Asana workspace in memory and the REST answers it gives."""

    tokens: set[str] = field(default_factory=lambda: {FAKE_TOKEN})
    data: dict[str, Any] = field(default_factory=recorded)
    rate_limit_next: int = 0
    payment_required: bool = False
    requests: list[Request] = field(default_factory=list)

    def task(self, gid: str) -> dict[str, Any]:
        """One recorded task or subtask by its gid, to change before an import reads it."""
        for group in (*self.data["tasks"].values(), *self.data["subtasks"].values()):
            for task in group:
                if task["gid"] == gid:
                    return task
        raise KeyError(gid)

    def paths(self) -> list[str]:
        """The path of every request answered, in order."""
        return [request.path for request in self.requests]

    def _record(self, path: str) -> Optional[dict[str, Any]]:
        """The one record a path names, or `None` when the fake holds no such record."""
        if path == "/users/me":
            return copy.deepcopy(self.data["me"])
        found = re.fullmatch(r"/projects/(\d+)/task_counts", path)
        if found:
            return copy.deepcopy(self.data["task_counts"].get(found.group(1)))
        found = re.fullmatch(r"/projects/(\d+)", path)
        if found:
            for projects in self.data["projects"].values():
                for project in projects:
                    if project["gid"] == found.group(1):
                        return copy.deepcopy(project)
        return None

    def _list(self, path: str, params: dict[str, str]) -> Optional[list[dict[str, Any]]]:
        """The whole list a path and query name, or `None` when the fake holds no such list."""
        if path == "/projects":
            return self.data["projects"].get(params.get("workspace", ""))
        if path == "/tasks":
            return self.data["tasks"].get(params.get("project", ""))
        routes = {
            r"/projects/(\d+)/sections": "sections",
            r"/projects/(\d+)/custom_field_settings": "custom_field_settings",
            r"/tasks/(\d+)/subtasks": "subtasks",
            r"/tasks/(\d+)/stories": "stories",
        }
        for pattern, name in routes.items():
            found = re.fullmatch(pattern, path)
            if found:
                default: Optional[list[dict[str, Any]]] = [] if name in ("subtasks", "stories") else None
                return self.data[name].get(found.group(1), default)
        return None

    def answer(self, path: str, params: dict[str, str], authorization: str) -> tuple[int, dict[str, str], Any]:
        """The status, headers and JSON body Asana would answer one GET with."""
        authorized = any(authorization == f"Bearer {token}" for token in self.tokens)
        self.requests.append(Request(path=path, params=dict(params), authorized=authorized))
        if self.rate_limit_next > 0:
            self.rate_limit_next -= 1
            return 429, {"Retry-After": "2"}, {"errors": [{"message": "You have made too many requests recently."}]}
        if not authorized:
            return 401, {}, {"errors": [{"message": "Not Authorized"}]}
        if self.payment_required and path.endswith("/custom_field_settings"):
            return 402, {}, {"errors": [{"message": "Custom fields are a premium feature."}]}
        record = self._record(path)
        if record is not None:
            return 200, {}, {"data": record}
        rows = self._list(path, params)
        if rows is None:
            return 404, {}, {"errors": [{"message": "Unknown object"}]}
        limit = int(params.get("limit") or 100)
        start = int(params.get("offset") or 0)
        page = copy.deepcopy(rows[start : start + limit])
        following = start + limit
        next_page = {"offset": str(following), "path": path, "uri": ""} if following < len(rows) else None
        return 200, {}, {"data": page, "next_page": next_page}

    def transport(self) -> httpx.MockTransport:
        """An `httpx` transport that answers from this fake without a socket."""

        def handle(request: httpx.Request) -> httpx.Response:
            """Answer one request the client sent."""
            path = request.url.path
            if path.startswith(PREFIX):
                path = path[len(PREFIX) :]
            status, headers, payload = self.answer(
                path, dict(request.url.params), request.headers.get("Authorization", "")
            )
            return httpx.Response(status, headers=headers, json=payload)

        return httpx.MockTransport(handle)
