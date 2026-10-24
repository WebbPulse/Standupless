"""A fake Jira Cloud REST API, answering the importer's unit tests from a recorded site.

It serves exactly the routes `app.domains.integrations.jira_api` calls, from
`fixtures/jira/site.json`, a site recorded in Jira's own response shapes. Issue
search understands the small JQL the importer writes, `project = "KEY"`,
`statusCategory = Done`, `labels = name`, `id > N` and `ORDER BY id ASC`, and
answers 400 for anything else the way Jira refuses a query it cannot parse.
Credentials not in `accounts` are refused with 401, and `rate_limit_next`
answers that many requests with HTTP 429 and a `Retry-After` before serving
again. No real Jira site or token is ever involved, and no request leaves the
process.
"""

from __future__ import annotations

import base64
import copy
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import httpx

SITE = "https://acme-example.atlassian.net"

FAKE_EMAIL = "admin@example.com"

FAKE_TOKEN = "fake-jira-api-token-not-real-0001"
"""The token the fake accepts. It is not a Jira token and opens nothing anywhere else."""

FIXTURE = Path(__file__).parent / "fixtures" / "jira" / "site.json"

POINTS_FIELD = "customfield_10016"

SPRINT_FIELD = "customfield_10020"

CLAUSES = (
    re.compile(r'project\s*=\s*"?(?P<project>[A-Z][A-Z0-9_]*)"?', re.IGNORECASE),
    re.compile(r"statusCategory\s*=\s*(?P<category>Done)", re.IGNORECASE),
    re.compile(r'labels\s*=\s*"?(?P<label>[A-Za-z0-9_-]+)"?', re.IGNORECASE),
    re.compile(r"\bid\s*>\s*(?P<after>\d+)", re.IGNORECASE),
    re.compile(r"\border\s+by\s+id\s+asc\b", re.IGNORECASE),
)

CONNECTIVES = re.compile(r"[()\s]|\bAND\b", re.IGNORECASE)


@dataclass
class Request:
    """One request the fake answered: its method, path, query, body and whether the credentials were accepted."""

    method: str
    path: str
    params: dict[str, str]
    body: Any
    authorized: bool


def recorded() -> dict[str, Any]:
    """A fresh copy of the recorded site, so a test may change it freely."""
    return json.loads(FIXTURE.read_text())


def basic(email: str, token: str) -> str:
    """The basic auth header value Jira expects for an email and token."""
    return "Basic " + base64.b64encode(f"{email}:{token}".encode()).decode()


