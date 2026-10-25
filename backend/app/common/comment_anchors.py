"""Comment anchors: a root comment pinned to a passage of its issue's description.

An anchor is the quoted passage plus up to `ANCHOR_CONTEXT_MAX` characters either
side of it, which is what tells repeats of the same words apart. The web client
captures it from the rendered description and finds it again there, so this
module only bounds it, derives one from a quote for a client that names the text
alone, and renders it for GitHub. Held in `common` because the discussion routes
and the integrations image both write and post anchored comments.
"""

from __future__ import annotations

import re

from app.common.db.dynamo.comments import CommentAnchor

ANCHOR_QUOTE_MAX = 1000
"""The longest passage a comment may be pinned to, in characters."""

ANCHOR_CONTEXT_MAX = 64
"""The most surrounding text kept on either side of the passage, in characters."""

ANCHOR_CONTEXT_KEPT = 32
"""How much surrounding text a derived anchor keeps on either side."""

_MARKDOWN_MARKS = re.compile(r"(\*\*|__|~~|`|\*|_)")


def plain_text(markdown: str) -> str:
    """Markdown with its inline emphasis marks dropped, which is near what a reader sees.

    Only the marks that wrap text inside a line go, so a passage that crosses bold
    or code still matches the words a reader would select.
    """
    return _MARKDOWN_MARKS.sub("", markdown)


def anchor_from_quote(body: str, quote: str) -> CommentAnchor | None:
    """The anchor for the first place a description shows `quote`, or `None` when it does not.

    Searched in the description with its inline marks dropped, falling back to the
    raw Markdown, so an agent can quote the words it reads either way.
    """
    wanted = quote.strip()
    if not wanted:
        return None
    for text in (plain_text(body), body):
        found = text.find(wanted)
        if found >= 0:
            end = found + len(wanted)
            return CommentAnchor(
                quote=wanted,
                prefix=text[max(0, found - ANCHOR_CONTEXT_KEPT) : found],
                suffix=text[end : end + ANCHOR_CONTEXT_KEPT],
            )
    return None


def quoted_passage(anchor: CommentAnchor | None) -> str:
    """The anchored passage as a Markdown blockquote and a blank line, or nothing.

    Prefixed to a comment's GitHub copy, so a reader there sees what it is about.
    """
    if anchor is None:
        return ""
    lines = anchor.quote.strip().splitlines() or [""]
    quoted = "\n".join(f"> {line}" if line.strip() else ">" for line in lines)
    return f"On the description:\n\n{quoted}\n\n"
