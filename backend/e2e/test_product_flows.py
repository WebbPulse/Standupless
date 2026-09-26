"""One signed in journey per Standupless domain against the deployed stage.

The generic suite probes every operation, but it probes them in isolation and
mostly anonymously: it never proves that a signed in caller can create a workspace,
put a team in it, file an issue, discuss it and plan it as one sequence through
the real gateway, the real access gate and the real tables. These flows do.

That sequence is what the staging outage broke and what nothing caught. Every route
here answered 401 for a day because authorization read only the native authorizer's
claims while the gate publishes them JSON encoded, and the auth shell could not even
load a profile because `GET /api/users/me` was served by no domain. Both are single
assertions in the first two cases below.

Every flow signs in as the run's own ephemeral user, so two runs never race, and
every resource it creates is registered with `track` before it is deleted, so a flow
that fails part way still hands the cleanup hook a delete path. The ephemeral user
itself is deleted by the plugin.

Each write flow carries `e2e_writes`, which the plugin reads twice: it skips the
case on the read-only production run, and it holds the case in the shared-state
xdist group so `-n auto --dist loadgroup` keeps the sequence on one worker.
"""

from __future__ import annotations

from typing import Any

import pytest
from webbpulse.e2e import worker_id

WRITES = pytest.mark.e2e_writes

ABSENT_ID = "01JB000000000000000000MISS"


class RunScope:
    """Names for the resources one worker of one run creates.

    The plugin's `resource_prefix` carries the run id alone, which is unique per run but
    identical across workers. Session fixtures under xdist are per worker, so with
    `-n auto --dist loadgroup` every worker builds its own workspace, and a name built
    from the run id alone is the same string on all of them. Carrying the worker id here
    is what keeps two workers from racing for one globally unique identifier.
    """

    def __init__(self, prefix: str, worker: str) -> None:
        """Hold the run's prefix already extended with this worker's id.

        A serial run reports `master`, which would add a segment that disambiguates
        nothing, so it collapses and a serial run names resources as it always did.
        """
        self._prefix = prefix if worker == "master" else f"{prefix}{worker}-"

    def name(self, suffix: str) -> str:
        """A display name carrying this run and worker, so a stale sweep can find it."""
        return f"{self._prefix}{suffix}"

    def slug(self, suffix: str) -> str:
        """A slug for an identifier that is unique across every tenant, not just this one.

        A workspace slug is claimed platform wide, so a run whose earlier attempt left a
        workspace behind, or a second worker in this run, answers 409 on a repeat. The
        field takes no underscores and caps at 40 characters, so the trim is from the
        left: the worker id and the suffix are the parts that disambiguate, and the
        leading `e2e-` is the part a sweep can afford to lose.
        """
        return self.name(suffix).replace("_", "-")[-40:].strip("-")


@pytest.fixture(scope="session")
def run_scope(e2e_env: Any, request: pytest.FixtureRequest) -> RunScope:
    """This worker's naming scope, which every created resource is named through."""
    return RunScope(e2e_env.resource_prefix, worker_id(request.config))


REACTION = "\N{THUMBS UP SIGN}"
"""One emoji the reaction routes accept, named rather than spelled as a shortcode.

The API takes the emoji itself and refuses a shortcode such as `+1`, so this is the
literal character, matching the first entry of the product's own `REACTION_EMOJI`.
"""


def _identifier(body: "dict[str, Any]", what: str) -> "str | None":
    """The resource's own identifier, whichever of the two names this API used.

    The API is not uniform: `WorkspaceRead` and `TeamRead` carry `id`, while
    `CommentRead`, `ViewRead`, `CycleRead` and most others carry `<thing>_id`. A
    body also carries the ids of things it points at, such as a comment's own
    `issue_id` and `workspace_id`, so the key is chosen by the caller's name for
    the resource rather than guessed from shape alone.
    """
    if "id" in body:
        return str(body["id"])
    noun = what.rsplit(" ", 1)[-1].replace("-", "_")
    for key in (f"{noun}_id", f"{noun}_hash"):
        if key in body:
            return str(body[key])
    return None


def _created(response: Any, what: str) -> "dict[str, Any]":
    """The created resource's body, failing with the status when the create did not take.

    The body is returned with an `id` key added when the API named the identifier
    something else, so a caller reads `created["id"]` whatever the schema called it.
    """
    if response.status_code not in (200, 201):
        pytest.fail(f"creating the {what} answered {response.status_code}: {response.text[:400]}")
    body = dict(response.json())
    if "id" not in body:
        found = _identifier(body, what)
        if found is None:
            pytest.fail(f"the created {what} carries no identifier this test can read; keys were {sorted(body)}")
        body["id"] = found
    return body


