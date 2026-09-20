"""The gateway access log for this run's own requests must be clean.

Staging was broken for a day while every suite stayed green, and the whole failure
was plainly visible in the access log the moment anyone read it: 401s the gateway
served with the integration answering 200, and a `routeKey` of `-` on the profile
path no route reached. Nothing read it, so nothing failed.

This reads it. The suite's own requests carry gateway request ids, which
`E2EClient` records for every call it makes, so the sweep correlates on those ids
rather than on a time window that could pick up another run's traffic or a real
user's. Four findings fail the run:

1. Any 5xx. The stage answered its own error to a request the suite made.
2. Any 401 or 403 whose `integrationStatus` is 200, on a request the suite made
   signed in. The function answered fine and the edge refused it anyway, which is
   the authorizer or the gate disagreeing with the application. That is exactly the
   shape the claim-shape outage had.
3. Any `routeKey` of `-` on a non-OPTIONS method. The path matched no route key, so
   the request died at the edge. That is how the missing `GET /api/users/me`
   presented, and it is invisible to every probe that only reads a status.
4. Any entry carrying `errorMessage` or `integrationErrorMessage`. The gateway
   recorded a reason and nothing looked at it.

The plugin owns the access log lookup and the per-route cut assertions; it has no
whole-run health sweep of its own, which is the upstream gap this fills product
side for now.

That gap is closed upstream by `webbpulse.e2e.suite.TestAccessLogHealth`, which
lands with the `access_log_health` and `suite_requests` session fixtures in
webbpulse-python PR 92. It carries the same four findings and the same vacuous
pass guard, gated on `access_log_group`. Once that ships and the pin moves, this
module deletes and the product keeps nothing: the checks are not product specific.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import pytest
from webbpulse.e2e.access_log import AccessLogEntry, log_field

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


def _error_text(entry: AccessLogEntry) -> str:
    """The error the gateway recorded on one entry, or empty when it recorded none."""
    return log_field(entry.raw, "errorMessage", "integrationErrorMessage")


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


def test_the_access_log_carries_this_runs_requests(suite_log_entries: "list[AccessLogEntry]") -> None:
    """The sweep found entries at all, so the checks below cannot pass by finding nothing.

    A delivery window that returned nothing would make every assertion below vacuous
    and report green, which is the failure mode this whole file exists to end.
    """
    assert suite_log_entries != [], (
        "no access log entry was delivered for any request this run made, so the health "
        "sweep below asserted nothing. Check the access log group and its format."
    )


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


def test_no_access_log_entry_recorded_an_error(suite_log_entries: "list[AccessLogEntry]") -> None:
    """The gateway recorded no error message against anything the suite sent.

    `errorMessage` and `integrationErrorMessage` are where a timeout, a permission
    denial on the integration and a malformed response all land, none of which
    necessarily change the status the caller sees.
    """
    failures = [f"{_describe(entry)}: {message}" for entry in suite_log_entries if (message := _error_text(entry))]
    assert failures == [], "the gateway recorded an error against these requests:\n" + "\n".join(sorted(failures))
