"""Request and response schemas for releases and a team's release pipeline.

A release is a record of what shipped where: a name, the commit range it covers,
the issues it carried and the stages of the team's pipeline it reached, each with
when and what reported it. Anything a source can say about a release, whether a
person in the app, a CI job through the API or CLI, or a GitHub deployment, goes
through these same shapes.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator
from webbpulse.http import cursor_page

from app.common.db.dynamo.releases import PipelineStage, Release, ReleasePipeline, ReleaseStageReached

ReleaseSourceField = Literal["manual", "api", "github_deployment"]

NAME_MAX = 120

DESCRIPTION_MAX = 8000

URL_MAX = 2048

STAGES_MAX = 10

ENVIRONMENTS_MAX = 20

ENVIRONMENT_MAX = 255

ISSUES_MAX = 500
"""How many issues one release may carry, which keeps a release row well under the item cap."""

COMMIT_MESSAGES_MAX = 1000

COMMIT_MESSAGE_MAX = 20000

DEFAULT_LIMIT = 25

MAX_LIMIT = 100

SHA_PATTERN = re.compile(r"^[0-9a-fA-F]{7,40}$")

STAGE_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")


def _blank_to_none(value: Optional[str]) -> Optional[str]:
    """A stripped string, or `None` when nothing is left of it."""
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def _check_sha(value: Optional[str]) -> Optional[str]:
    """A commit sha in lower case, or a 422 when it is not one."""
    value = _blank_to_none(value)
    if value is None:
        return None
    if not SHA_PATTERN.match(value):
        raise ValueError("must be a commit sha of 7 to 40 hex characters")
    return value.lower()


def _check_url(value: Optional[str]) -> Optional[str]:
    """An http or https link, or a 422."""
    value = _blank_to_none(value)
    if value is None:
        return None
    if not value.startswith(("https://", "http://")):
        raise ValueError("must be an http or https link")
    return value


class PipelineStageRead(BaseModel):
    """One stage of a team's release pipeline."""

    stage_id: str
    name: str
    github_environments: list[str]
    status_id: Optional[str] = None
    publish_github_release: bool = False

    @classmethod
    def from_row(cls, stage: PipelineStage) -> "PipelineStageRead":
        """Build the response shape from a stored stage."""
        return cls(
            stage_id=stage.stage_id,
            name=stage.name,
            github_environments=list(stage.github_environments),
            status_id=stage.status_id,
            publish_github_release=stage.publish_github_release,
        )


class ReleasePipelineRead(BaseModel):
    """A team's ordered release stages. `configured` is false while the team runs on the default."""

    team_id: str
    stages: list[PipelineStageRead]
    configured: bool

    @classmethod
    def from_row(cls, pipeline: ReleasePipeline, *, configured: bool) -> "ReleasePipelineRead":
        """Build the response shape from a stored or default pipeline."""
        return cls(
            team_id=pipeline.team_id,
            stages=[PipelineStageRead.from_row(stage) for stage in pipeline.stages],
            configured=configured,
        )


class PipelineStageWrite(BaseModel):
    """One stage in a pipeline replacement. An existing stage keeps its id so releases stay on it.

    `status_id` names, by id or name, the status a release's issues move to when it
    reaches the stage; an issue only ever moves forward, never out of a later or a
    canceled status. `publish_github_release` publishes a GitHub Release with the
    notes when a GitHub deployment reaches the stage.
    """

    stage_id: Optional[str] = Field(default=None, max_length=40)
    name: str = Field(min_length=1, max_length=NAME_MAX)
    github_environments: list[str] = Field(default_factory=list, max_length=ENVIRONMENTS_MAX)
    status_id: Optional[str] = Field(default=None, max_length=NAME_MAX)
    publish_github_release: bool = False

    @field_validator("status_id")
    @classmethod
    def check_status(cls, value: Optional[str]) -> Optional[str]:
        """Treat a blank status as none."""
        return _blank_to_none(value)

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str) -> str:
        """Reject a name that is only whitespace."""
        stripped = value.strip()
        if not stripped:
            raise ValueError("must not be blank")
        return stripped

    @field_validator("stage_id")
    @classmethod
    def check_stage_id(cls, value: Optional[str]) -> Optional[str]:
        """Hold a named stage id to lower case letters, digits, dashes and underscores."""
        value = _blank_to_none(value)
        if value is not None and not STAGE_ID_PATTERN.match(value):
            raise ValueError("must be lower case letters, digits, dashes or underscores")
        return value

    @field_validator("github_environments")
    @classmethod
    def check_environments(cls, value: list[str]) -> list[str]:
        """Strip each environment name, drop blanks and duplicates, and cap the length."""
        cleaned: list[str] = []
        for name in value:
            stripped = name.strip()
            if not stripped:
                continue
            if len(stripped) > ENVIRONMENT_MAX:
                raise ValueError(f"an environment name is at most {ENVIRONMENT_MAX} characters")
            if stripped.casefold() not in {seen.casefold() for seen in cleaned}:
                cleaned.append(stripped)
        return cleaned


