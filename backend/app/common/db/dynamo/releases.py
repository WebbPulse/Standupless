"""Release rows in the `planning` table: what shipped, where, and which issues it carried.

A release is filed under its team in the workspace partition, beside the team's
cycles, so "this team's releases" is one query and the team purge clears them with
the rest of the team's planning rows. Four row shapes share the release prefix:

- `team#<team>#release#<release>` is the release itself, newest first by its ULID.
- `team#<team>#releasepipe` is the team's ordered pipeline of stages.
- `team#<team>#releasehead#<repo>#<stage>` is the last commit a repository reached
  a stage at, which is where the next release's commit range starts.
- `team#<team>#releasesha#<repo>#<sha>` names the release one commit belongs to, so
  a second deployment of the same commit advances that release instead of making
  another.

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

RELEASE_ISSUE = "release_issue"

RELEASE_ISSUE_PREFIX = "release_issue#"

NO_REPOSITORY = "-"
"""The repository part of a commit key for a release no repository was named for."""

DEFAULT_STAGE_ID = "production"
"""The id of the one stage a team that never configured a pipeline releases to."""


def new_release_id() -> str:
    """A fresh release id, time sortable so a listing reads newest first when descending."""
    return new_ulid()


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
    """One release of one team: a named commit range, its issues and the stages it reached."""

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
    issue_ids: list[str] = Field(default_factory=list)
    stages: list[ReleaseStageReached] = Field(default_factory=list)
    created_by: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class PipelineStage(BaseModel):
    """One stage of a team's release pipeline, and the GitHub environments that reach it."""

    stage_id: str
    name: str
    github_environments: list[str] = Field(default_factory=list)


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
    "created_by",
)


def as_release_item(release: Release) -> dict[str, Any]:
    """One release as the stored item, null optional fields dropped."""
    item = release.model_dump(mode="json")
    for name in _OPTIONAL_FIELDS:
        if item.get(name) is None:
            item.pop(name, None)
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
        self._repository.put(pipeline.model_dump(mode="json"))
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

    def create(self, release: Release) -> Release:
        """Store a new release with its commit pointer and issue links.

        The release and its commit pointer land in one transaction, both conditional
        on not existing, so two deployments of one commit racing each other make one
        release. Raises `ConditionFailed` when the commit already has a release.
        """
        actions = [self._repository.put_action(as_release_item(release), condition=Attr("planning_key").not_exists())]
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
        """Delete one release with its issue links and its commit pointer."""
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
