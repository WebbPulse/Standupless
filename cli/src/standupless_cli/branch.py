"""Git branch names for issues, the same names the web app's copy button produces.

Keep this in step with `frontend/src/lib/gitBranch.ts`: a pull request opened from
either branch has to link back to the same issue.
"""

from __future__ import annotations

import re
import unicodedata

BRANCH_MAX = 60


def slugify(title: str) -> str:
    """Fold accents away, lowercase, and collapse everything else into single hyphens."""
    decomposed = unicodedata.normalize("NFKD", title)
    stripped = re.sub("[\u0300-\u036f]", "", decomposed)
    return re.sub(r"[^a-z0-9]+", "-", stripped.lower()).strip("-")


def branch_name(key: str, title: str) -> str:
    """`eng-12-fix-the-login-page`, trimmed to `BRANCH_MAX` and never ending in a hyphen."""
    prefix = key.lower()
    room = BRANCH_MAX - len(prefix) - 1
    slug = slugify(title)[: max(room, 0)].rstrip("-")
    return f"{prefix}-{slug}" if slug else prefix