class ReleasePipelineUpdate(BaseModel):
    """The body `PUT .../teams/{team_id}/release-pipeline` takes: the whole ordered list of stages."""

    stages: list[PipelineStageWrite] = Field(min_length=1, max_length=STAGES_MAX)

    @model_validator(mode="after")
    def check_unique(self) -> "ReleasePipelineUpdate":
        """Refuse two stages sharing a name, an id, or a GitHub environment."""
        names = [stage.name.casefold() for stage in self.stages]
        if len(set(names)) != len(names):
            raise ValueError("stage names must be unique")
        ids = [stage.stage_id for stage in self.stages if stage.stage_id]
        if len(set(ids)) != len(ids):
            raise ValueError("stage ids must be unique")
        environments = [name.casefold() for stage in self.stages for name in stage.github_environments]
        if len(set(environments)) != len(environments):
            raise ValueError("a GitHub environment can reach only one stage")
        return self


class ReleaseStageRead(BaseModel):
    """One stage a release reached, when, and what reported it."""

    stage_id: str
    name: str
    reached_at: datetime
    source: str
    environment: Optional[str] = None
    url: Optional[str] = None
    actor_id: Optional[str] = None

    @classmethod
    def from_row(cls, stage: ReleaseStageReached, name: str) -> "ReleaseStageRead":
        """Build the response shape, naming the stage as the pipeline names it today."""
        return cls(
            stage_id=stage.stage_id,
            name=name,
            reached_at=stage.reached_at,
            source=stage.source,
            environment=stage.environment,
            url=stage.url,
            actor_id=stage.actor_id,
        )


class ReleaseIssueRead(BaseModel):
    """One issue a release carried, as its notes list it."""

    issue_id: str
    key: str
    title: str
    status_id: str
    status_category: Optional[str] = None


class ReleaseRead(BaseModel):
    """One release as a listing shows it.

    `current_stage` is the furthest stage of the pipeline the release reached, so a
    reader sees "Released to Production" without ordering the stages itself.
    `status_counts` tallies the issues the caller can see by status category, so a
    listing draws each release's progress without reading its issues.
    """

    release_id: str
    team_id: str
    workspace_id: str
    name: str
    version: Optional[str] = None
    description: Optional[str] = None
    source: str
    repository_id: Optional[str] = None
    repository: Optional[str] = None
    sha: Optional[str] = None
    previous_sha: Optional[str] = None
    url: Optional[str] = None
    pr_number: Optional[int] = None
    pr_url: Optional[str] = None
    github_release_url: Optional[str] = None
    issue_count: int
    status_counts: dict[str, int] = Field(default_factory=dict)
    stages: list[ReleaseStageRead]
    current_stage: Optional[ReleaseStageRead] = None
    created_by: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, release: Release, pipeline: ReleasePipeline) -> "ReleaseRead":
        """Build the listing shape, stages named and ordered by the team's current pipeline."""
        names = {stage.stage_id: stage.name for stage in pipeline.stages}
        order = {stage.stage_id: index for index, stage in enumerate(pipeline.stages)}
        stages = [ReleaseStageRead.from_row(stage, names.get(stage.stage_id, stage.name)) for stage in release.stages]
        current = max(
            stages,
            key=lambda stage: (order.get(stage.stage_id, -1), stage.reached_at),
            default=None,
        )
        return cls(
            release_id=release.release_id,
            team_id=release.team_id,
            workspace_id=release.workspace_id,
            name=release.name,
            version=release.version,
            description=release.description,
            source=release.source,
            repository_id=release.repository_id,
            repository=release.repository,
            sha=release.sha,
            previous_sha=release.previous_sha,
            url=release.url,
            pr_number=release.pr_number,
            pr_url=release.pr_url,
            github_release_url=release.github_release_url,
            issue_count=len(release.issue_ids),
            stages=stages,
            current_stage=current,
            created_by=release.created_by,
            created_at=release.created_at,
            updated_at=release.updated_at,
        )


