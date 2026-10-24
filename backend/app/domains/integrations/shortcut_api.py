"""The Shortcut REST calls the importer makes, and the one place a request leaves for Shortcut.

An API token travels only in the `Shortcut-Token` header of a request built here.
It is never formatted into an exception, a log line or a return value, so
whatever goes wrong, what reaches a log or a job object is a code such as
`authentication_failed`, never the token.

Shortcut meters requests per token and per minute and answers an exhausted
budget with HTTP 429. `ShortcutClient.get` waits, honouring `Retry-After` when
Shortcut sends it and bounded by `MAX_WAIT_SECONDS`, and retries a few times, so
a large workspace imports at Shortcut's pace instead of failing. A 5xx answer
and a dropped connection are retried the same way.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Optional

import httpx

from app.common.core.config import settings

TIMEOUT_SECONDS = 20.0

MAX_ATTEMPTS = 5
"""How many times one request is sent before the failure is raised."""

MAX_WAIT_SECONDS = 60.0
"""The longest one rate limit or retry pause lasts, so a step always ends inside its invocation."""

BACKOFF_SECONDS = 2.0
"""The first pause after a 429 without `Retry-After`, a 5xx or a dropped connection, doubled on each retry."""


class ShortcutError(Exception):
    """Shortcut refused or did not answer a request, carrying only a code and never the token."""

    def __init__(self, code: str, *, status_code: int = 0) -> None:
        """Carry Shortcut's refusal as a short code and the HTTP status it came with."""
        super().__init__(code)
        self.code = code
        self.status_code = status_code


class ShortcutAuthFailed(ShortcutError):
    """The token was refused: wrong, revoked, or without access to the workspace."""


class ShortcutRateLimited(ShortcutError):
    """Shortcut's rate limit still held after every retry."""


@dataclass
class ShortcutClient:
    """A Shortcut API session for one token, with an injectable transport and clock for the tests."""

    token: str = field(repr=False)
    url: str = ""
    transport: Optional[httpx.BaseTransport] = None
    sleep: Callable[[float], None] = time.sleep

    def __post_init__(self) -> None:
        """Default the endpoint to the configured one."""
        self.url = (self.url or settings.SHORTCUT_API_URL).rstrip("/")

    def get(self, path: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        """Send one GET and answer its JSON body, waiting out rate limits and transient failures."""
        attempt = 0
        while True:
            attempt += 1
            backoff = min(BACKOFF_SECONDS * 2 ** (attempt - 1), MAX_WAIT_SECONDS)
            try:
                with httpx.Client(timeout=TIMEOUT_SECONDS, transport=self.transport) as client:
                    response = client.get(
                        f"{self.url}{path}",
                        params=dict(params or {}),
                        headers={"Shortcut-Token": self.token, "Content-Type": "application/json"},
                    )
            except httpx.HTTPError:
                if attempt >= MAX_ATTEMPTS:
                    raise ShortcutError("unreachable") from None
                self.sleep(backoff)
                continue
            if response.status_code == 429:
                if attempt >= MAX_ATTEMPTS:
                    raise ShortcutRateLimited("rate_limited", status_code=429)
                self.sleep(_retry_after(response, backoff))
                continue
            if response.status_code >= 500:
                if attempt >= MAX_ATTEMPTS:
                    raise ShortcutError("unavailable", status_code=response.status_code)
                self.sleep(backoff)
                continue
            return _body(response)


def _retry_after(response: httpx.Response, fallback: float) -> float:
    """How long a 429 asks to wait, or the backoff when it does not say."""
    header = response.headers.get("Retry-After")
    if header:
        try:
            return min(max(float(header), 1.0), MAX_WAIT_SECONDS)
        except ValueError:
            pass
    return fallback


def _body(response: httpx.Response) -> Any:
    """The JSON body of a settled answer, or the refusal it carries as a `ShortcutError`."""
    if response.status_code in (401, 403):
        raise ShortcutAuthFailed("authentication_failed", status_code=response.status_code)
    if response.status_code == 404:
        raise ShortcutError("not_found", status_code=404)
    if response.status_code >= 400:
        raise ShortcutError(f"http_{response.status_code}", status_code=response.status_code)
    try:
        return response.json()
    except ValueError:
        raise ShortcutError("invalid_response", status_code=response.status_code) from None


def _objects(value: Any) -> list[dict[str, Any]]:
    """The objects of a JSON list, or none when the answer was not one."""
    if not isinstance(value, list):
        raise ShortcutError("invalid_response")
    return [entry for entry in value if isinstance(entry, dict)]


def list_teams(client: ShortcutClient) -> list[dict[str, Any]]:
    """Every team the token can read that is not archived, as `id`, `key`, `name` and `workflow_ids`."""
    teams = []
    for node in _objects(client.get("/groups")):
        if node.get("archived") or not node.get("id"):
            continue
        teams.append(
            {
                "id": str(node["id"]),
                "key": str(node.get("mention_name") or ""),
                "name": str(node.get("name") or ""),
                "workflow_ids": [str(value) for value in node.get("workflow_ids") or []],
            }
        )
    return teams


def list_workflow_states(client: ShortcutClient) -> dict[str, dict[str, Any]]:
    """Every workflow state of the workspace by id, each with its `name`, `type` and workflow."""
    states: dict[str, dict[str, Any]] = {}
    for workflow in _objects(client.get("/workflows")):
        for state in workflow.get("states") or []:
            if isinstance(state, dict) and state.get("id") is not None:
                states[str(state["id"])] = {
                    "name": str(state.get("name") or ""),
                    "type": str(state.get("type") or ""),
                    "workflow_id": str(workflow.get("id") or ""),
                    "workflow": str(workflow.get("name") or ""),
                }
    return states


def list_members(client: ShortcutClient) -> dict[str, dict[str, str]]:
    """Every member of the workspace by id, with the lower cased `email` and the `name` of their profile."""
    members: dict[str, dict[str, str]] = {}
    for node in _objects(client.get("/members")):
        if not node.get("id"):
            continue
        profile = node.get("profile") if isinstance(node.get("profile"), dict) else {}
        members[str(node["id"])] = {
            "email": str(profile.get("email_address") or "").strip().lower(),
            "name": str(profile.get("name") or profile.get("mention_name") or "").strip(),
        }
    return members


def list_epics(client: ShortcutClient) -> list[dict[str, Any]]:
    """Every epic of the workspace."""
    return _objects(client.get("/epics"))


def list_iterations(client: ShortcutClient) -> list[dict[str, Any]]:
    """Every iteration of the workspace."""
    return _objects(client.get("/iterations"))


def team_stories(client: ShortcutClient, team_id: str, offset: int, limit: int) -> list[dict[str, Any]]:
    """One page of a team's stories in Shortcut's order, as the slim shape the list answers."""
    return _objects(client.get(f"/groups/{team_id}/stories", {"limit": limit, "offset": offset}))


def story(client: ShortcutClient, story_id: Any) -> dict[str, Any]:
    """One story in full: its description, comments, tasks, links and sub-task stories."""
    body = client.get(f"/stories/{int(story_id)}")
    if not isinstance(body, dict):
        raise ShortcutError("invalid_response")
    return body