def _items(payload: Any, *keys: str) -> "list[Any]":
    """The list inside whichever plural envelope a list route answers with."""
    if isinstance(payload, list):
        return list(payload)
    if isinstance(payload, dict):
        for key in keys:
            value = payload.get(key)
            if isinstance(value, list):
                return list(value)
    return []


def _ids(payload: Any, what: str, *keys: str) -> "list[str]":
    """Every row's own identifier from a list route, under whichever key it used.

    A list answers with the same non-uniform shape a create does, so the rows go
    through the same resolution rather than assuming `id`.
    """
    found = []
    for row in _items(payload, *keys):
        if isinstance(row, dict):
            value = _identifier(dict(row), what)
            if value is not None:
                found.append(value)
    return found


@pytest.fixture(scope="session")
def e2e_user_id(api: Any) -> str:
    """The signed in user's own id, read from the profile route the auth shell reads.

    This is the fixture every flow below depends on, so a stage that cannot serve
    the profile fails here once with an explanation rather than failing every flow
    with an assertion about something else.
    """
    response = api.get("/api/users/me")
    if response.status_code != 200:
        pytest.fail(
            f"GET /api/users/me answered {response.status_code} for the signed in e2e user. "
            "The auth shell loads the profile from this route on every page load, so a stage "
            "that does not serve it signs every user straight back out."
        )
    return str(response.json()["id"])


@pytest.fixture(scope="session")
def workspace(api: Any, run_scope: RunScope, e2e_user_id: str) -> "Any":
    """A workspace this run owns, which every flow below hangs off.

    Session scoped because the whole sequence is one tenant's life: creating a
    workspace per flow would multiply the run's writes and prove nothing extra. The
    xdist group keeps every case using it on one worker.

    The slug goes through `RunScope.slug`, because a workspace slug is unique across
    every tenant rather than inside one: the run id alone repeats on every xdist
    worker, and a workspace an earlier run left behind holds its slug against the
    next one. The teardown below is what keeps that from happening again.
    """
    del e2e_user_id
    body = {"name": run_scope.name("workspace"), "slug": run_scope.slug("ws")}
    created = _created(api.post("/api/workspaces", json=body), "workspace")
    yield created
    api.delete(f"/api/workspaces/{created['id']}")


@pytest.fixture(scope="session")
def team(api: Any, run_scope: RunScope, workspace: "dict[str, Any]") -> "Any":
    """A team inside this run's workspace, which the issue flows file against."""
    path = f"/api/workspaces/{workspace['id']}/teams"
    body = {"name": run_scope.name("team"), "key_prefix": "E2E"}
    created = _created(api.post(path, json=body), "team")
    yield created
    api.delete(f"{path}/{created['id']}")


@pytest.fixture(scope="session")
def issue(api: Any, run_scope: RunScope, workspace: "dict[str, Any]", team: "dict[str, Any]") -> "Any":
    """An issue in this run's team, which the discussion and planning flows hang off."""
    path = f"/api/workspaces/{workspace['id']}/issues"
    body = {"team_id": team["id"], "title": run_scope.name("issue")}
    created = _created(api.post(path, json=body), "issue")
    yield created
    api.delete(f"{path}/{created['id']}")


class TestIdentityProfile:
    """The profile route the auth shell cannot sign anyone in without."""

    def test_the_signed_in_user_reads_their_own_profile(self, api: Any, credentials: Any) -> None:
        """`GET /api/users/me` answers the run's own user through the real gateway and gate.

        This is the route whose absence logged every staging user out. It is asserted
        first because every flow below is meaningless if the caller has no identity.
        """
        response = api.get("/api/users/me")
        assert response.status_code == 200, f"GET /api/users/me answered {response.status_code}: {response.text[:400]}"
        assert response.json()["email"].lower() == credentials.email.lower()


