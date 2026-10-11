"""Release rows in the `planning` table: what shipped, where, and which issues it carried.

A release is filed under its team in the workspace partition, beside the team's
cycles, so "this team's releases" is one query and the team purge clears them with
the rest of the team's planning rows. Five row shapes share the release prefix:

- `team#<team>#release#<release>` is the release itself, newest first by its ULID.
- `team#<team>#releasepipe` is the team's ordered pipeline of stages.
- `team#<team>#releasehead#<repo>#<stage>` is the last commit a repository reached
  a stage at, which is where the next release's commit range starts.
- `team#<team>#releasesha#<repo>#<sha>` names the release one commit belongs to, so
  a second deployment of the same commit advances that release instead of making
  another.
- `team#<team>#releasename#<name>` claims one name, folded, for the release that
  holds it, so two releases of a team never share a name however they race.

The issue side is `release_issue#<issue>#<release>`, filed under the workspace rather
than the team so an issue's releases are one query even after it moves team.

None of these kinds pass the planning stream filters, so no consumer reads them.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Mapping, Sequence

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Repository, TransactionCanceled, new_ulid

from app.common.db.dynamo.base import build_repository, utc_now
from app.common.db.dynamo.tables import PLANNING

RELEASE = "release"

RELEASE_PIPELINE = "release_pipeline"

RELEASE_HEAD = "release_head"

RELEASE_SHA = "release_sha"

RELEASE_NAME = "release_name"

RELEASE_ISSUE = "release_issue"

RELEASE_ISSUE_PREFIX = "release_issue#"

NO_REPOSITORY = "-"
"""The repository part of a commit key for a release no repository was named for."""

DEFAULT_STAGE_ID = "production"
"""The id of the one stage a team that never configured a pipeline releases to."""


def new_release_id(moment: datetime | None = None) -> str:
    """A fresh release id, time sortable so a listing reads newest first when descending.

    A backfilled release passes the time it shipped, so it sorts among the others
    by when it happened rather than when it was recorded.
    """
    return new_ulid(moment) if moment is not None else new_ulid()


def team_release_prefix(team_id: str) -> str:
    """The prefix every release row of one team shares, pipeline and pointers included."""
    return f"team#{team_id}#release"


def release_prefix(team_id: str) -> str:
    """The prefix of one team's release rows alone."""
    return f"{team_release_prefix(team_id)}#"


def release_key(team_id: str, release_id: str) -> str:
    """The sort key of one release."""
    return f"{release_prefix(team_id)}{release_id}"


def pipeline_key(team_id: str) -> str:
    """The sort key of one team's release pipeline."""
    return f"{team_release_prefix(team_id)}pipe"


def head_key(team_id: str, repository_id: str, stage_id: str) -> str:
    """The sort key of the commit one repository last reached one stage at."""
    return f"{team_release_prefix(team_id)}head#{repository_id or NO_REPOSITORY}#{stage_id}"


def sha_key(team_id: str, repository_id: str, sha: str) -> str:
    """The sort key naming the release one commit of one repository belongs to."""
    return f"{team_release_prefix(team_id)}sha#{repository_id or NO_REPOSITORY}#{sha.lower()}"


def fold_name(name: str) -> str:
    """A release name as uniqueness compares it: trimmed and case folded."""
    return name.strip().casefold()


def name_key(team_id: str, name: str) -> str:
    """The sort key of the row claiming one release name within one team."""
    return f"{team_release_prefix(team_id)}name#{fold_name(name)}"


def issue_link_prefix(issue_id: str) -> str:
    """The prefix every release link of one issue shares."""
    return f"{RELEASE_ISSUE_PREFIX}{issue_id}#"


def issue_link_key(issue_id: str, release_id: str) -> str:
    """The sort key linking one issue to one release."""
    return f"{issue_link_prefix(issue_id)}{release_id}"


class ReleaseStageReached(BaseModel):
    """One stage a release reached, when, and what reported it."""

    stage_id: str
    name: str
    reached_at: datetime = Field(default_factory=utc_now)
    source: str
    environment: str | None = None
    url: str | None = None
    actor_id: str | None = None


