"""Readable, durable path segments for project and initiative links.

A segment is `<name-slug>-<ULID>`: the slug tells a reader what the link is and
the ULID is what the web app resolves, so a link keeps working after a rename.
These rules mirror `frontend/src/lib/readableIds.ts` exactly, so a link built
here and one built in the browser are the same string.
"""

from __future__ import annotations

import re
import unicodedata
from urllib.parse import quote

from app.common.core.config import settings

SLUG_MAX_LENGTH = 60
"""The longest slug a segment carries, before the id."""

_ULID = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$", re.IGNORECASE)
_SEPARATORS = re.compile(r"[^a-z0-9]+")


def is_ulid(value: str) -> bool:
    """Whether a value is a ULID, the only kind of id a slug is put in front of."""
    return _ULID.fullmatch(value) is not None


def name_slug(name: str) -> str:
    """A name as lowercase ASCII kebab-case of at most 60 characters.

    Accents fold to their base letters, anything else outside ASCII letters and
    digits becomes a separator, and a name with nothing left gives an empty slug.
    """
    folded = "".join(char for char in unicodedata.normalize("NFKD", name) if char.isascii()).lower()
    return _SEPARATORS.sub("-", folded).strip("-")[:SLUG_MAX_LENGTH].rstrip("-")


def readable_id(entity_id: str, name: str | None) -> str:
    """The path segment for an entity: `<slug>-<id>`, or the bare id when there is no slug or no ULID."""
    slug = name_slug(name) if name else ""
    return f"{slug}-{entity_id}" if slug and is_ulid(entity_id) else entity_id


def workspace_web_base(workspace_slug: str) -> str:
    """The web app root of one workspace."""
    return f"{settings.frontend_base_url}/w/{quote(workspace_slug, safe='')}"


def project_web_url(workspace_slug: str, project_id: str, name: str | None) -> str:
    """The web app page of one project, in its readable form."""
    return f"{workspace_web_base(workspace_slug)}/projects/{quote(readable_id(project_id, name), safe='')}"


def initiative_web_url(workspace_slug: str, initiative_id: str, name: str | None) -> str:
    """The web app page of one initiative, in its readable form."""
    return f"{workspace_web_base(workspace_slug)}/initiatives/{quote(readable_id(initiative_id, name), safe='')}"
