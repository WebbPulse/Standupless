"""The readable link rules, which must match `frontend/src/lib/readableIds.ts` exactly."""

from __future__ import annotations

import pytest

from app.common.core.config import settings
from app.common.readable_ids import (
    SLUG_MAX_LENGTH,
    initiative_web_url,
    is_ulid,
    name_slug,
    project_web_url,
    readable_id,
)

ULID = "01JB000000000000000000PRJX"


@pytest.mark.parametrize(
    ("name", "slug"),
    [
        ("Launch Plan", "launch-plan"),
        ("Café Déjà Vu", "cafe-deja-vu"),
        ("日本 rollout", "rollout"),
        ("Straße", "strae"),
        ("🚀 Ship it!!! (v2.0)", "ship-it-v2-0"),
        ("  --Already-kebab--  ", "already-kebab"),
        ("", ""),
        ("🚀🎉", ""),
        ("!!!", ""),
    ],
)
def test_name_slug_folds_names_to_ascii_kebab_case(name: str, slug: str) -> None:
    """Accents fold, other characters become separators, and nothing left is an empty slug."""
    assert name_slug(name) == slug


def test_name_slug_caps_long_names_without_a_trailing_separator() -> None:
    """A long name is cut to the cap and never ends in a separator."""
    slug = name_slug("word " * 30)
    assert len(slug) <= SLUG_MAX_LENGTH
    assert not slug.endswith("-")
    assert slug.startswith("word-word")
    assert name_slug("a" * 59 + " b") == "a" * 59


def test_name_slug_is_deterministic() -> None:
    """The same name always gives the same slug."""
    assert name_slug("Q4 Roadmap: Mobile & Web") == name_slug("Q4 Roadmap: Mobile & Web") == "q4-roadmap-mobile-web"


def test_is_ulid() -> None:
    """Only a 26 character Crockford id counts, in either case."""
    assert is_ulid(ULID)
    assert is_ulid(ULID.lower())
    assert not is_ulid("01JB000000000000000000INIT")
    assert not is_ulid("p1")


def test_readable_id_prefixes_a_ulid_with_the_slug() -> None:
    """A ULID gets its slug, and anything else stays bare."""
    assert readable_id(ULID, "Launch Plan") == f"launch-plan-{ULID}"
    assert readable_id(ULID, "") == ULID
    assert readable_id(ULID, None) == ULID
    assert readable_id(ULID, "🚀") == ULID
    assert readable_id("p1", "Launch Plan") == "p1"


def test_web_urls_use_the_readable_segment() -> None:
    """Project and initiative links carry the slug in front of the id."""
    base = f"{settings.frontend_base_url}/w/acme"
    assert project_web_url("acme", ULID, "Launch Plan") == f"{base}/projects/launch-plan-{ULID}"
    assert initiative_web_url("acme", ULID, "Grow EU") == f"{base}/initiatives/grow-eu-{ULID}"
    assert project_web_url("acme", "p1", "Launch") == f"{base}/projects/p1"