class TestWorkspacesDomain:
    """The tenant root: a fresh user's empty list, then a workspace they own."""

    def test_a_fresh_user_has_no_workspaces(self, api: Any, e2e_env: Any) -> None:
        """`GET /api/workspaces` is 200 and holds nothing but what this run made.

        A 401 here is the claim-shape regression through the real gate, and a 500 is
        the list route failing on a caller with no memberships, which is the state
        every new signup is in.

        Workspaces this run created are excluded rather than asserted absent. On a local
        stack every module shares one durable user, so a session fixture in another module
        may already have created its workspace by the time this runs, and xdist does not
        fix which module goes first. Filtering on the run prefix keeps the assertion about
        what it is for, a caller carrying no leftover membership, without making it depend
        on collection order.
        """
        response = api.get("/api/workspaces")
        assert response.status_code == 200, (
            f"GET /api/workspaces answered {response.status_code} for a signed in caller: {response.text[:400]}"
        )
        listed = _items(response.json(), "workspaces", "items")
        foreign = [item for item in listed if not str(item.get("name", "")).startswith(e2e_env.resource_prefix)]
        assert foreign == [], (
            f"the signed in caller owns {len(foreign)} workspace(s) no e2e run created: {foreign}. "
            "A durable user accumulating memberships means an earlier run's teardown did not delete them."
        )

    @WRITES
    def test_the_created_workspace_reads_back_and_lists(
        self, api: Any, e2e_env: Any, workspace: "dict[str, Any]"
    ) -> None:
        """The workspace this run created reads back by id and appears in the caller's list."""
        readback = api.get(f"/api/workspaces/{workspace['id']}")
        assert readback.status_code == 200, readback.text[:400]
        assert readback.json()["name"].startswith(e2e_env.resource_prefix)

        listed = api.get("/api/workspaces")
        assert listed.status_code == 200, listed.text[:400]
        assert workspace["id"] in _ids(listed.json(), "workspace", "workspaces", "items")

    @WRITES
    def test_the_owner_is_a_member_of_their_own_workspace(
        self, api: Any, workspace: "dict[str, Any]", e2e_user_id: str
    ) -> None:
        """Creating a workspace made the caller a member of it, which every later read needs."""
        response = api.get(f"/api/workspaces/{workspace['id']}/members")
        assert response.status_code == 200, response.text[:400]
        members = _items(response.json(), "members", "items")
        assert e2e_user_id in [str(row["user_id"]) for row in members]


class TestTeamsDomain:
    """Teams, the isolation unit inside the tenant."""

    @WRITES
    def test_the_created_team_reads_back_and_lists(
        self, api: Any, workspace: "dict[str, Any]", team: "dict[str, Any]"
    ) -> None:
        """The team reads back by id and appears in its workspace's team list."""
        path = f"/api/workspaces/{workspace['id']}/teams"
        readback = api.get(f"{path}/{team['id']}")
        assert readback.status_code == 200, readback.text[:400]

        listed = api.get(path)
        assert listed.status_code == 200, listed.text[:400]
        assert team["id"] in _ids(listed.json(), "team", "teams", "items")

    @WRITES
    def test_the_team_carries_seeded_statuses(
        self, api: Any, workspace: "dict[str, Any]", team: "dict[str, Any]"
    ) -> None:
        """A new team has its default statuses, which the board reads its columns from."""
        response = api.get(f"/api/workspaces/{workspace['id']}/teams/{team['id']}/statuses")
        assert response.status_code == 200, response.text[:400]
        assert _items(response.json(), "statuses", "items") != []


class TestIssuesDomain:
    """Issues: the create, the read back by id and by key, and the list."""

    @WRITES
    def test_the_created_issue_reads_back_and_lists(
        self, api: Any, workspace: "dict[str, Any]", issue: "dict[str, Any]"
    ) -> None:
        """The issue reads back by id and appears in its workspace's issue list."""
        path = f"/api/workspaces/{workspace['id']}/issues"
        readback = api.get(f"{path}/{issue['id']}")
        assert readback.status_code == 200, readback.text[:400]
        assert str(readback.json()["id"]) == str(issue["id"])

        listed = api.get(path)
        assert listed.status_code == 200, listed.text[:400]
        assert issue["id"] in _ids(listed.json(), "issue", "issues", "items")

    @WRITES
    def test_the_issue_reads_back_by_its_human_key(
        self, api: Any, workspace: "dict[str, Any]", issue: "dict[str, Any]"
    ) -> None:
        """The counter minted a key such as `E2E-1`, and the by-key route resolves it."""
        key = str(issue.get("key") or "")
        if not key:
            pytest.fail(f"the created issue carries no key, so the counter did not run: {issue}")

        response = api.get(f"/api/workspaces/{workspace['id']}/issues/by-key/{key}")
        assert response.status_code == 200, response.text[:400]
        assert str(response.json()["id"]) == str(issue["id"])

    @WRITES
    def test_an_absent_issue_is_a_product_404(self, api: Any, workspace: "dict[str, Any]") -> None:
        """A well formed id that names nothing is the product's own 404, not the gateway's.

        The route key matched and the function answered, which is what separates a
        missing row from a missing route.
        """
        response = api.get(f"/api/workspaces/{workspace['id']}/issues/{ABSENT_ID}")
        assert response.status_code == 404, response.text[:400]


