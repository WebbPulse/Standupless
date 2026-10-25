"""The MCP tools that list, add, change and remove URL links on an issue.

A link on an issue is a URL attachment, the row the UI writes when a person pastes
a link into the issue's attachments, and each tool runs the same `app.common`
path the attachment routes run. Issue to issue links are relations, which the
`*_issue_relation` tools manage.

Any member of the issue's team may add a link; whoever added one, or a team
admin, may change or remove it. An uploaded file is not a link: these tools never
list, change or remove one.
"""

from __future__ import annotations

from typing import Any

from app.common.db.dynamo.attachments import Attachment
from app.common.url_attachments import (
    TITLE_MAX,
    attach_url,
    check_https_url,
    delete_attachment,
    list_links,
    update_link,
)
from app.domains.integrations.mcp.issue_tools import ISSUE_REF
from app.domains.integrations.mcp.toolkit import Tool, ToolCall, issue_ref, nullable, object_schema, string
from app.domains.integrations.mcp.transport import ToolError

LINK_HELP = "The link's link_id, from list_issue_links"

URL_HELP = "An absolute https URL, at most 2048 characters"


def _link_json(link: Attachment) -> dict[str, Any]:
    """One URL link as the tools answer it."""
    return {
        "link_id": link.attachment_id,
        "issue_id": link.issue_id,
        "url": link.url,
        "title": link.title,
        "favicon_url": link.favicon_url,
        "created_by": link.uploaded_by,
        "created_at": link.created_at.isoformat(),
    }


def _url(value: Any) -> str:
    """A link URL held to the attachment route's rule, or a tool error."""
    try:
        return check_https_url(str(value))
    except ValueError as exc:
        raise ToolError(str(exc)) from exc


def _title(value: Any) -> str | None:
    """A link title held to the attachment route's length cap, or a tool error."""
    if value is None:
        return None
    title = str(value)
    if len(title) > TITLE_MAX:
        raise ToolError(f"title must be at most {TITLE_MAX} characters")
    return title


def _list_issue_links(call: ToolCall) -> Any:
    """Every URL link on one visible issue, oldest first."""
    issue = issue_ref(call, call.require("issue_id"))
    return {"links": [_link_json(row) for row in list_links(call.repositories, call.context, issue.issue_id)]}


def _create_issue_link(call: ToolCall) -> Any:
    """Add a URL link to an issue through the attachment route's path."""
    issue = issue_ref(call, call.require("issue_id"))
    created = attach_url(
        call.repositories,
        call.context,
        issue.issue_id,
        _url(call.require("url")),
        _title(call.optional("title")),
    )
    return _link_json(created)


def _update_issue_link(call: ToolCall) -> Any:
    """Change a URL link's address or title, writing only the fields named."""
    issue = issue_ref(call, call.require("issue_id"))
    if not call.present("url") and not call.present("title"):
        raise ToolError("Name url, title or both to change")
    url = _url(call.require("url")) if call.present("url") else None
    updated = update_link(
        call.repositories,
        call.context,
        issue.issue_id,
        str(call.require("link_id")),
        url=url,
        title=_title(call.optional("title")),
        title_given=call.present("title"),
    )
    return _link_json(updated)


def _delete_issue_link(call: ToolCall) -> Any:
    """Remove a URL link from an issue through the attachment route's path."""
    issue = issue_ref(call, call.require("issue_id"))
    link_id = str(call.require("link_id"))
    delete_attachment(call.repositories, call.context, issue.issue_id, link_id, links_only=True)
    return {"deleted": True, "link_id": link_id, "issue_id": issue.issue_id}


ISSUE_LINK_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_issue_links",
        description=(
            "Every URL link attached to an issue, oldest first, each with its title, favicon and who added it. "
            "Uploaded files are left out, and issue to issue links are relations: see list_issue_relations."
        ),
        scopes=("issues:read",),
        schema=object_schema({"issue_id": string(ISSUE_REF)}, required=("issue_id",)),
        handler=_list_issue_links,
    ),
    Tool(
        name="create_issue_link",
        description=(
            "Attach a URL link to an issue. Any member of the issue's team may add one. Without a title the "
            "link reads as its hostname; the linked page is never fetched."
        ),
        scopes=("issues:write",),
        schema=object_schema(
            {
                "issue_id": string(ISSUE_REF),
                "url": string(URL_HELP),
                "title": string("What the link reads as; its hostname when left out"),
            },
            required=("issue_id", "url"),
        ),
        handler=_create_issue_link,
    ),
    Tool(
        name="update_issue_link",
        description=(
            "Change the URL or title of a link on an issue. Whoever added the link or an admin of the issue's "
            "team may change it. Only the fields named are written; a null title makes the link read as its "
            "hostname."
        ),
        scopes=("issues:write",),
        schema=object_schema(
            {
                "issue_id": string(ISSUE_REF),
                "link_id": string(LINK_HELP),
                "url": string(URL_HELP),
                "title": nullable("What the link reads as, or null for its hostname"),
            },
            required=("issue_id", "link_id"),
        ),
        handler=_update_issue_link,
        idempotent=True,
    ),
    Tool(
        name="delete_issue_link",
        description=(
            "Remove a URL link from an issue. Whoever added the link or an admin of the issue's team may "
            "remove it. Uploaded files cannot be removed with this tool."
        ),
        scopes=("issues:write",),
        schema=object_schema(
            {"issue_id": string(ISSUE_REF), "link_id": string(LINK_HELP)},
            required=("issue_id", "link_id"),
        ),
        handler=_delete_issue_link,
        destructive=True,
    ),
)