class Release(BaseModel):
    """One release of one team: a named commit range, its issues and the stages it reached.

    `referenced_issue_ids` are issues the release carries that no pull request in
    it closes, such as one a pull request names with `Refs`. They are listed with
    the release but its stage automation leaves their status alone.
    """

    workspace_id: str
    planning_key: str
    release_id: str
    team_id: str
    kind: str = RELEASE
    name: str
    version: str | None = None
    description: str | None = None
    source: str
    repository_id: str | None = None
    repository: str | None = None
    sha: str | None = None
    previous_sha: str | None = None
    url: str | None = None
    pr_number: int | None = None
    pr_url: str | None = None
    github_release_url: str | None = None
    issue_ids: list[str] = Field(default_factory=list)
    referenced_issue_ids: list[str] = Field(default_factory=list)
    stages: list[ReleaseStageReached] = Field(default_factory=list)
    created_by: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class PipelineStage(BaseModel):
    """One stage of a team's release pipeline, the GitHub environments that reach it, and its automation.

    `status_id` is the status a release's issues move to when it reaches the stage,
    forward only. `publish_github_release` makes a GitHub deployment that reaches
    the stage publish a GitHub Release with the release notes.
    """

    stage_id: str
    name: str
    github_environments: list[str] = Field(default_factory=list)
    status_id: str | None = None
    publish_github_release: bool = False


class ReleasePipeline(BaseModel):
    """A team's ordered release stages; the first is where a new release lands by default."""

    workspace_id: str
    planning_key: str
    team_id: str
    kind: str = RELEASE_PIPELINE
    stages: list[PipelineStage]
    updated_at: datetime = Field(default_factory=utc_now)


def default_pipeline(workspace_id: str, team_id: str) -> ReleasePipeline:
    """The pipeline a team has before it configures one: one Production stage."""
    return ReleasePipeline(
        workspace_id=workspace_id,
        planning_key=pipeline_key(team_id),
        team_id=team_id,
        stages=[PipelineStage(stage_id=DEFAULT_STAGE_ID, name="Production", github_environments=["production"])],
    )


_OPTIONAL_FIELDS: tuple[str, ...] = (
    "version",
    "description",
    "repository_id",
    "repository",
    "sha",
    "previous_sha",
    "url",
    "pr_number",
    "pr_url",
    "github_release_url",
    "created_by",
)


def as_release_item(release: Release) -> dict[str, Any]:
    """One release as the stored item, null optional fields dropped."""
    item = release.model_dump(mode="json")
    for name in _OPTIONAL_FIELDS:
        if item.get(name) is None:
            item.pop(name, None)
    if not item.get("referenced_issue_ids"):
        item.pop("referenced_issue_ids", None)
    for stage in item["stages"]:
        for name in ("environment", "url", "actor_id"):
            if stage.get(name) is None:
                stage.pop(name, None)
    return item


def is_release(item: Mapping[str, Any]) -> bool:
    """Whether a stored item is a release row."""
    return item.get("kind") == RELEASE