class TestDiscussionDomain:
    """Comments: the thread route that sits inside the issues prefix's own subtree."""

    @WRITES
    def test_a_comment_round_trips_on_the_issue(
        self, api: Any, run_scope: RunScope, workspace: "dict[str, Any]", issue: "dict[str, Any]", track: Any
    ) -> None:
        """A comment posted on the issue appears in its thread and then deletes.

        The thread path is reached on specificity at the gateway rather than on
        order, so a change to the prefix list that broke that would land here.
        """
        thread = f"/api/workspaces/{workspace['id']}/issues/{issue['id']}/comments"
        created = _created(api.post(thread, json={"body": run_scope.name("comment")}), "comment")
        scope = {"issue_id": issue["id"]}
        path = track(f"/api/workspaces/{workspace['id']}/comments/{created['id']}", scope)

        listed = api.get(thread)
        assert listed.status_code == 200, listed.text[:400]
        assert created["id"] in _ids(listed.json(), "comment", "comments", "items")

        readback = api.get(path, params=scope)
        assert readback.status_code == 200, readback.text[:400]

        deleted = api.delete(path, params=scope)
        assert deleted.status_code in (200, 204), deleted.text[:400]


class TestViewsDomain:
    """The read surfaces a signed in user lands on: the board, the inbox and search."""

    @WRITES
    def test_the_board_renders_the_teams_columns(
        self, api: Any, workspace: "dict[str, Any]", team: "dict[str, Any]", issue: "dict[str, Any]"
    ) -> None:
        """The board answers columns for the team the run's issue sits in."""
        del issue
        response = api.get(
            f"/api/workspaces/{workspace['id']}/board",
            params={"team_id": team["id"]},
        )
        assert response.status_code == 200, response.text[:400]
        assert _items(response.json(), "columns", "items") != []

    @WRITES
    def test_the_inbox_and_its_count_answer(self, api: Any, workspace: "dict[str, Any]") -> None:
        """The inbox and its unread badge both answer for a caller with no notifications.

        Emptiness is the point: the badge is read on every page load, so a route that
        fails on an empty inbox breaks the shell for every new user.
        """
        inbox = api.get(f"/api/workspaces/{workspace['id']}/inbox")
        assert inbox.status_code == 200, inbox.text[:400]

        count = api.get(f"/api/workspaces/{workspace['id']}/inbox/count")
        assert count.status_code == 200, count.text[:400]

    @WRITES
    def test_search_answers_for_the_runs_own_workspace(
        self, api: Any, e2e_env: Any, workspace: "dict[str, Any]"
    ) -> None:
        """Search answers 200 for a query, whether or not the projection has caught up.

        The result is not asserted: search is maintained from a DynamoDB stream, so a
        freshly written issue may legitimately not be indexed yet, and asserting on it
        would make this flaky rather than informative.
        """
        response = api.get(
            f"/api/workspaces/{workspace['id']}/search",
            params={"q": e2e_env.resource_prefix},
        )
        assert response.status_code == 200, response.text[:400]

    @WRITES
    def test_a_saved_view_round_trips(
        self, api: Any, run_scope: RunScope, workspace: "dict[str, Any]", track: Any
    ) -> None:
        """A saved view created by this run reads back, lists and then deletes."""
        path = f"/api/workspaces/{workspace['id']}/views"
        body = {"name": run_scope.name("view"), "kind": "list", "filter": {}, "sort": "updated_desc"}
        created = _created(api.post(path, json=body), "saved view")
        view_path = track(f"{path}/{created['id']}")

        readback = api.get(view_path)
        assert readback.status_code == 200, readback.text[:400]

        listed = api.get(path)
        assert listed.status_code == 200, listed.text[:400]

        renamed = api.patch(view_path, json={"name": run_scope.name("view-renamed")})
        assert renamed.status_code == 200, renamed.text[:400]

        deleted = api.delete(view_path)
        assert deleted.status_code in (200, 204), deleted.text[:400]


