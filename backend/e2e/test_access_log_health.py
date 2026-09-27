"""The gateway access log for this run's own requests must be clean.

Staging was broken for a day while every suite stayed green, and the whole failure
was plainly visible in the access log the moment anyone read it: 401s the gateway
served with the integration answering 200, and a `routeKey` of `-` on the profile
path no route reached. Nothing read it, so nothing failed.

This reads it. The suite's own requests carry gateway request ids, which
`E2EClient` records for every call it makes, so the sweep correlates on those ids
rather than on a time window that could pick up another run's traffic or a real
user's. Three findings fail the run:

1. Any 5xx. The stage answered its own error to a request the suite made.
2. Any 401 or 403 whose `integrationStatus` is 200, on a request the suite made
   signed in. The function answered fine and the edge refused it anyway, which is
   the authorizer or the gate disagreeing with the application. That is exactly the
   shape the claim-shape outage had.
3. Any `routeKey` of `-` on a non-OPTIONS method. The path matched no route key, so
   the request died at the edge. That is how the missing `GET /api/users/me`
   presented, and it is invisible to every probe that only reads a status.

`webbpulse.e2e.suite.TestAccessLogHealth` now owns the correlation guard and the
integration error message check, so both are gone from here. Finding 2 stays
product side because the plugin has no equivalent: it is the only one of these
that reads the edge status against `integrationStatus`, and it is the shape the
claim-shape outage had.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import pytest
from webbpulse.e2e.access_log import AccessLogEntry

SERVER_ERROR = 500

DENIALS = (401, 403)

UNROUTED = ""
"""What `log_field` renders API Gateway's unset `-` placeholder as."""

ALLOWED_UNROUTED_METHODS = frozenset({"OPTIONS"})
"""Methods whose missing route key is the gateway answering a preflight itself."""


def _describe(entry: AccessLogEntry) -> str:
    """One access log entry as a single line a reader can act on."""
    route = entry.route_key or "-"
    return (
        f"{entry.method} {entry.path} -> status {entry.status}, "
        f"integrationStatus {entry.integration_status}, routeKey {route}, "
        f"requestId {entry.request_id}"
    )


@pytest.fixture(scope="session")
def suite_log_entries(
    e2e_env: Any,
    request: pytest.FixtureRequest,
    suite_requests: Sequence[Any],
) -> "list[AccessLogEntry]":
    """Every access log entry for a request this run made, fetched once at the end.

    Depends on `suite_requests`, which is session scoped and finalised after the last
    test, so the lookup runs when the whole suite's traffic has been sent. The window
    is opened on the first recorded request, so one scan of the delivery window serves
    every id rather than one CloudWatch read each.

    Skips rather than fails when the stage has no access log to read: a local run has
    no gateway at all, and a missing group is a wiring finding the plugin already
    reports, not something to fail every assertion below on.
    """
    if e2e_env.is_local or not e2e_env.access_log_group:
        pytest.skip("the access log is gateway only, runs post deploy")

    recorded = [record for record in suite_requests if record.request_id]
    if not recorded:
        pytest.skip("this run recorded no gateway request ids, so there is nothing to correlate")

    access_log = request.getfixturevalue("access_log")
    found: list[AccessLogEntry] = []
    for record in recorded:
        entry = access_log.find(record.request_id)
        if entry is not None:
            found.append(entry)
    return found


def test_no_request_this_run_made_was_answered_with_a_5xx(suite_log_entries: "list[AccessLogEntry]") -> None:
    """The stage answered no server error to anything the suite sent."""
    failures = [_describe(entry) for entry in suite_log_entries if entry.status >= SERVER_ERROR]
    assert failures == [], "the gateway answered a server error to these requests:\n" + "\n".join(sorted(failures))


def test_no_request_was_refused_at_the_edge_while_the_function_answered(
    suite_log_entries: "list[AccessLogEntry]",
) -> None:
    """No 401 or 403 sits in front of an integration that answered 200.

    The gateway refusing a request the function was happy to serve means the edge and
    the application disagree about who the caller is. That is the claim-shape outage's
    exact signature, and it is the one finding a status-only probe cannot see, because
    the caller only ever sees the 401.
    """
    failures = [
        _describe(entry) for entry in suite_log_entries if entry.status in DENIALS and entry.integration_status == 200
    ]
    assert failures == [], (
        "the gateway refused these requests although the integration answered 200, so the "
        "authorizer or the gate disagrees with the application about the caller:\n" + "\n".join(sorted(failures))
    )


def test_every_request_matched_a_declared_route_key(suite_log_entries: "list[AccessLogEntry]") -> None:
    """No request the suite sent fell through without matching a route key.

    An unset `routeKey` means API Gateway matched nothing and answered its own 404.
    OPTIONS is excluded because the gateway answers a CORS preflight itself.
    """
    failures = [
        _describe(entry)
        for entry in suite_log_entries
        if entry.route_key == UNROUTED and entry.method.upper() not in ALLOWED_UNROUTED_METHODS
    ]
    assert failures == [], (
        "these requests matched no gateway route key, so they died at the edge rather than "
        "reaching any function:\n" + "\n".join(sorted(failures))
    )
