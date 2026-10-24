"""Syncing one comment thread to a pull request or GitHub issue linked to the issue.

The routes sit under the issue's GitHub sync path rather than under its
comments, so the gateway sends them to this domain, which holds the GitHub rows,
instead of to the discussion domain, which holds none.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.issue_rules import load_visible_issue
from app.domains.integrations import thread_sync
from app.domains.integrations.schemas.integrations import GithubThreadRead, GithubThreadTargetRead, GithubThreadWrite

router = APIRouter()


@router.get("/{workspace_id}/issues/{issue_id}/github-sync/thread-targets", response_model=list[GithubThreadTargetRead])
def list_thread_targets(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> list[GithubThreadTargetRead]:
    """Where this issue's threads may be synced: its linked pull requests and its one way GitHub issue.

    Empty when nothing is linked, which is when the composer offers no sync.
    """
    issue = load_visible_issue(repositories, context, issue_id)
    return [GithubThreadTargetRead.model_validate(row) for row in thread_sync.thread_targets(repositories, issue)]


@router.put("/{workspace_id}/issues/{issue_id}/github-sync/threads/{comment_id}", response_model=GithubThreadRead)
def put_thread_sync(
    issue_id: Annotated[str, Path(min_length=1)],
    comment_id: Annotated[str, Path(min_length=1)],
    payload: GithubThreadWrite,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> GithubThreadRead:
    """Sync one root comment's thread to a linked pull request or GitHub issue.

    The App posts an opening comment quoting the root, then each new reply, and
    GitHub comments written there afterwards land in the thread. A reply is a 409,
    a target that is not linked is a 422, and the GitHub issue a two way sync
    mirrors is a 409. Syncing to the same target again changes nothing.
    """
    comment = thread_sync.sync_thread(
        repositories, context, issue_id, comment_id, repository_id=payload.repository_id, number=payload.number
    )
    return GithubThreadRead.model_validate(thread_sync.thread_read(comment))


@router.delete("/{workspace_id}/issues/{issue_id}/github-sync/threads/{comment_id}", response_model=GithubThreadRead)
def delete_thread_sync(
    issue_id: Annotated[str, Path(min_length=1)],
    comment_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> GithubThreadRead:
    """Stop mirroring one thread. Comments already copied stay where they are on both sides."""
    comment = thread_sync.unsync_thread(repositories, context, issue_id, comment_id)
    return GithubThreadRead.model_validate(thread_sync.thread_read(comment))