@dataclass
class FakeJira:
    """A Jira Cloud site in memory and the REST answers it gives."""

    accounts: set[tuple[str, str]] = field(default_factory=lambda: {(FAKE_EMAIL, FAKE_TOKEN)})
    data: dict[str, Any] = field(default_factory=recorded)
    rate_limit_next: int = 0
    unavailable_next: int = 0
    requests: list[Request] = field(default_factory=list)

    def issue(self, key: str) -> dict[str, Any]:
        """One recorded issue by key, to change before an import reads it."""
        for issue in self.data["issues"]:
            if issue["key"] == key:
                return issue
        raise KeyError(key)

    def paths(self) -> list[str]:
        """The path of every request answered, in order."""
        return [request.path for request in self.requests]

    def searches(self) -> list[str]:
        """The JQL of every issue search answered, in order."""
        return [request.params.get("jql", "") for request in self.requests if request.path.endswith("/search/jql")]

    def _matching(self, jql: str) -> Optional[list[dict[str, Any]]]:
        """The issues a query matches in id order, or `None` for a query the fake cannot parse."""
        rest = jql
        found: dict[str, str] = {}
        for clause in CLAUSES:
            for match in clause.finditer(rest):
                found.update({key: value for key, value in match.groupdict().items() if value})
            rest = clause.sub(" ", rest)
        if CONNECTIVES.sub("", rest):
            return None
        issues = sorted(self.data["issues"], key=lambda issue: int(issue["id"]))
        if "project" in found:
            prefix = f"{found['project'].upper()}-"
            issues = [issue for issue in issues if issue["key"].startswith(prefix)]
        if "category" in found:
            issues = [issue for issue in issues if issue["fields"]["status"]["statusCategory"]["key"] == "done"]
        if "label" in found:
            issues = [issue for issue in issues if found["label"] in (issue["fields"].get("labels") or [])]
        if "after" in found:
            issues = [issue for issue in issues if int(issue["id"]) > int(found["after"])]
        return issues

    def _project(self, key: str) -> Optional[dict[str, Any]]:
        """One recorded project by key."""
        return next((project for project in self.data["projects"] if project["key"] == key.upper()), None)

    def _get(self, path: str, params: dict[str, str]) -> tuple[int, Any]:
        """The status and body one GET is answered with."""
        if path == "/rest/api/3/myself":
            return 200, copy.deepcopy(self.data["myself"])
        if path == "/rest/api/3/project/search":
            return 200, self._paged(self.data["projects"], params, "values")
        if path == "/rest/api/3/status":
            return 200, copy.deepcopy(self.data["statuses"])
        if path == "/rest/api/3/field":
            return 200, copy.deepcopy(self.data["fields"])
        if path == "/rest/api/3/search/jql":
            issues = self._matching(params.get("jql", ""))
            if issues is None:
                return 400, {"errorMessages": ["Error in the JQL Query."]}
            limit = int(params.get("maxResults") or 50)
            wanted = {name for name in (params.get("fields") or "").split(",") if name}
            page = []
            for issue in issues[:limit]:
                fields = {name: value for name, value in issue["fields"].items() if name in wanted}
                page.append({"id": issue["id"], "key": issue["key"], "fields": copy.deepcopy(fields)})
            is_last = len(issues) <= limit
            body: dict[str, Any] = {"issues": page, "isLast": is_last}
            if not is_last:
                body["nextPageToken"] = "opaque"
            return 200, body
        found = re.fullmatch(r"/rest/api/3/project/([A-Za-z0-9_]+)/statuses", path)
        if found:
            statuses = self.data["project_statuses"].get(found.group(1).upper())
            return (200, copy.deepcopy(statuses)) if statuses is not None else (404, {"errorMessages": ["No project"]})
        found = re.fullmatch(r"/rest/api/3/project/([A-Za-z0-9_]+)", path)
        if found:
            project = self._project(found.group(1))
            return (200, copy.deepcopy(project)) if project else (404, {"errorMessages": ["No project"]})
        found = re.fullmatch(r"/rest/api/3/issue/(\d+)/comment", path)
        if found:
            return 200, self._paged(self.data["comments"].get(found.group(1), []), params, "comments")
        return 404, {"errorMessages": ["Unknown route"]}

    def _post(self, path: str, body: Any) -> tuple[int, Any]:
        """The status and body one POST is answered with."""
        if path == "/rest/api/3/search/approximate-count":
            issues = self._matching(str((body or {}).get("jql") or ""))
            if issues is None:
                return 400, {"errorMessages": ["Error in the JQL Query."]}
            return 200, {"count": len(issues)}
        if path == "/rest/api/3/issue/bulkfetch":
            wanted = {str(value) for value in (body or {}).get("issueIdsOrKeys") or []}
            issues = [
                {"id": issue["id"], "key": issue["key"], "fields": {"created": issue["fields"]["created"]}}
                for issue in self.data["issues"]
                if issue["id"] in wanted or issue["key"] in wanted
            ]
            return 200, {"issues": issues, "issueErrors": []}
        return 404, {"errorMessages": ["Unknown route"]}

    @staticmethod
    def _paged(rows: list[dict[str, Any]], params: dict[str, str], key: str) -> dict[str, Any]:
        """One `startAt` page of a list in Jira's paged shape."""
        start = int(params.get("startAt") or 0)
        limit = int(params.get("maxResults") or 50)
        page = copy.deepcopy(rows[start : start + limit])
        return {key: page, "startAt": start, "maxResults": limit, "total": len(rows), "isLast": start + limit >= len(rows)}

    def answer(
        self, method: str, path: str, params: dict[str, str], body: Any, authorization: str
    ) -> tuple[int, dict[str, str], Any]:
        """The status, headers and JSON body Jira would answer one call with."""
        authorized = any(authorization == basic(email, token) for email, token in self.accounts)
        self.requests.append(Request(method=method, path=path, params=dict(params), body=body, authorized=authorized))
        if self.rate_limit_next > 0:
            self.rate_limit_next -= 1
            return 429, {"Retry-After": "3"}, {"errorMessages": ["Rate limit exceeded."]}
        if self.unavailable_next > 0:
            self.unavailable_next -= 1
            return 503, {}, {"errorMessages": ["Service unavailable."]}
        if not authorized:
            return 401, {}, {"errorMessages": ["Client must be authenticated to access this resource."]}
        status, payload = self._post(path, body) if method == "POST" else self._get(path, params)
        return status, {}, payload

    def transport(self) -> httpx.MockTransport:
        """An `httpx` transport that answers from this fake without a socket."""

        def handle(request: httpx.Request) -> httpx.Response:
            """Answer one request the client sent."""
            body = json.loads(request.content) if request.content else None
            status, headers, payload = self.answer(
                request.method,
                request.url.path,
                dict(request.url.params),
                body,
                request.headers.get("Authorization", ""),
            )
            return httpx.Response(status, headers=headers, json=payload)

        return httpx.MockTransport(handle)