class ReleaseDetailRead(ReleaseRead):
    """One release with its issues and the notes built from them.

    The notes are deterministic: one line per visible issue, `KEY title`, in key
    order, so the same release always reads the same way. `skipped_issues` echoes
    the references a write named that matched no issue of the team, so a CI job can
    report a typo without the release being refused.
    """

    issues: list[ReleaseIssueRead]
    notes: str
    skipped_issues: list[str] = Field(default_factory=list)


ReleaseListRead = cursor_page(ReleaseRead, "releases", model_name="ReleaseListRead")


class ReleaseCreate(BaseModel):
    """The body `POST .../teams/{team_id}/releases` takes.

    Every field is optional so any source can record a release with what it knows.
    With no name the release is named from the date and the short sha. With no
    stage it lands on the pipeline's first stage. Issues come from `issues`, keys
    or ids, and from any team keys found in `commit_messages`, which is how a CI
    job that knows only its git range links what it shipped. Recording a sha the
    team already has a release for advances that release instead of making another.
    """

    name: Optional[str] = Field(default=None, max_length=NAME_MAX)
    version: Optional[str] = Field(default=None, max_length=NAME_MAX)
    description: Optional[str] = Field(default=None, max_length=DESCRIPTION_MAX)
    stage: Optional[str] = Field(default=None, max_length=NAME_MAX)
    sha: Optional[str] = None
    previous_sha: Optional[str] = None
    repository: Optional[str] = Field(default=None, max_length=255)
    url: Optional[str] = Field(default=None, max_length=URL_MAX)
    environment: Optional[str] = Field(default=None, max_length=ENVIRONMENT_MAX)
    issues: list[str] = Field(default_factory=list, max_length=ISSUES_MAX)
    commit_messages: list[str] = Field(default_factory=list, max_length=COMMIT_MESSAGES_MAX)

    @field_validator("name", "version", "description", "repository", "environment", "stage")
    @classmethod
    def strip(cls, value: Optional[str]) -> Optional[str]:
        """Treat a blank value as absent."""
        return _blank_to_none(value)

    @field_validator("sha", "previous_sha")
    @classmethod
    def check_sha(cls, value: Optional[str]) -> Optional[str]:
        """Hold a commit to a hex sha."""
        return _check_sha(value)

    @field_validator("url")
    @classmethod
    def check_url(cls, value: Optional[str]) -> Optional[str]:
        """Hold a link to http or https."""
        return _check_url(value)

    @field_validator("commit_messages")
    @classmethod
    def check_messages(cls, value: list[str]) -> list[str]:
        """Cut each commit message to the length that can hold a key in its subject."""
        return [message[:COMMIT_MESSAGE_MAX] for message in value]


class ReleaseUpdate(BaseModel):
    """The body a release patch takes. Only the fields named are written; null clears an optional one."""

    name: Optional[str] = Field(default=None, max_length=NAME_MAX)
    version: Optional[str] = Field(default=None, max_length=NAME_MAX)
    description: Optional[str] = Field(default=None, max_length=DESCRIPTION_MAX)
    url: Optional[str] = Field(default=None, max_length=URL_MAX)

    @field_validator("name", "version", "description")
    @classmethod
    def strip(cls, value: Optional[str]) -> Optional[str]:
        """Treat a blank value as a clear."""
        return _blank_to_none(value)

    @field_validator("url")
    @classmethod
    def check_url(cls, value: Optional[str]) -> Optional[str]:
        """Hold a link to http or https."""
        return _check_url(value)


