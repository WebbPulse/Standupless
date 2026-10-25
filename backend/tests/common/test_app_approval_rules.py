"""The approval predicates and request ticket the consent gate and the approval routes share."""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

import pytest

from app.common.app_approvals import (
    TicketError,
    mint_request_ticket,
    needs_approval,
    read_request_ticket,
    refresh_refused,
    return_to,
)
from app.common.db.dynamo.memberships import AppApproval

WORKSPACE = "01JB00000000000000000000WS"


def record(status: str) -> AppApproval:
    """One app's approval record in the given status."""
    return AppApproval(workspace_id=WORKSPACE, client_id="client", status=status)  # pyright: ignore[reportArgumentType]


def test_nothing_is_held_with_the_setting_off_or_for_a_first_party_client() -> None:
    """The switch and first-party clients both bypass the gate, whatever the record says."""
    assert not needs_approval(False, False, None)
    assert not needs_approval(True, True, record("denied"))


def test_approved_passes_and_denied_holds_even_an_existing_grant() -> None:
    """A decision outranks whether the member already held a grant."""
    assert not needs_approval(True, False, record("approved"))
    assert needs_approval(True, False, record("denied"), has_grant=True)


def test_an_undecided_app_holds_only_a_member_without_a_grant() -> None:
    """Re-authorizing a grant from before the setting passes; a first authorization waits."""
    assert needs_approval(True, False, None)
    assert needs_approval(True, False, record("pending"))
    assert not needs_approval(True, False, None, has_grant=True)


def test_only_a_denial_with_the_setting_on_stops_a_refresh() -> None:
    """A pending or missing record keeps a standing grant refreshing."""
    assert refresh_refused(True, False, record("denied"))
    assert not refresh_refused(False, False, record("denied"))
    assert not refresh_refused(True, True, record("denied"))
    assert not refresh_refused(True, False, record("pending"))
    assert not refresh_refused(True, False, None)


def test_return_to_keeps_the_request_and_drops_consent_fields() -> None:
    """The resumed authorization carries the client's request and nothing the consent form added."""
    url = return_to(
        "https://api.example.test/api/auth/",
        {"client_id": "client", "state": "s", "scope": "issues:read", "tenant_id": WORKSPACE, "decision": "allow"},
    )

    parts = urlsplit(url)
    assert parts.path == "/api/auth/authorize"
    assert parse_qs(parts.query) == {"client_id": ["client"], "state": ["s"], "scope": ["issues:read"]}


def test_a_ticket_reads_back_only_in_its_own_workspace() -> None:
    """A ticket names its app, and another workspace or a forgery is refused."""
    ticket = mint_request_ticket(WORKSPACE, "client", "Client", "https://example.test/authorize")

    assert read_request_ticket(ticket, WORKSPACE)["client_id"] == "client"
    with pytest.raises(TicketError):
        read_request_ticket(ticket, "01JB0000000000000000000WS2")
    with pytest.raises(TicketError):
        read_request_ticket("forged", WORKSPACE)
