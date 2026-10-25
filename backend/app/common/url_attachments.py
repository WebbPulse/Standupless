"""URL links on an issue, shared by the attachment routes and the MCP tools.

A link on an issue is an attachment of kind `url`. Held in `common` because the
integrations image may not import another domain's code, and a link an agent adds
must be the same row, under the same rule, as one a person pastes in the UI.

The favicon is derived and the title defaults to the host, never fetched: a crawl
on a write path is a request the caller controls the destination of.
"""

from __future__ import annotations

from urllib.parse import urlparse

from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.attachments import Attachment, build_attachment, stored_bytes
from app.common.discussion_rules import (
    conflict,
    forbidden,
    is_team_admin,
    load_visible_issue,
    not_found,
    require_team_member,
)

TITLE_MAX = 200

URL_MAX = 2048

LINK_LIST_MAX = 1000


def check_https_url(value: str) -> str:
    """Hold an attachment URL to `https` and to the contract's length cap, raising `ValueError` otherwise.

    `http` is refused rather than upgraded: an attachment renders as a link a reader
    clicks, and silently rewriting the scheme would point them somewhere the author
    did not name.
    """
    candidate = value.strip()
    if not candidate:
        raise ValueError("url must not be empty")
    if len(candidate) > URL_MAX:
        raise ValueError(f"url must be at most {URL_MAX} characters")
    parsed = urlparse(candidate)
    if parsed.scheme != "https" or not parsed.netloc:
        raise ValueError("url must be an absolute https URL")
    return candidate


def favicon_for(url: str) -> str | None:
    """The favicon the MVP shows beside a URL attachment, derived without a fetch.

    Derived rather than crawled: resolving the target would put an outbound request
    from a Lambda on a user-supplied URL in the write path, which is a request
    forgery surface for a picture beside a link.
    """
    host = urlparse(url).netloc
    if not host:
        return None
    return f"https://www.google.com/s2/favicons?domain={host}"


def title_for(url: str, title: str | None) -> str:
    """The title a URL attachment carries, defaulting to the host.

    The MVP does not crawl the target, so a title the caller does not give is the
    host rather than a fetched page title.
    """
    if title and title.strip():
        return title.strip()[:TITLE_MAX]
    return urlparse(url).netloc or url[:TITLE_MAX]


def list_links(repositories: Repositories, context: AuthzContext, issue_id: str) -> list[Attachment]:
    """Every URL link on one visible issue, oldest first, or a 404."""
    load_visible_issue(repositories, context, issue_id)
    rows = repositories.attachments.iter_for_issue(context.workspace_id, issue_id, max_items=LINK_LIST_MAX)
    return [row for row in rows if row.kind == "url"]


def attach_url(
    repositories: Repositories, context: AuthzContext, issue_id: str, url: str, title: str | None
) -> Attachment:
    """Hang a link on an issue, deriving its favicon without fetching it.

    Any member of the issue's team, the same rule as pasting a link in the UI. The
    URL is expected already held to `check_https_url`.
    """
    issue = load_visible_issue(repositories, context, issue_id)
    require_team_member(repositories, context, issue.team_id)
    attachment = build_attachment(
        context.workspace_id,
        issue_id,
        issue.team_id,
        "url",
        title_for(url, title),
        context.user_id,
        url=url,
        favicon_url=favicon_for(url),
    )
    try:
        return repositories.attachments.create(attachment)
    except ConditionFailed as exc:
        raise conflict("That attachment already exists") from exc


def _load_owned(repositories: Repositories, context: AuthzContext, issue_id: str, attachment_id: str) -> Attachment:
    """One attachment of a visible issue the caller may change: its uploader or a team admin, or a 404 or 403."""
    issue = load_visible_issue(repositories, context, issue_id)
    attachment = repositories.attachments.get(context.workspace_id, issue_id, attachment_id)
    if attachment is None:
        raise not_found()
    if attachment.uploaded_by != context.user_id and not is_team_admin(repositories, context, issue.team_id):
        raise forbidden()
    return attachment


def update_link(
    repositories: Repositories,
    context: AuthzContext,
    issue_id: str,
    attachment_id: str,
    *,
    url: str | None = None,
    title: str | None = None,
    title_given: bool = False,
) -> Attachment:
    """Change one URL link's address or title, answering the stored link.

    Whoever added it or a team admin, the same rule as removing it. A new URL
    re-derives the favicon, and a title that was only the old host follows the
    new host. A title given as empty or `None` falls back to the host. A file
    attachment is not a link and answers a 404.
    """
    attachment = _load_owned(repositories, context, issue_id, attachment_id)
    if attachment.kind != "url":
        raise not_found()
    new_url = url if url is not None else attachment.url or ""
    if title_given:
        new_title = title_for(new_url, title)
    elif url is not None and attachment.title == title_for(attachment.url or "", None):
        new_title = title_for(new_url, None)
    else:
        new_title = attachment.title
    updated = repositories.attachments.update_link(
        context.workspace_id,
        issue_id,
        attachment_id,
        url=new_url,
        title=new_title,
        favicon_url=favicon_for(new_url),
    )
    if updated is None:
        raise not_found()
    return updated


def delete_attachment(
    repositories: Repositories,
    context: AuthzContext,
    issue_id: str,
    attachment_id: str,
    *,
    links_only: bool = False,
) -> None:
    """Detach one attachment, releasing a file's bytes from the workspace's storage at once.

    The uploader or a team admin. With `links_only`, a file attachment answers a
    404, so a caller managing links cannot remove an uploaded file by its id. The
    row is what makes an object visible on the issue, so removing it is the whole
    of the delete a reader can observe; a file's object is collected by the bucket
    lifecycle rule.
    """
    attachment = _load_owned(repositories, context, issue_id, attachment_id)
    if links_only and attachment.kind != "url":
        raise not_found()
    removed = repositories.attachments.delete(context.workspace_id, issue_id, attachment_id)
    if removed is not None:
        repositories.attachments.add_storage(context.workspace_id, -stored_bytes([removed]))


__all__ = [
    "LINK_LIST_MAX",
    "TITLE_MAX",
    "URL_MAX",
    "attach_url",
    "check_https_url",
    "delete_attachment",
    "favicon_for",
    "list_links",
    "title_for",
    "update_link",
]
