"""Every route the backend serves must be called by at least one post-deploy test.

A route nobody calls after a deploy is a route whose first caller is a user. The
generic suite probes every declared operation, and the product flows drive the real
sequences, but neither states which routes that leaves untouched, so a route can go
uncovered without anyone deciding that it should.

This states it. The suite records the method and path template of every request it
makes, and this compares that set against the route contract the unit tests pin.
Anything uncovered and not in `route_coverage_allowlist.py` fails the run, and a
stale allowlist entry fails it too, so an entry cannot outlive its reason.

Recording is one session fixture over the shared client's own `records` list, which
`E2EClient` already appends to on every call, so it costs one pass over a list at
session end rather than anything per request.

This waits on `webbpulse.e2e.suite.TestRouteCoverage` in webbpulse-python PR 92,
which owns the template matching, the staleness check and the empty reason check,
and takes a product's allowlist through the `pytest_e2e_uncovered_routes` hook.
Once that ships and the pin moves, this module becomes that hook implementation
over `route_coverage_allowlist.py`, and the matching logic here deletes.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import pytest
from route_coverage_allowlist import UNCOVERED_BY_DESIGN

CONTRACT = Path(__file__).resolve().parent.parent / "tests" / "common" / "route_contract.json"

INTERNAL = "internal"

IDENTITY_PREFIX = "/api/auth"


def _contract_routes() -> "list[tuple[str, str]]":
    """Every non-internal route the backend serves, as method and path template.

    Internal routes are excluded because they carry `include_in_schema=False`: they
    are health probes the platform calls, not product surface a post-deploy run has
    to reach.
    """
    rows = json.loads(CONTRACT.read_text())
    return sorted({(str(row["method"]).upper(), str(row["path"])) for row in rows if str(row["auth"]) != INTERNAL})


def _template_pattern(path: str) -> "re.Pattern[str]":
    """One contract path template as a regex matching the concrete paths it serves.

    A parameter matches one segment, so `/api/workspaces/{workspace_id}/issues` matches
    a real workspace id and never swallows the segments after it.
    """
    escaped = re.escape(path)
    wildcarded = re.sub(r"\\\{\w+\\\}", r"[^/]+", escaped)
    return re.compile(rf"^{wildcarded}/?$")


def _matched_template(
    method: str, path: str, templates: "Sequence[tuple[str, str, re.Pattern[str]]]"
) -> "tuple[str, str] | None":
    """The contract route one concrete request exercised, or None when it matched none.

    The longest literal prefix wins where two templates both match, which is the same
    specificity rule the gateway itself picks a route key by: a literal segment beats
    a parameter.
    """
    candidates = [
        (template_method, template_path)
        for template_method, template_path, pattern in templates
        if template_method == method and pattern.match(path)
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda row: (row[1].count("/") - row[1].count("{"), len(row[1])))


def covered_routes(records: "Sequence[Any]") -> "set[tuple[str, str]]":
    """Every contract route the recorded requests exercised.

    A request whose path matches no template is dropped rather than raised on: the
    suite calls identity package routes and a few deliberately absent paths, and
    neither is the product surface this measures.
    """
    templates = [(method, path, _template_pattern(path)) for method, path in _contract_routes()]
    covered: set[tuple[str, str]] = set()
    for record in records:
        path = str(record.path).split("?")[0]
        if not path.startswith("/"):
            continue
        matched = _matched_template(str(record.method).upper(), path, templates)
        if matched is not None:
            covered.add(matched)
    return covered


@pytest.fixture(scope="session")
def route_coverage(suite_requests: "Sequence[Any]") -> "set[tuple[str, str]]":
    """The contract routes this run exercised, computed once after the last test."""
    return covered_routes(suite_requests)


def test_the_run_recorded_requests_to_correlate(suite_requests: "Sequence[Any]") -> None:
    """The recorder captured requests at all, so the coverage below is a real measurement.

    An empty record list would make every route read as uncovered, which is a wiring
    failure in the recorder rather than a coverage finding, and it should say so.
    """
    assert len(suite_requests) > 0, (
        "the suite recorded no requests, so route coverage could not be measured. The "
        "recorder reads the shared E2EClient's own records list."
    )


def test_every_served_route_was_exercised_or_is_allowlisted(
    route_coverage: "set[tuple[str, str]]",
    e2e_env: Any,
) -> None:
    """Every non-internal route was called, or is named in the allowlist with a reason.

    A route reaching neither is one a deploy ships untested, which is how a route that
    no gateway prefix reaches or that 401s on every caller gets to production.
    """
    if e2e_env.read_only:
        pytest.skip("the read-only production run skips every write flow, so its coverage is not the measure")

    uncovered = [
        f"{method} {path}"
        for method, path in _contract_routes()
        if (method, path) not in route_coverage and (method, path) not in UNCOVERED_BY_DESIGN
    ]
    assert uncovered == [], (
        "these routes were not called by any post-deploy test and are not allowlisted, so "
        "this deploy shipped them untested. Cover them or add them to "
        "route_coverage_allowlist.py with a reason:\n" + "\n".join(sorted(uncovered))
    )


def test_the_coverage_allowlist_is_not_stale(route_coverage: "set[tuple[str, str]]", e2e_env: Any) -> None:
    """No allowlist entry names a route that is now covered, or one that no longer exists.

    A stale entry is worse than no entry: it reads as a decision while silently
    excusing a route nobody checks any more.
    """
    if e2e_env.read_only:
        pytest.skip("the read-only production run exercises less, so an entry cannot be judged stale from it")

    served = set(_contract_routes())
    stale: list[str] = []
    for method, path in UNCOVERED_BY_DESIGN:
        if (method, path) not in served:
            stale.append(f"{method} {path} is allowlisted but the backend no longer serves it")
        elif (method, path) in route_coverage:
            stale.append(f"{method} {path} is allowlisted as uncovered but the suite now calls it")

    assert stale == [], "the route coverage allowlist is out of date:\n" + "\n".join(sorted(stale))


def test_every_allowlist_entry_carries_a_reason() -> None:
    """An allowlist entry with no reason is a route nobody decided about.

    The reason is the whole value of the file: it turns a hole into a statement that a
    reviewer can disagree with.
    """
    missing = [f"{method} {path}" for (method, path), reason in UNCOVERED_BY_DESIGN.items() if not reason.strip()]
    assert missing == [], f"these allowlist entries carry no reason: {sorted(missing)}"
