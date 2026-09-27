"""Write the backend's reaction picker set out for the frontend to import.

The two halves each held their own list and drifted: only 15 of 24 matched, and
two more differed by nothing but the variation selector, so a reader could pick an
emoji the API then refused. The backend owns the list now and this writes it to
`frontend/src/lib/reactions.json`, which the picker imports.

Run it after changing `REACTION_EMOJI`. `tests/domains/discussion/test_reactions.py`
compares the checked-in file against the list, so forgetting to run it fails CI
rather than reaching a reader.
"""

from __future__ import annotations

import json
from pathlib import Path

from app.domains.discussion.schemas.discussion import REACTION_EMOJI

REACTIONS_JSON = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "reactions.json"
"""Where the generated file lives, relative to this script rather than the cwd."""


def rendered() -> str:
    """The exact file contents, so the test compares bytes rather than parsed data.

    Two-space indent and a trailing newline because that is what prettier writes,
    and a file the formatter would rewrite would fail the frontend lint gate.
    """
    return json.dumps(list(REACTION_EMOJI), ensure_ascii=False, indent=2) + "\n"


def main() -> None:
    """Write the file, reporting where it went and how many emoji it carries."""
    REACTIONS_JSON.write_text(rendered(), encoding="utf-8")
    print(f"wrote {len(REACTION_EMOJI)} emoji to {REACTIONS_JSON}")


if __name__ == "__main__":
    main()
