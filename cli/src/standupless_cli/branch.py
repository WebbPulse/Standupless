"""Git branch names for issues, the same names the web app's copy button produces.

Keep this in step with `frontend/src/lib/gitBranch.ts`: a pull request opened from
either branch has to link back to the same issue. Both are held to
`tests/fixtures/branch_names.json`.
"""

from __future__ import annotations

import re
import unicodedata

BRANCH_MAX = 60

BRANCH_FORMATS = ("key_title", "user_key_title", "key")

DEFAULT_BRANCH_FORMAT = "key_title"


def slugify(title: str) -> str:
    """Fold accents away, lowercase, and collapse everything else into single hyphens."""
    decomposed = unicodedata.normalize("NFKD", title)
    stripped = re.sub("[̀-ͯ]", "", decomposed)
    return re.sub(r"[^a-z0-9]+", "-", stripped.lower()).strip("-")


def _trim(text: str, room: int) -> str:
    """Cut `text` to `room` characters without leaving a trailing hyphen."""
    return text[: max(room, 0)].rstrip("-")


def branch_name(key: str, title: str, branch_format: str = DEFAULT_BRANCH_FORMAT, handle: str = "") -> str:
    """`eng-12-fix-the-login-page`, `tyler/eng-12-fix-the-login-page` or `eng-12`, never over `BRANCH_MAX`.

    The handle is shortened before the key is ever cut, and a format needing a
    handle falls back to the key and title when there is none.
    """
    prefix = key.lower()
    if branch_format == "key":
        return prefix
    short = _trim(slugify(handle), BRANCH_MAX - len(prefix) - 1) if branch_format == "user_key_title" else ""
    head = f"{short}/{prefix}" if short else prefix
    slug = _trim(slugify(title), BRANCH_MAX - len(head) - 1)
    return f"{head}-{slug}" if slug else head


def branch_handle(display_name: str | None, email: str | None) -> str:
    """The handle a person's branches carry: their username, else their email's local part."""
    name = (display_name or "").strip()
    return name or (email or "").partition("@")[0]
