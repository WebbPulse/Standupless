"""Every request the client makes exists in the published OpenAPI document.

The client is hand-curated, so this is what stops it drifting from the API: each
method is called against a mock that records the request, and the method and path
must match an operation in `backend/openapi.json`.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx

from standupless_cli.client import StanduplessClient

DOCUMENT = Path(__file__).resolve().parents[2] / "backend" / "openapi.json"


def _operations() -> list[tuple[str, re.Pattern[str]]]:
    """Each documented method with its path template as a regex."""
    paths = json.loads(DOCUMENT.read_text())["paths"]
    return [
        (method.upper(), re.compile("^" + re.sub(r"\{[^}]+\}", "[^/]+", path) + "$"))
        for path, item in paths.items()
        for method in item
        if method in {"get", "post", "patch", "put", "delete"}
    ]


CALLS: list[tuple[str, Callable[[StanduplessClient], Any]]] = [
    ("list_workspaces", lambda c: c.list_workspaces()),
    ("list_documents", lambda c: c.list_documents("w", "project", "p")),
    ("get_document", lambda c: c.get_document("w", "d")),
    ("create_document", lambda c: c.create_document("w", "project", "p", {"title": "x"})),
    ("update_document", lambda c: c.update_document("w", "d", {"title": "x"})),
    ("delete_document", lambda c: c.delete_document("w", "d")),
    ("get_workspace", lambda c: c.get_workspace("w")),
    ("get_me", lambda c: c.get_me()),
    ("list_teams", lambda c: c.list_teams("w")),
    ("create_team", lambda c: c.create_team("w", {"name": "x", "key_prefix": "XX"})),
    ("update_team", lambda c: c.update_team("w", "t", {"sync_pr_labels": False})),
    ("update_workspace", lambda c: c.update_workspace("w", {"accent_color": "#1f7ae0"})),
    ("start_workspace_export", lambda c: c.start_workspace_export("w", {"include_emails": True})),
    ("get_workspace_export", lambda c: c.get_workspace_export("w", "e")),
    ("list_workspace_exports", lambda c: c.list_workspace_exports("w")),
    ("get_team_sync", lambda c: c.get_team_sync("w", "t")),
    ("put_team_sync", lambda c: c.put_team_sync("w", "t", {"repository_id": "r", "allow_public_two_way": True})),
    ("get_cycle_settings", lambda c: c.get_cycle_settings("w", "t")),
    ("update_cycle_settings", lambda c: c.update_cycle_settings("w", "t", {"move_unfinished": False})),
    ("get_standup", lambda c: c.get_standup("w", "t", "2026-10-06", "weekly")),
    ("get_standup_settings", lambda c: c.get_standup_settings("w", "t")),
    ("update_standup_settings", lambda c: c.update_standup_settings("w", "t", {"cadence": "daily"})),
    ("put_standup_note", lambda c: c.put_standup_note("w", "t", {"body": "x"})),
    ("delete_standup_note", lambda c: c.delete_standup_note("w", "t")),
    ("list_statuses", lambda c: c.list_statuses("w", "t")),
    ("list_templates", lambda c: c.list_templates("w", "t")),
    ("list_templates", lambda c: c.list_templates("w", None)),
    ("create_template", lambda c: c.create_template("w", "t", {"name": "Bug"})),
    ("create_template", lambda c: c.create_template("w", None, {"name": "Bug"})),
    ("delete_template", lambda c: c.delete_template("w", "t", "p")),
    ("delete_template", lambda c: c.delete_template("w", None, "p")),
    ("create_status", lambda c: c.create_status("w", "t", {"name": "x", "category": "started"})),
    ("update_status", lambda c: c.update_status("w", "t", "s", {"color": "blue"})),
    ("delete_status", lambda c: c.delete_status("w", "t", "s", "r")),
    ("override_status", lambda c: c.override_status("w", "t", "s", {"hidden": True})),
    ("clear_status_override", lambda c: c.clear_status_override("w", "t", "s")),
    ("list_workspace_statuses", lambda c: c.list_workspace_statuses("w")),
    ("create_workspace_status", lambda c: c.create_workspace_status("w", {"name": "x", "category": "started"})),
    ("update_workspace_status", lambda c: c.update_workspace_status("w", "s", {"name": "x"})),
    ("delete_workspace_status", lambda c: c.delete_workspace_status("w", "s", "r")),
    ("list_channels", lambda c: c.list_channels("w", "t")),
    ("create_channel", lambda c: c.create_channel("w", "t", {"url": "u", "events": ["issue_created"]})),
    ("update_channel", lambda c: c.update_channel("w", "t", "c", {"enabled": False})),
    ("delete_channel", lambda c: c.delete_channel("w", "t", "c")),
    ("test_channel", lambda c: c.test_channel("w", "t", "c")),
    ("list_labels", lambda c: c.list_labels("w", "t")),
    ("create_label", lambda c: c.create_label("w", "t", {"name": "x", "color": "#5e6ad2"})),
    ("update_label", lambda c: c.update_label("w", "t", "l", {"name": "x"})),
    ("delete_label", lambda c: c.delete_label("w", "t", "l")),
    ("override_label", lambda c: c.override_label("w", "t", "l", {"name": "x"})),
    ("clear_label_override", lambda c: c.clear_label_override("w", "t", "l")),
    ("list_workspace_labels", lambda c: c.list_workspace_labels("w")),
    ("create_workspace_label", lambda c: c.create_workspace_label("w", {"name": "x", "color": "#5e6ad2"})),
    ("update_workspace_label", lambda c: c.update_workspace_label("w", "l", {"name": "x"})),
    ("delete_workspace_label", lambda c: c.delete_workspace_label("w", "l")),
    ("list_members", lambda c: c.list_members("w")),
    ("list_issues", lambda c: c.list_issues("w", {})),
    ("export_issues", lambda c: list(c.export_issues("w", {}))),
    ("list_views", lambda c: c.list_views("w")),
    ("get_insights", lambda c: c.get_insights("w", {})),
    ("get_issue_by_key", lambda c: c.get_issue_by_key("w", "ENG-1")),
    ("create_issue", lambda c: c.create_issue("w", {"team_id": "t", "title": "x"})),
    ("update_issue", lambda c: c.update_issue("w", "i", {"title": "x"})),
    ("move_issue", lambda c: c.move_issue("w", "i", "t")),
    ("list_triage", lambda c: c.list_triage("w", "t")),
    ("triage_accept", lambda c: c.triage_accept("w", "i", {})),
    ("triage_decline", lambda c: c.triage_decline("w", "i", {})),
    ("triage_duplicate", lambda c: c.triage_duplicate("w", "i", "j")),
    ("triage_snooze", lambda c: c.triage_snooze("w", "i", {"until": None})),
    ("update_triage_settings", lambda c: c.update_triage_settings("w", "t", {"enabled": True})),
    ("list_comments", lambda c: c.list_comments("w", "i")),
    ("list_activity", lambda c: c.list_activity("w", "i", "mcp")),
    ("list_subscribers", lambda c: c.list_subscribers("w", "i")),
    ("subscribe", lambda c: c.subscribe("w", "i")),
    ("subscribe", lambda c: c.subscribe("w", "i", "u")),
    ("unsubscribe", lambda c: c.unsubscribe("w", "i")),
    ("unsubscribe", lambda c: c.unsubscribe("w", "i", "u")),
    ("create_comment", lambda c: c.create_comment("w", "i", {"body": "x"})),
    ("list_cycles", lambda c: c.list_cycles("w", "t")),
    ("list_projects", lambda c: c.list_projects("w")),
    ("get_project", lambda c: c.get_project("w", "p")),
    ("update_project", lambda c: c.update_project("w", "p", {"update_interval_days": 14})),
    ("list_initiatives", lambda c: c.list_initiatives("w")),
    ("get_initiative", lambda c: c.get_initiative("w", "i")),
    ("create_initiative", lambda c: c.create_initiative("w", {"name": "Grow"})),
    ("update_initiative", lambda c: c.update_initiative("w", "i", {"status": "active"})),
    ("delete_initiative", lambda c: c.delete_initiative("w", "i")),
    ("add_initiative_project", lambda c: c.add_initiative_project("w", "i", "p")),
    ("remove_initiative_project", lambda c: c.remove_initiative_project("w", "i", "p")),
    ("list_initiative_updates", lambda c: c.list_initiative_updates("w", "i")),
    ("create_initiative_update", lambda c: c.create_initiative_update("w", "i", {"body": "b", "health": "on_track"})),
    ("get_release_pipeline", lambda c: c.get_release_pipeline("w", "t")),
    ("set_release_pipeline", lambda c: c.set_release_pipeline("w", "t", {"stages": [{"name": "Production"}]})),
    ("list_releases", lambda c: c.list_releases("w", "t")),
    ("get_release", lambda c: c.get_release("w", "t", "r")),
    ("create_release", lambda c: c.create_release("w", "t", {"name": "x"})),
    ("advance_release", lambda c: c.advance_release("w", "t", "r", {"stage": "production"})),
    ("add_release_issues", lambda c: c.add_release_issues("w", "t", "r", {"issues": ["ENG-1"]})),
    ("backfill_releases", lambda c: c.backfill_releases("w", "t", {"environment": "production"})),
]


def test_every_client_method_is_covered() -> None:
    """A new client method has to be added to this contract test."""
    public = {name for name in vars(StanduplessClient) if not name.startswith("_") and name != "close"}
    assert public == {name for name, _ in CALLS}


@pytest.mark.parametrize(("name", "call"), CALLS, ids=[name for name, _ in CALLS])
def test_request_matches_a_documented_operation(name: str, call: Callable[[StanduplessClient], Any]) -> None:
    """The method and path the client sends are in the OpenAPI document."""
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        """Answer anything with an empty page."""
        seen.append(request)
        return httpx.Response(200, json={})

    with respx.mock(base_url="https://api.test") as router:
        router.route().mock(side_effect=record)
        with StanduplessClient("https://api.test", "wpk_x") as client:
            try:
                call(client)
            except (KeyError, TypeError):
                pass
    assert seen, name
    operations = _operations()
    for request in seen:
        path = request.url.path
        assert any(method == request.method and pattern.match(path) for method, pattern in operations), (
            f"{name} sends {request.method} {path}, which backend/openapi.json does not document"
        )
