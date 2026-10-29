"""Pulse never carries a private ask.

Pulse is the feed of project and initiative updates, so an issue only ever
reaches it through the project it sits in. A private ask in a project that posts
an update leaves no trace of itself, its title or its id, in anyone's feed
outside the people it is open to.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, MEMBER, OWNER, make_private, sign_in
from tests.domains.planning.conftest import seed_issue, seed_project
from tests.domains.planning.test_pulse import _feed, _post_update


def test_a_private_ask_in_a_project_stays_out_of_pulse(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """The project's update reaches Pulse; the private ask inside it does not, for any outsider."""
    sign_in(client, ADMIN)
    project = seed_project(client, workspace, name="Launch")["project_id"]
    sign_in(issues_client, MEMBER)
    ask = seed_issue(issues_client, workspace, title="Confidential payroll ask", project_id=project)
    make_private(repositories, workspace, ask["id"])
    sign_in(client, ADMIN)
    _post_update(client, workspace, project, body="Launch is on track")

    for subject in (OWNER, ADMIN):
        sign_in(client, subject)
        feed = _feed(client, workspace, scope="recent")
        assert [item["project_id"] for item in feed["items"]] == [project]
        text = json.dumps(feed)
        assert ask["id"] not in text and "Confidential" not in text
