"""Which client a change came through: the web app, MCP, the CLI, the API, GitHub or a job.

The source is attribution only. It is derived from the credential that authenticated
the request, never from a request field, so a client cannot claim to be another one.
It rides on activity, comment, project update and notification rows as an optional
attribute, and a row written before it existed has none and renders as before.
"""

from __future__ import annotations

from typing import Literal, Optional

ChangeSource = Literal["web", "mcp", "cli", "api", "github", "system"]

CHANGE_SOURCES: tuple[str, ...] = ("web", "mcp", "cli", "api", "github", "system")

WEB = "web"
MCP = "mcp"
CLI = "cli"
API = "api"
GITHUB = "github"
SYSTEM = "system"

AUTOMATED_ACTOR_KINDS: frozenset[str] = frozenset({GITHUB, SYSTEM})
"""Actor kinds that are their own source, because no person's client made the change."""


def source_for(source: Optional[str], actor_kind: str = "user") -> Optional[str]:
    """The source to store: the one given, else the actor kind for GitHub and system rows.

    A row written by a job or the GitHub integration names that origin without each
    caller repeating it, and a user row with no source given stays unattributed.
    """
    if source:
        return source
    if actor_kind in AUTOMATED_ACTOR_KINDS:
        return actor_kind
    return None
