"""Branch names match the web app's copy button character for character."""

from __future__ import annotations

import pytest

from standupless_cli.branch import BRANCH_MAX, branch_name, slugify


@pytest.mark.parametrize(
    ("key", "title", "expected"),
    [
        ("GHS-1", "Fix login", "ghs-1-fix-login"),
        ("ENG-12", "  Crème brûlée: the API's 500!  ", "eng-12-creme-brulee-the-api-s-500"),
        ("ENG-3", "!!!", "eng-3"),
        ("ENG-4", "", "eng-4"),
    ],
)
def test_branch_name(key: str, title: str, expected: str) -> None:
    """Keys lowercase, accents fold, punctuation collapses to single hyphens."""
    assert branch_name(key, title) == expected


def test_long_titles_trim_without_a_trailing_hyphen() -> None:
    """A trimmed slug never ends on the hyphen it was cut at."""
    name = branch_name("ENG-12", "word " * 40)
    assert len(name) <= BRANCH_MAX
    assert not name.endswith("-")
    assert name.startswith("eng-12-word-word")


def test_slugify_keeps_digits() -> None:
    """Digits survive, since version numbers are common in titles."""
    assert slugify("Upgrade to v2.30") == "upgrade-to-v2-30"