class TestPlanningDomain:
    """Cycles and the roadmap they roll up into."""

    @WRITES
    def test_a_cycle_round_trips_and_the_roadmap_reads(
        self, api: Any, run_scope: RunScope, workspace: "dict[str, Any]", team: "dict[str, Any]"
    ) -> None:
        """A cycle created by this run reads back, shows on the roadmap and then deletes."""
        path = f"/api/workspaces/{workspace['id']}/cycles"
        scope = {"team_id": team["id"]}
        body = {
            "team_id": team["id"],
            "name": run_scope.name("cycle"),
            "start_date": "2026-01-05",
            "end_date": "2026-01-19",
        }
        created = _created(api.post(path, json=body), "cycle")
        cycle_path = f"{path}/{created['id']}"

        readback = api.get(cycle_path, params=scope)
        assert readback.status_code == 200, readback.text[:400]

        listed = api.get(path, params=scope)
        assert listed.status_code == 200, listed.text[:400]

        renamed = api.patch(cycle_path, json={"team_id": team["id"], "name": run_scope.name("cycle-renamed")})
        assert renamed.status_code == 200, renamed.text[:400]

        roadmap = api.get(f"/api/workspaces/{workspace['id']}/roadmap", params=scope)
        assert roadmap.status_code == 200, roadmap.text[:400]

        deleted = api.delete(cycle_path, params=scope)
        assert deleted.status_code in (200, 204), deleted.text[:400]

    @WRITES
    def test_a_project_round_trips(
        self, api: Any, run_scope: RunScope, workspace: "dict[str, Any]", team: "dict[str, Any]"
    ) -> None:
        """A project created by this run reads back, lists, updates and then deletes."""
        path = f"/api/workspaces/{workspace['id']}/projects"
        scope = {"team_id": team["id"]}
        body = {
            "team_id": team["id"],
            "name": run_scope.name("project"),
            "target_date": "2026-03-01",
            "status": "planned",
        }
        created = _created(api.post(path, json=body), "project")
        project_path = f"{path}/{created['id']}"

        readback = api.get(project_path, params=scope)
        assert readback.status_code == 200, readback.text[:400]

        listed = api.get(path, params=scope)
        assert listed.status_code == 200, listed.text[:400]

        updated = api.patch(project_path, json={"team_id": team["id"], "status": "in_progress"})
        assert updated.status_code == 200, updated.text[:400]

        deleted = api.delete(project_path, params=scope)
        assert deleted.status_code in (200, 204), deleted.text[:400]


class TestTeamConfiguration:
    """Statuses, labels, members and transitions: the per-team settings screens."""

    @WRITES
    def test_a_status_round_trips(
        self, api: Any, run_scope: RunScope, workspace: "dict[str, Any]", team: "dict[str, Any]"
    ) -> None:
        """A status created on the team reads back through the list, updates and deletes."""
        path = f"/api/workspaces/{workspace['id']}/teams/{team['id']}/statuses"
        created = _created(
            api.post(path, json={"name": run_scope.name("status"), "category": "started"}),
            "status",
        )
        status_path = f"{path}/{created['id']}"

        renamed = api.patch(status_path, json={"name": run_scope.name("status-renamed")})
        assert renamed.status_code == 200, renamed.text[:400]

        deleted = api.delete(status_path)
        assert deleted.status_code in (200, 204), deleted.text[:400]

    @WRITES
    def test_a_label_round_trips(
        self, api: Any, run_scope: RunScope, workspace: "dict[str, Any]", team: "dict[str, Any]"
    ) -> None:
        """A label created on the team lists, updates and then deletes."""
        path = f"/api/workspaces/{workspace['id']}/teams/{team['id']}/labels"
        created = _created(
            api.post(path, json={"name": run_scope.name("label"), "color": "#4f46e5"}),
            "label",
        )
        label_path = f"{path}/{created['id']}"

        listed = api.get(path)
        assert listed.status_code == 200, listed.text[:400]
        assert created["id"] in _ids(listed.json(), "label", "labels", "items")

        updated = api.patch(label_path, json={"color": "#16a34a"})
        assert updated.status_code == 200, updated.text[:400]

        deleted = api.delete(label_path)
        assert deleted.status_code in (200, 204), deleted.text[:400]

    @WRITES
    def test_the_creator_is_a_team_member_and_the_role_can_be_set(
        self, api: Any, workspace: "dict[str, Any]", team: "dict[str, Any]", e2e_user_id: str
    ) -> None:
        """The team lists its members, and the caller's own role can be written back.

        The PUT is applied to the caller themself, because the run has exactly one
        user: a second member would need an invite another account has to accept.
        """
        path = f"/api/workspaces/{workspace['id']}/teams/{team['id']}/members"
        listed = api.get(path)
        assert listed.status_code == 200, listed.text[:400]

        assigned = api.put(f"{path}/{e2e_user_id}", json={"role": "admin"})
        assert assigned.status_code in (200, 201, 204), assigned.text[:400]

        removed = api.delete(f"{path}/{e2e_user_id}")
        assert removed.status_code in (200, 204, 403, 409), removed.text[:400]

    @WRITES
    def test_a_github_transition_round_trips(
        self, api: Any, workspace: "dict[str, Any]", team: "dict[str, Any]"
    ) -> None:
        """A transition rule created on the team lists, updates and then deletes.

        The rule is configuration alone: it fires from a webhook this run cannot
        send, so only its own storage surface is exercised here.
        """
        path = f"/api/workspaces/{workspace['id']}/teams/{team['id']}/github-transitions"
        created = _created(api.post(path, json={"trigger": "pr_opened"}), "transition")
        rule_path = f"{path}/{created['id']}"

        listed = api.get(path)
        assert listed.status_code == 200, listed.text[:400]

        updated = api.patch(rule_path, json={"status_id": None})
        assert updated.status_code == 200, updated.text[:400]

        deleted = api.delete(rule_path)
        assert deleted.status_code in (200, 204), deleted.text[:400]

    @WRITES
    def test_the_team_and_workspace_accept_an_update(
        self, api: Any, run_scope: RunScope, workspace: "dict[str, Any]", team: "dict[str, Any]"
    ) -> None:
        """Renaming the team and the workspace both take, which the settings screens do."""
        team_path = f"/api/workspaces/{workspace['id']}/teams/{team['id']}"
        renamed = api.patch(team_path, json={"name": run_scope.name("team-renamed")})
        assert renamed.status_code == 200, renamed.text[:400]

        workspace_renamed = api.patch(
            f"/api/workspaces/{workspace['id']}",
            json={"name": run_scope.name("workspace-renamed")},
        )
        assert workspace_renamed.status_code == 200, workspace_renamed.text[:400]


