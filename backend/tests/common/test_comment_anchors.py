"""The comment anchor helpers: deriving a passage from a quote and quoting it for GitHub."""

from __future__ import annotations

from app.common.comment_anchors import ANCHOR_CONTEXT_KEPT, anchor_from_quote, plain_text, quoted_passage
from app.common.db.dynamo.comments import CommentAnchor


def test_a_quote_is_found_with_the_text_either_side() -> None:
    """The anchor keeps the words around the passage, which is what tells repeats apart."""
    anchor = anchor_from_quote("We should cache the board query before launch.", "  the board query ")

    assert anchor == CommentAnchor(quote="the board query", prefix="We should cache ", suffix=" before launch.")


def test_the_context_is_capped() -> None:
    """A long description keeps only a bounded slice of context on each side."""
    body = "a" * 100 + "needle" + "b" * 100

    anchor = anchor_from_quote(body, "needle")

    assert anchor is not None
    assert anchor.prefix == "a" * ANCHOR_CONTEXT_KEPT
    assert anchor.suffix == "b" * ANCHOR_CONTEXT_KEPT


def test_a_quote_matches_across_inline_marks() -> None:
    """A reader selects the rendered words, so bold and code marks do not stop a match."""
    anchor = anchor_from_quote("Run the **nightly** `sync` job.", "the nightly sync job")

    assert anchor is not None
    assert anchor.quote == "the nightly sync job"
    assert plain_text("**a** _b_ `c`") == "a b c"


def test_a_quote_the_description_lacks_is_none() -> None:
    """Text that is not in the description, or nothing at all, pins nothing."""
    assert anchor_from_quote("Some description", "missing words") is None
    assert anchor_from_quote("Some description", "   ") is None


def test_the_github_copy_quotes_the_passage() -> None:
    """Every line of the passage is quoted, and no anchor renders nothing."""
    rendered = quoted_passage(CommentAnchor(quote="first line\n\nsecond line"))

    assert rendered == "On the description:\n\n> first line\n>\n> second line\n\n"
    assert quoted_passage(None) == ""
