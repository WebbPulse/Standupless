"""Branch names match the web app's copy button character for character."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from standupless_cli.branch import BRANCH_MAX, branch_handle, branch_name, slugify

CASES: list[dict[str, Any]] = json.loads(
    (Path(__file__).parent / "fixtures" / "branch_names.json").read_text(encoding="utf-8")
)
"""The cases `frontend/src/lib/gitBranch.test.ts` reads too, so both implementations agree."""


@pytest.mark.parametrize("case", CASES, ids=[f"{case['format']}:{case['expected']}" for case in CASES])
def test_the_shared_fixture(case: dict[str, Any]) -> None:
    """Every format matches the web app's output for the same key, title and handle."""
    assert branch_name(case["key"], case["title"], case["format"], case["handle"]) == case["expected"]
    assert len(case["expected"]) <= BRANCH_MAX
    assert case["key"].lower() in case["expected"]


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


def test_a_long_handle_is_cut_before_the_key() -> None:
    """The key survives whole however long the handle is."""
    name = branch_name("STUP-497", "Fix login", "user_key_title", "a" * 80)
    assert len(name) <= BRANCH_MAX
    assert name.endswith("/stup-497")


def test_the_handle_falls_back_to_the_email() -> None:
    """A person with no username branches under their email's local part."""
    assert branch_handle(None, "tyler@example.com") == "tyler"
    assert branch_handle("  tw  ", "tyler@example.com") == "tw"