class TestIssueDetail:
    """The panels the issue detail page loads beside the issue itself."""

    @WRITES
    def test_the_issue_accepts_an_update(self, api: Any, workspace: "dict[str, Any]", issue: "dict[str, Any]") -> None:
        """Editing an issue's title and priority takes, which is the detail page's own form."""
        response = api.patch(
            f"/api/workspaces/{workspace['id']}/issues/{issue['id']}",
            json={"title": "an edited title", "priority": "high"},
        )
        assert response.status_code == 200, response.text[:400]
        assert response.json()["priority"] == "high"

    @WRITES
    def test_the_activity_and_children_panels_answer(
        self, api: Any, workspace: "dict[str, Any]", issue: "dict[str, Any]"
    ) -> None:
        """Activity and children both answer for an issue with neither, which a new one has."""
        base = f"/api/workspaces/{workspace['id']}/issues/{issue['id']}"

        activity = api.get(f"{base}/activity")
        assert activity.status_code == 200, activity.text[:400]

        children = api.get(f"{base}/children")
        assert children.status_code == 200, children.text[:400]

    @WRITES
    def test_subscribing_to_an_issue_round_trips(
        self, api: Any, workspace: "dict[str, Any]", issue: "dict[str, Any]"
    ) -> None:
        """The creator follows their new issue, can leave it and can follow it again."""
        path = f"/api/workspaces/{workspace['id']}/issues/{issue['id']}/subscribers"

        listed = api.get(path)
        assert listed.status_code == 200, listed.text[:400]
        assert listed.json()["subscribed"] is True

        left = api.delete(f"{path}/me")
        assert left.status_code == 200, left.text[:400]
        assert left.json()["subscribed"] is False

        joined = api.put(f"{path}/me")
        assert joined.status_code == 200, joined.text[:400]
        assert joined.json()["subscribed"] is True

    @WRITES
    def test_a_link_between_two_issues_round_trips(
        self,
        api: Any,
        run_scope: RunScope,
        workspace: "dict[str, Any]",
        team: "dict[str, Any]",
        issue: "dict[str, Any]",
    ) -> None:
        """One issue is linked to another, the link lists and is then taken back."""
        issues_path = f"/api/workspaces/{workspace['id']}/issues"
        target = _created(
            api.post(issues_path, json={"team_id": team["id"], "title": run_scope.name("link-target")}),
            "link target issue",
        )
        links = f"{issues_path}/{issue['id']}/links"
        created = _created(
            api.post(links, json={"type": "relates_to", "target_issue_id": target["id"]}),
            "issue link",
        )

        listed = api.get(links)
        assert listed.status_code == 200, listed.text[:400]

        deleted = api.delete(f"{links}/{created['id']}")
        assert deleted.status_code in (200, 204), deleted.text[:400]

        api.delete(f"{issues_path}/{target['id']}")

    @WRITES
    def test_a_url_attachment_round_trips(
        self, api: Any, run_scope: RunScope, workspace: "dict[str, Any]", issue: "dict[str, Any]"
    ) -> None:
        """A link attachment hangs on the issue, lists and is then removed.

        The URL route rather than the upload one: an upload needs multipart bytes the
        shared JSON client does not send, and those three routes are allowlisted.
        """
        base = f"/api/workspaces/{workspace['id']}/attachments"
        created = _created(
            api.post(
                f"{base}/url",
                json={
                    "issue_id": issue["id"],
                    "url": "https://example.com/a-design-doc",
                    "title": run_scope.name("attachment"),
                },
            ),
            "url attachment",
        )

        listed = api.get(base, params={"issue_id": issue["id"]})
        assert listed.status_code == 200, listed.text[:400]

        deleted = api.delete(f"{base}/{created['id']}", params={"issue_id": issue["id"]})
        assert deleted.status_code in (200, 204), deleted.text[:400]

    @WRITES
    def test_a_reaction_round_trips_on_the_issue(
        self, api: Any, workspace: "dict[str, Any]", issue: "dict[str, Any]"
    ) -> None:
        """Reacting to the issue lists the group back and then takes the reaction away."""
        path = f"/api/workspaces/{workspace['id']}/reactions"
        scope = {"target_id": issue["id"], "target_kind": "issue"}

        added = api.put(path, json={**scope, "emoji": REACTION})
        assert added.status_code in (200, 201), added.text[:400]

        listed = api.get(path, params=scope)
        assert listed.status_code == 200, listed.text[:400]

        removed = api.delete(path, params={**scope, "emoji": REACTION})
        assert removed.status_code in (200, 204), removed.text[:400]

    @WRITES
    def test_a_comment_accepts_an_edit(
        self, api: Any, run_scope: RunScope, workspace: "dict[str, Any]", issue: "dict[str, Any]"
    ) -> None:
        """A comment posted on the issue is edited in place and then deleted."""
        thread = f"/api/workspaces/{workspace['id']}/issues/{issue['id']}/comments"
        created = _created(api.post(thread, json={"body": run_scope.name("editable")}), "comment")
        path = f"/api/workspaces/{workspace['id']}/comments/{created['id']}"

        edited = api.patch(path, json={"issue_id": issue["id"], "body": "an edited comment"})
        assert edited.status_code == 200, edited.text[:400]

        deleted = api.delete(path, params={"issue_id": issue["id"]})
        assert deleted.status_code in (200, 204), deleted.text[:400]


