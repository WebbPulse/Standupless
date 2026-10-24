"""A fake Shortcut REST API v3, answering the importer's requests from recorded response shapes.

It answers exactly the GET requests `app.domains.integrations.shortcut_api`
sends, from a workspace held in memory in Shortcut's own JSON shapes, recorded
from Shortcut's API reference: groups, workflows with their states, members with
their profiles, epics, iterations, a team's slim stories paged by `limit` and
`offset`, and full stories with comments, tasks, story links and sub-task
stories. A token not in `tokens` is refused with HTTP 401, as Shortcut refuses
one, and `rate_limit_next` answers that many requests with HTTP 429 and a
`Retry-After` header before serving again. No real Shortcut token or workspace is
ever involved.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx

FAKE_TOKEN = "sc-fake-token-00000000-0000-4000-8000-000000000000"
"""The token the fake accepts by default. It is not a Shortcut token and opens nothing anywhere else."""

TEAM_ID = "5f0c0000-0000-4000-8000-0000000000e1"
"""The sample Shortcut team, Engineering."""

OTHER_TEAM_ID = "5f0c0000-0000-4000-8000-0000000000e2"
"""A second Shortcut team the sample epics and stories partly belong to."""

MEL = "5f0c0000-0000-4000-8000-00000000a001"
"""A Shortcut member whose email matches the workspace member."""

RILEY = "5f0c0000-0000-4000-8000-00000000a002"
"""A Shortcut member the workspace does not have."""

PREFIX = "/api/v3"


@dataclass
class Request:
    """One request the fake answered: its path, query and whether the token was accepted."""

    path: str
    params: dict[str, str]
    authorized: bool


@dataclass
class FakeShortcut:
    """A Shortcut workspace in memory and the REST answers it gives."""

    tokens: set[str] = field(default_factory=lambda: {FAKE_TOKEN})
    groups: list[dict[str, Any]] = field(default_factory=list)
    workflows: list[dict[str, Any]] = field(default_factory=list)
    members: list[dict[str, Any]] = field(default_factory=list)
    epics: list[dict[str, Any]] = field(default_factory=list)
    iterations: list[dict[str, Any]] = field(default_factory=list)
    stories: list[dict[str, Any]] = field(default_factory=list)
    rate_limit_next: int = 0
    requests: list[Request] = field(default_factory=list)

    def story(self, story_id: int) -> dict[str, Any]:
        """One sample story by its Shortcut id."""
        return next(node for node in self.stories if node["id"] == story_id)

    def paths(self) -> list[str]:
        """Every path requested, in order."""
        return [request.path for request in self.requests]

    def answer(self, path: str, params: dict[str, str], token: Optional[str]) -> tuple[int, dict[str, str], Any]:
        """The status, headers and JSON body Shortcut would answer one GET with."""
        authorized = token in self.tokens
        self.requests.append(Request(path=path, params=params, authorized=authorized))
        if self.rate_limit_next > 0:
            self.rate_limit_next -= 1
            return 429, {"Retry-After": "2"}, {"message": "Rate limit exceeded"}
        if not authorized:
            return 401, {}, {"message": "Unauthorized"}
        if not path.startswith(PREFIX):
            return 404, {}, {"message": "Not found"}
        parts = path[len(PREFIX) :].strip("/").split("/")
        if parts == ["groups"]:
            return 200, {}, self.groups
        if parts == ["workflows"]:
            return 200, {}, self.workflows
        if parts == ["members"]:
            return 200, {}, self.members
        if parts == ["epics"]:
            return 200, {}, self.epics
        if parts == ["iterations"]:
            return 200, {}, self.iterations
        if len(parts) == 3 and parts[0] == "groups" and parts[2] == "stories":
            if not any(group["id"] == parts[1] for group in self.groups):
                return 404, {}, {"message": "Not found"}
            offset, limit = int(params.get("offset") or 0), int(params.get("limit") or 1000)
            mine = [node for node in self.stories if node.get("group_id") == parts[1]]
            return 200, {}, [slim(node) for node in mine[offset : offset + limit]]
        if len(parts) == 2 and parts[0] == "stories":
            found = next((node for node in self.stories if str(node["id"]) == parts[1]), None)
            if found is None:
                return 404, {}, {"message": "Not found"}
            return 200, {}, copy.deepcopy(found)
        return 404, {}, {"message": "Not found"}

    def transport(self) -> httpx.MockTransport:
        """An `httpx` transport that answers from this fake instead of the network."""

        def handle(request: httpx.Request) -> httpx.Response:
            """Answer one request the client sent."""
            status, headers, body = self.answer(
                request.url.path, dict(request.url.params), request.headers.get("Shortcut-Token")
            )
            return httpx.Response(status, headers=headers, json=body)

        return httpx.MockTransport(handle)


SLIM_FIELDS = (
    "id",
    "name",
    "app_url",
    "story_type",
    "workflow_state_id",
    "group_id",
    "labels",
    "owner_ids",
    "requested_by_id",
    "estimate",
    "deadline",
    "epic_id",
    "iteration_id",
    "parent_story_id",
    "created_at",
    "updated_at",
)
"""The fields Shortcut's story search and list answers carry; the rest come only with a story read in full."""