class ReleaseRepository:
    """Reads and writes release rows in the `planning` table, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(PLANNING, repository)

    def _get(self, workspace_id: str, planning_key: str, *, consistent: bool = False) -> Mapping[str, Any] | None:
        """One stored row, or `None`."""
        if not workspace_id:
            return None
        return self._repository.get({"workspace_id": workspace_id, "planning_key": planning_key}, consistent=consistent)

    def get_pipeline(self, workspace_id: str, team_id: str) -> ReleasePipeline | None:
        """The team's stored pipeline, or `None` when it never configured one."""
        item = self._get(workspace_id, pipeline_key(team_id))
        if item is None or item.get("kind") != RELEASE_PIPELINE:
            return None
        return ReleasePipeline.model_validate(dict(item))

    def put_pipeline(self, pipeline: ReleasePipeline) -> ReleasePipeline:
        """Store the team's pipeline over whatever it had."""
        item = pipeline.model_dump(mode="json")
        for stage in item["stages"]:
            if stage.get("status_id") is None:
                stage.pop("status_id", None)
        self._repository.put(item)
        return pipeline

    def get(self, workspace_id: str, team_id: str, release_id: str) -> Release | None:
        """One release of one team, or `None`; the team is part of the key."""
        if not team_id or not release_id:
            return None
        item = self._get(workspace_id, release_key(team_id, release_id))
        if item is None or not is_release(item):
            return None
        return Release.model_validate(dict(item))

    def get_many(self, workspace_id: str, keys: Sequence[tuple[str, str]]) -> list[Release]:
        """The releases these `(team_id, release_id)` pairs name, absent ones skipped."""
        unique = list(dict.fromkeys(keys))
        if not workspace_id or not unique:
            return []
        items = self._repository.batch_get(
            [{"workspace_id": workspace_id, "planning_key": release_key(team, release)} for team, release in unique]
        )
        return [Release.model_validate(dict(item)) for item in items if is_release(item)]

    def list_for_team(
        self,
        workspace_id: str,
        team_id: str,
        *,
        limit: int,
        start_key: Mapping[str, Any] | None = None,
    ) -> tuple[list[Release], Mapping[str, Any] | None]:
        """One page of a team's releases, newest first, and the key to resume from."""
        if not workspace_id or not team_id:
            return [], None
        page = self._repository.query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(release_prefix(team_id)),
            limit=limit,
            start_key=dict(start_key) if start_key else None,
            ascending=False,
        )
        rows = [Release.model_validate(dict(item)) for item in page.items if is_release(item)]
        return rows, page.last_evaluated_key

    def _name_claim_action(self, release: Release) -> dict[str, Any]:
        """A put claiming the release's name, holding only when it is free or already this release's."""
        return self._repository.put_action(
            {
                "workspace_id": release.workspace_id,
                "planning_key": name_key(release.team_id, release.name),
                "kind": RELEASE_NAME,
                "team_id": release.team_id,
                "release_id": release.release_id,
            },
            condition=Attr("planning_key").not_exists() | Attr("release_id").eq(release.release_id),
        )

    def release_for_name(self, workspace_id: str, team_id: str, name: str) -> str | None:
        """The id of the release that claimed this name in the team, or `None`."""
        if not team_id or not name.strip():
            return None
        item = self._get(workspace_id, name_key(team_id, name), consistent=True)
        return str(item["release_id"]) if item and item.get("release_id") else None

    def names_in_use(self, workspace_id: str, team_id: str, *, max_items: int = 5000) -> dict[str, str]:
        """Every folded name the team's releases carry, mapped to the release carrying it.

        Read from the release rows rather than the claims, so a release recorded
        before names were claimed still counts.
        """
        if not workspace_id or not team_id:
            return {}
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(release_prefix(team_id)),
            max_items=max_items,
        )
        return {fold_name(str(item["name"])): str(item["release_id"]) for item in items if is_release(item)}

    def create(self, release: Release) -> Release:
        """Store a new release with its name claim, commit pointer and issue links.

        The release, the claim on its name and its commit pointer land in one
        transaction, each conditional on not existing, so two deployments of one
        commit racing each other make one release and two releases racing for one
        name cannot both take it. Raises `ConditionFailed` when the commit already
        has a release or the name is claimed.
        """
        actions = [
            self._repository.put_action(as_release_item(release), condition=Attr("planning_key").not_exists()),
            self._name_claim_action(release),
        ]
        if release.sha:
            actions.append(
                self._repository.put_action(
                    {
                        "workspace_id": release.workspace_id,
                        "planning_key": sha_key(release.team_id, release.repository_id or "", release.sha),
                        "kind": RELEASE_SHA,
                        "team_id": release.team_id,
                        "release_id": release.release_id,
                    },
                    condition=Attr("planning_key").not_exists(),
                )
            )
        try:
            self._repository.transact_write(actions)
        except TransactionCanceled as exc:
            if exc.conditional_check_failed:
                raise ConditionFailed(PLANNING.suffix, "release exists") from exc
            raise
        self.link_issues(release, release.issue_ids)
        return release

    def replace(self, release: Release) -> Release:
        """Write one release over its existing row, raising `ConditionFailed` when it is gone."""
        self._repository.put(as_release_item(release), condition=Attr("planning_key").exists())
        return release

    def rename(self, release: Release, previous_name: str) -> Release:
        """Write a renamed release, moving its name claim in the same transaction.

        The new claim holds only when the name is free or already this release's,
        and the old claim is dropped only while this release holds it. Raises
        `ConditionFailed` when the name is taken or the release is gone.
        """
        actions = [
            self._repository.put_action(as_release_item(release), condition=Attr("planning_key").exists()),
            self._name_claim_action(release),
        ]
        if fold_name(previous_name) != fold_name(release.name):
            actions.append(
                self._repository.delete_action(
                    {"workspace_id": release.workspace_id, "planning_key": name_key(release.team_id, previous_name)},
                    condition=Attr("planning_key").not_exists() | Attr("release_id").eq(release.release_id),
                )
            )
        try:
            self._repository.transact_write(actions)
        except TransactionCanceled as exc:
            if exc.conditional_check_failed:
                raise ConditionFailed(PLANNING.suffix, "release name taken or release gone") from exc
            raise
        return release

    def release_for_sha(self, workspace_id: str, team_id: str, repository_id: str, sha: str) -> str | None:
        """The id of the release one commit of one repository belongs to, or `None`."""
        if not sha:
            return None
        item = self._get(workspace_id, sha_key(team_id, repository_id, sha), consistent=True)
        return str(item["release_id"]) if item and item.get("release_id") else None

    def releases_for_shas(
        self, workspace_id: str, team_id: str, repository_id: str, shas: Sequence[str]
    ) -> dict[str, str]:
        """Each of these commits that already has a release, mapped to that release's id."""
        unique = list(dict.fromkeys(sha.lower() for sha in shas if sha))
        if not workspace_id or not unique:
            return {}
        items = self._repository.batch_get(
            [{"workspace_id": workspace_id, "planning_key": sha_key(team_id, repository_id, sha)} for sha in unique]
        )
        found: dict[str, str] = {}
        for item in items:
            sha = str(item["planning_key"]).rpartition("#")[2]
            if item.get("release_id"):
                found[sha] = str(item["release_id"])
        return found

    def get_head(self, workspace_id: str, team_id: str, repository_id: str, stage_id: str) -> str | None:
        """The commit one repository last reached one stage at, or `None`."""
        item = self._get(workspace_id, head_key(team_id, repository_id, stage_id), consistent=True)
        return str(item["sha"]) if item and item.get("sha") else None

    def set_head(self, workspace_id: str, team_id: str, repository_id: str, stage_id: str, sha: str) -> None:
        """Record the commit one repository just reached one stage at."""
        self._repository.put(
            {
                "workspace_id": workspace_id,
                "planning_key": head_key(team_id, repository_id, stage_id),
                "kind": RELEASE_HEAD,
                "team_id": team_id,
                "sha": sha.lower(),
                "updated_at": utc_now().isoformat(),
            }
        )

    def link_issues(self, release: Release, issue_ids: Sequence[str]) -> None:
        """Write the issue side of a release's links for these issues."""
        unique = list(dict.fromkeys(issue_ids))
        if not unique:
            return
        self._repository.put_many(
            [
                {
                    "workspace_id": release.workspace_id,
                    "planning_key": issue_link_key(issue_id, release.release_id),
                    "kind": RELEASE_ISSUE,
                    "issue_id": issue_id,
                    "team_id": release.team_id,
                    "release_id": release.release_id,
                }
                for issue_id in unique
            ]
        )

    def unlink_issues(self, workspace_id: str, release_id: str, issue_ids: Sequence[str]) -> None:
        """Remove the issue side of a release's links for these issues."""
        unique = list(dict.fromkeys(issue_ids))
        if not unique:
            return
        keys = [issue_link_key(issue_id, release_id) for issue_id in unique]
        self._repository.delete_many([{"workspace_id": workspace_id, "planning_key": key} for key in keys])

    def list_for_issue(self, workspace_id: str, issue_id: str, *, max_items: int = 200) -> list[tuple[str, str]]:
        """Every `(team_id, release_id)` an issue is linked to, newest release first."""
        if not workspace_id or not issue_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(issue_link_prefix(issue_id)),
            max_items=max_items,
        )
        pairs = [(str(item["team_id"]), str(item["release_id"])) for item in items if item.get("kind") == RELEASE_ISSUE]
        return sorted(pairs, key=lambda pair: pair[1], reverse=True)

    def delete(self, release: Release) -> None:
        """Delete one release with its issue links, its commit pointer and its name claim if it holds one."""
        self.unlink_issues(release.workspace_id, release.release_id, release.issue_ids)
        keys = [
            {"workspace_id": release.workspace_id, "planning_key": release_key(release.team_id, release.release_id)}
        ]
        if release.sha:
            keys.append(
                {
                    "workspace_id": release.workspace_id,
                    "planning_key": sha_key(release.team_id, release.repository_id or "", release.sha),
                }
            )
        self._repository.delete_many(keys)
        try:
            self._repository.delete(
                {"workspace_id": release.workspace_id, "planning_key": name_key(release.team_id, release.name)},
                condition=Attr("release_id").eq(release.release_id),
            )
        except ConditionFailed:
            pass

    def delete_team_page(self, workspace_id: str, team_id: str, *, limit: int = 100) -> int:
        """Remove one page of a team's release rows, returning how many went.

        The team purge calls this until it answers zero. A release takes its issue
        links with it, which sit outside the team's prefix.
        """
        page = self._repository.query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(team_release_prefix(team_id)),
            limit=limit,
            consistent=True,
        )
        if not page.items:
            return 0
        for item in page.items:
            if is_release(item):
                self.unlink_issues(workspace_id, str(item["release_id"]), list(item.get("issue_ids") or []))
        return self._repository.delete_many(
            [{"workspace_id": workspace_id, "planning_key": item["planning_key"]} for item in page.items]
        )