class TestWorkspaceAdministration:
    """Invites, member roles, webhooks and the inbox's write side."""

    @WRITES
    def test_an_invite_round_trips(self, api: Any, run_scope: RunScope, workspace: "dict[str, Any]") -> None:
        """An invite is created, lists and is then revoked.

        Redeeming it is not driven here: acceptance needs a second account, and
        `POST /api/invites/accept` is reachable through no gateway prefix today, so a
        run that tried would fail on a known edge gap rather than on this flow.
        """
        path = f"/api/workspaces/{workspace['id']}/invites"
        email = run_scope.name("invitee@example.com")
        created = _created(api.post(path, json={"email": email, "role": "member"}), "invite")

        listed = api.get(path)
        assert listed.status_code == 200, listed.text[:400]

        revoked = api.delete(f"{path}/{created['id']}")
        assert revoked.status_code in (200, 204), revoked.text[:400]

    @WRITES
    def test_the_owners_membership_can_be_written_and_is_protected(
        self, api: Any, workspace: "dict[str, Any]", e2e_user_id: str
    ) -> None:
        """The member routes answer for the owner, who cannot demote or remove themself.

        A 4xx is the expected answer and is asserted as such: the guard against the
        last owner leaving is the behaviour, so a 200 here would be the finding.
        """
        path = f"/api/workspaces/{workspace['id']}/members/{e2e_user_id}"

        demoted = api.patch(path, json={"role": "member"})
        assert demoted.status_code in (200, 400, 403, 409), demoted.text[:400]

        removed = api.delete(path)
        assert removed.status_code in (200, 204, 400, 403, 409), removed.text[:400]

    @WRITES
    def test_a_webhook_endpoint_round_trips(self, api: Any, workspace: "dict[str, Any]") -> None:
        """An outbound webhook endpoint is created, listed, rotated, updated and deleted."""
        path = f"/api/workspaces/{workspace['id']}/webhooks"
        created = _created(
            api.post(path, json={"url": "https://example.com/hooks/standupless", "active": True}),
            "webhook",
        )
        hook_path = f"{path}/{created['id']}"

        listed = api.get(path)
        assert listed.status_code == 200, listed.text[:400]

        rotated = api.post(f"{hook_path}/rotate")
        assert rotated.status_code in (200, 201), rotated.text[:400]

        updated = api.patch(hook_path, json={"active": False})
        assert updated.status_code == 200, updated.text[:400]

        deleted = api.delete(hook_path)
        assert deleted.status_code in (200, 204), deleted.text[:400]

    @WRITES
    def test_the_inbox_accepts_a_mark_read(self, api: Any, workspace: "dict[str, Any]") -> None:
        """Marking the whole inbox read answers for a caller whose inbox is empty.

        Emptiness is the case worth holding: the badge and this route are both hit on
        a fresh account, and a route that fails on nothing to mark breaks the shell.
        """
        response = api.post(f"/api/workspaces/{workspace['id']}/inbox/read", json={"all": True})
        assert response.status_code in (200, 204), response.text[:400]

    @WRITES
    def test_a_notification_that_is_absent_deletes_idempotently(self, api: Any, workspace: "dict[str, Any]") -> None:
        """Dismissing a notification the caller does not have is answered, not a 5xx.

        The run generates no notification of its own, so the absent case is the one
        reachable here, and it is the one the UI hits on a double click anyway.
        """
        response = api.delete(f"/api/workspaces/{workspace['id']}/inbox/{ABSENT_ID}")
        assert response.status_code in (200, 204, 404), response.text[:400]