def slim(node: dict[str, Any]) -> dict[str, Any]:
    """The slim shape of one story, as `GET /groups/{id}/stories` answers it."""
    return {name: copy.deepcopy(node[name]) for name in SLIM_FIELDS if name in node}


def link(link_id: int, subject: int, verb: str, target: int) -> dict[str, Any]:
    """One Shortcut story link, as it appears on both of its stories."""
    return {
        "id": link_id,
        "entity_type": "story-link",
        "subject_id": subject,
        "object_id": target,
        "verb": verb,
        "created_at": "2026-09-03T09:00:00Z",
    }


def sample(member_email: str) -> FakeShortcut:
    """The sample Shortcut workspace: one team with four stories, an epic, an iteration and two people.

    Mel's email is `member_email`, mixed case as Shortcut stores what people
    typed, so matching by email is exercised. Riley matches no member.
    """
    blocks = link(900, 101, "blocks", 103)
    duplicates = link(901, 104, "duplicates", 101)
    relates = link(902, 104, "relates to", 102)
    fake = FakeShortcut()
    fake.groups = [
        {
            "id": TEAM_ID,
            "entity_type": "group",
            "mention_name": "eng",
            "name": "Engineering",
            "archived": False,
            "workflow_ids": [500000001],
        },
        {
            "id": OTHER_TEAM_ID,
            "entity_type": "group",
            "mention_name": "ops",
            "name": "Operations",
            "archived": False,
            "workflow_ids": [500000001],
        },
        {
            "id": "5f0c0000-0000-4000-8000-0000000000e3",
            "entity_type": "group",
            "mention_name": "old",
            "name": "Archived team",
            "archived": True,
            "workflow_ids": [],
        },
    ]
    fake.workflows = [
        {
            "id": 500000001,
            "entity_type": "workflow",
            "name": "Engineering",
            "default_state_id": 500000011,
            "states": [
                {"id": 500000010, "entity_type": "workflow-state", "name": "Backlog", "type": "backlog", "position": 0},
                {"id": 500000011, "entity_type": "workflow-state", "name": "Ready", "type": "unstarted", "position": 1},
                {
                    "id": 500000012,
                    "entity_type": "workflow-state",
                    "name": "In Development",
                    "type": "started",
                    "position": 2,
                },
                {"id": 500000013, "entity_type": "workflow-state", "name": "Done", "type": "done", "position": 3},
            ],
        }
    ]
    fake.members = [
        {
            "id": MEL,
            "entity_type": "member",
            "role": "member",
            "disabled": False,
            "profile": {
                "entity_type": "profile",
                "name": "Mel Member",
                "mention_name": "mel",
                "email_address": member_email.title(),
            },
        },
        {
            "id": RILEY,
            "entity_type": "member",
            "role": "member",
            "disabled": False,
            "profile": {
                "entity_type": "profile",
                "name": "Riley Stranger",
                "mention_name": "riley",
                "email_address": "riley@elsewhere.test",
            },
        },
    ]
    fake.epics = [
        {
            "id": 10,
            "entity_type": "epic",
            "name": "Importer",
            "description": "Move every team off Shortcut in one go.",
            "state": "in progress",
            "owner_ids": [RILEY, MEL],
            "group_ids": [TEAM_ID],
            "planned_start_date": "2026-09-01T00:00:00Z",
            "deadline": "2026-10-15T00:00:00Z",
            "created_at": "2026-08-01T09:00:00Z",
        },
        {
            "id": 11,
            "entity_type": "epic",
            "name": "Operations only",
            "description": "",
            "state": "to do",
            "owner_ids": [],
            "group_ids": [OTHER_TEAM_ID],
            "created_at": "2026-08-02T09:00:00Z",
        },
    ]
    fake.iterations = [
        {
            "id": 20,
            "entity_type": "iteration",
            "name": "Sprint 7",
            "description": "Ship the importer",
            "status": "started",
            "start_date": "2026-09-01",
            "end_date": "2026-09-14",
            "group_ids": [],
            "created_at": "2026-08-30T10:00:00Z",
        }
    ]
    fake.stories = [
        {
            "id": 101,
            "entity_type": "story",
            "name": "Import a Shortcut workspace",
            "app_url": "https://app.shortcut.com/acme/story/101",
            "description": "Read Shortcut's API and write every team.",
            "story_type": "feature",
            "workflow_state_id": 500000012,
            "group_id": TEAM_ID,
            "labels": [{"id": 300, "entity_type": "label", "name": "Frontend", "color": "#eb5757"}],
            "owner_ids": [MEL],
            "requested_by_id": MEL,
            "estimate": 3,
            "deadline": "2026-09-30T00:00:00Z",
            "epic_id": 10,
            "iteration_id": 20,
            "parent_story_id": None,
            "sub_task_story_ids": [102],
            "tasks": [
                {"id": 401, "description": "Write the rows", "complete": False, "position": 2},
                {"id": 400, "description": "Read the API", "complete": True, "position": 1},
            ],
            "story_links": [blocks, duplicates],
            "comments": [
                {
                    "id": 501,
                    "entity_type": "story-comment",
                    "author_id": MEL,
                    "text": "First pass is up.",
                    "created_at": "2026-09-02T09:00:00Z",
                    "deleted": False,
                },
                {
                    "id": 503,
                    "entity_type": "story-comment",
                    "author_id": MEL,
                    "text": "Agreed, thanks.",
                    "parent_id": 502,
                    "created_at": "2026-09-02T11:00:00Z",
                    "deleted": False,
                },
                {
                    "id": 502,
                    "entity_type": "story-comment",
                    "author_id": RILEY,
                    "text": "Looks good to me.",
                    "created_at": "2026-09-02T10:00:00Z",
                    "deleted": False,
                },
                {
                    "id": 504,
                    "entity_type": "story-comment",
                    "author_id": RILEY,
                    "text": "",
                    "created_at": "2026-09-02T12:00:00Z",
                    "deleted": True,
                },
            ],
            "created_at": "2026-09-01T09:00:00Z",
            "updated_at": "2026-09-05T09:00:00Z",
        },
        {
            "id": 102,
            "entity_type": "story",
            "name": "Map the fields",
            "app_url": "https://app.shortcut.com/acme/story/102",
            "description": "",
            "story_type": "chore",
            "workflow_state_id": 500000011,
            "group_id": TEAM_ID,
            "labels": [],
            "owner_ids": [RILEY],
            "requested_by_id": RILEY,
            "estimate": 7,
            "deadline": None,
            "epic_id": 10,
            "iteration_id": None,
            "parent_story_id": 101,
            "sub_task_story_ids": [],
            "tasks": [],
            "story_links": [relates],
            "comments": [],
            "created_at": "2026-09-01T10:00:00Z",
            "updated_at": "2026-09-01T10:00:00Z",
        },
        {
            "id": 103,
            "entity_type": "story",
            "name": "Ship it",
            "app_url": "https://app.shortcut.com/acme/story/103",
            "description": "Roll the importer out.",
            "story_type": "bug",
            "workflow_state_id": 500000013,
            "group_id": TEAM_ID,
            "labels": [],
            "owner_ids": [],
            "requested_by_id": MEL,
            "estimate": None,
            "deadline": None,
            "epic_id": None,
            "iteration_id": None,
            "parent_story_id": None,
            "sub_task_story_ids": [],
            "tasks": [],
            "story_links": [blocks],
            "comments": [],
            "created_at": "2026-09-01T11:00:00Z",
            "updated_at": "2026-09-01T11:00:00Z",
        },
        {
            "id": 104,
            "entity_type": "story",
            "name": "Import Shortcut by hand",
            "app_url": "https://app.shortcut.com/acme/story/104",
            "description": "",
            "story_type": "feature",
            "workflow_state_id": 500000010,
            "group_id": TEAM_ID,
            "labels": [],
            "owner_ids": [],
            "requested_by_id": RILEY,
            "estimate": None,
            "deadline": None,
            "epic_id": None,
            "iteration_id": None,
            "parent_story_id": None,
            "sub_task_story_ids": [],
            "tasks": [],
            "story_links": [duplicates, relates],
            "comments": [],
            "created_at": "2026-09-01T12:00:00Z",
            "updated_at": "2026-09-01T12:00:00Z",
        },
        {
            "id": 201,
            "entity_type": "story",
            "name": "Rotate the on call",
            "app_url": "https://app.shortcut.com/acme/story/201",
            "description": "",
            "story_type": "chore",
            "workflow_state_id": 500000011,
            "group_id": OTHER_TEAM_ID,
            "labels": [],
            "owner_ids": [],
            "requested_by_id": MEL,
            "estimate": None,
            "deadline": None,
            "epic_id": 11,
            "iteration_id": None,
            "parent_story_id": None,
            "sub_task_story_ids": [],
            "tasks": [],
            "story_links": [],
            "comments": [],
            "created_at": "2026-09-01T13:00:00Z",
            "updated_at": "2026-09-01T13:00:00Z",
        },
    ]
    return fake