class ReleaseStageAdvance(BaseModel):
    """The body `POST .../releases/{release_id}/stages` takes: a stage reached, by id or name.

    Reaching a stage the release already reached keeps the first time it got there.
    """

    stage: str = Field(min_length=1, max_length=NAME_MAX)
    environment: Optional[str] = Field(default=None, max_length=ENVIRONMENT_MAX)
    url: Optional[str] = Field(default=None, max_length=URL_MAX)

    @field_validator("url")
    @classmethod
    def check_url(cls, value: Optional[str]) -> Optional[str]:
        """Hold a link to http or https."""
        return _check_url(value)


class ReleaseIssuesAdd(BaseModel):
    """The body `POST .../releases/{release_id}/issues` takes: issue keys or ids of the release's team."""

    issues: list[str] = Field(min_length=1, max_length=ISSUES_MAX)


BACKFILL_DEFAULT_LIMIT = 5

BACKFILL_MAX_LIMIT = 10


class ReleaseBackfill(BaseModel):
    """The body `POST .../teams/{team_id}/release-backfill` takes.

    Rebuilds releases from one GitHub environment's past successful deployments,
    newest first, a few per call. `repository` is a full name or id and defaults to
    every repository pinned to the team. Pass `cursor` back until it comes back
    null. A deployment that already has a release only gains missing issues, and
    the backfill never moves issues or publishes GitHub Releases.
    """

    repository: Optional[str] = Field(default=None, max_length=255)
    environment: str = Field(default="production", min_length=1, max_length=ENVIRONMENT_MAX)
    limit: int = Field(default=BACKFILL_DEFAULT_LIMIT, ge=1, le=BACKFILL_MAX_LIMIT)
    cursor: Optional[str] = Field(default=None, max_length=1024)

    @field_validator("repository", "cursor")
    @classmethod
    def strip(cls, value: Optional[str]) -> Optional[str]:
        """Treat a blank value as absent."""
        return _blank_to_none(value)

    @field_validator("environment")
    @classmethod
    def check_environment(cls, value: str) -> str:
        """Reject an environment that is only whitespace."""
        stripped = value.strip()
        if not stripped:
            raise ValueError("must not be blank")
        return stripped


class ReleaseBackfillRead(BaseModel):
    """What one backfill call did, and the cursor to continue from, null when it is done.

    `deployments_skipped` counts deployments whose release had already reached
    the stage, which cost no GitHub call. A page that stopped before its limit to
    keep half the GitHub App's hourly budget for live sync, or to answer inside
    the request timeout, sets `stopped_early` and says in `message` when to pass
    the cursor back; `resume_after` is GitHub's budget reset when that is the
    reason. `rate_limit_remaining` and `rate_limit` are GitHub's last word on the
    installation's budget, and `github_calls` what this page spent of it.

    `stalled` is set when the page recorded and skipped nothing, so passing the
    cursor back moves only once the message's reason has passed.
    `unreadable_deployment_ids` names deployments passed over because their range
    could not be read inside the request timeout, and `pull_reads_skipped` counts
    pull requests a recorded deployment did not read for keys for the same reason.
    """

    team_id: str
    environment: str
    deployments_scanned: int
    deployments_skipped: int = 0
    releases_created: int
    releases_updated: int
    release_ids: list[str]
    next_cursor: Optional[str] = None
    stopped_early: bool = False
    stalled: bool = False
    unreadable_deployment_ids: list[int] = Field(default_factory=list)
    pull_reads_skipped: int = 0
    message: Optional[str] = None
    resume_after: Optional[datetime] = None
    github_calls: int = 0
    rate_limit_remaining: Optional[int] = None
    rate_limit: Optional[int] = None


class IssueReleaseRead(BaseModel):
    """One release an issue shipped in, as the issue page names it."""

    release_id: str
    team_id: str
    name: str
    current_stage: Optional[ReleaseStageRead] = None
    created_at: datetime


class IssueReleaseListRead(BaseModel):
    """The releases one issue shipped in, newest first."""

    releases: list[IssueReleaseRead]