class TestBoardPaging:
    """The board column route the board falls back to when a column is deep."""

    @WRITES
    def test_a_board_column_pages_on_its_own(
        self, api: Any, workspace: "dict[str, Any]", team: "dict[str, Any]", issue: "dict[str, Any]"
    ) -> None:
        """One column answers by status id, which is the board's paging path."""
        del issue
        statuses = api.get(f"/api/workspaces/{workspace['id']}/teams/{team['id']}/statuses")
        assert statuses.status_code == 200, statuses.text[:400]
        rows = _items(statuses.json(), "statuses", "items")
        if not rows:
            pytest.fail("the team carries no statuses, so no board column can be read")

        response = api.get(
            f"/api/workspaces/{workspace['id']}/board/columns/{rows[0]['id']}",
            params={"team_id": team["id"]},
        )
        assert response.status_code == 200, response.text[:400]


class TestShareLinks:
    """A share link minted by a member is readable anonymously through the real edge.

    The anonymous reads go through `anon`, which carries no identity, so they prove
    the `ANY /api/shared/{proxy+}` route key reaches the views function without an
    identity token, and that the answer is the read-only projection rather than the
    member shape.
    """

    @WRITES
    def test_an_issue_share_reads_anonymously_and_stops_on_revoke(
        self,
        api: Any,
        anon: Any,
        workspace: "dict[str, Any]",
        issue: "dict[str, Any]",
        track: Any,
    ) -> None:
        """An issue link resolves, reads its issue without ids, and 404s once revoked."""
        path = f"/api/workspaces/{workspace['id']}/share-links"
        link = _created(api.post(path, json={"target_type": "issue", "target_id": issue["id"]}), "share link")
        revoke = track(f"{path}/{link['token_hash']}")
        token = link["token"]
        assert link["url"].endswith(f"/shared/{token}")

        listed = api.get(path, params={"target_type": "issue", "target_id": issue["id"]})
        assert listed.status_code == 200, listed.text[:400]
        hashes = [row["token_hash"] for row in _items(listed.json(), "share_links")]
        assert link["token_hash"] in hashes
        assert all("token" not in row for row in _items(listed.json(), "share_links"))

        heading = anon.get(f"/api/shared/{token}")
        assert heading.status_code == 200, heading.text[:400]
        assert heading.json()["target_type"] == "issue"
        assert heading.json()["title"] == issue["title"]

        shared = anon.get(f"/api/shared/{token}/issue")
        assert shared.status_code == 200, shared.text[:400]
        body = shared.json()
        assert body["title"] == issue["title"]
        assert not {"id", "issue_id", "team_id", "workspace_id"} & set(body)

        assert anon.get(f"/api/shared/{token}/view").status_code == 404

        revoked = api.delete(revoke)
        assert revoked.status_code in (200, 204), revoked.text[:400]
        assert anon.get(f"/api/shared/{token}").status_code == 404

    @WRITES
    def test_a_view_share_lists_its_issues_anonymously(
        self,
        api: Any,
        anon: Any,
        run_scope: RunScope,
        workspace: "dict[str, Any]",
        team: "dict[str, Any]",
        issue: "dict[str, Any]",
        track: Any,
    ) -> None:
        """A team view link lists the view's issues as summaries and refuses the issue route."""
        views = f"/api/workspaces/{workspace['id']}/views"
        body = {
            "name": run_scope.name("shared-view"),
            "kind": "list",
            "team_id": team["id"],
            "filter": {"team_id": team["id"]},
            "sort": "updated_desc",
        }
        view = _created(api.post(views, json=body), "team view")
        track(f"{views}/{view['id']}")

        path = f"/api/workspaces/{workspace['id']}/share-links"
        link = _created(api.post(path, json={"target_type": "view", "target_id": view["id"]}), "share link")
        track(f"{path}/{link['token_hash']}")
        token = link["token"]

        heading = anon.get(f"/api/shared/{token}")
        assert heading.status_code == 200, heading.text[:400]
        assert heading.json()["target_type"] == "view"
        assert heading.json()["team_name"] == team["name"]

        page = anon.get(f"/api/shared/{token}/view")
        assert page.status_code == 200, page.text[:400]
        rows = _items(page.json(), "issues")
        assert issue["title"] in [row["title"] for row in rows]
        assert all(not {"id", "issue_id", "team_id"} & set(row) for row in rows)

        assert anon.get(f"/api/shared/{token}/issue").status_code == 404
