"""The customer request create by email files when a sender's domain belongs to a customer.

A mail filed through a team's intake address is customer demand when its sender
writes from a domain one of the workspace's customers claims. The match is exact
on the domain, ignoring case, and never on a public mail provider anyone can sign
up to. One request ties the new issue to that customer, quoting the subject.

The request is attributed to the intake rather than to a member, so it carries
`INTAKE_AUTHOR` and the `email` source, and nothing about the sender beyond the
customer their domain names. Only a workspace admin may remove it, as with any
request whose author is not the caller.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Optional

from webbpulse.dynamodb import ConditionFailed

from app.common.api.schemas.customers import QUOTE_MAX
from app.common.approved_domains import PUBLIC_EMAIL_PROVIDERS
from app.common.change_source import EMAIL
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.customers import Customer, CustomerRequest, new_customer_id

if TYPE_CHECKING:
    from app.common.api.dependencies.repositories import Repositories
    from app.common.db.dynamo.issues import Issue

_log = logging.getLogger(__name__)

INTAKE_AUTHOR = "email-intake"
"""The author id an intake request carries, which names no member."""


def sender_domain(address: str) -> Optional[str]:
    """The domain of a sender address, lower cased, or `None` when it has none."""
    _, at, domain = address.strip().rpartition("@")
    clean = domain.strip().rstrip(".").casefold()
    return clean if at and clean else None


def customer_for_domain(repositories: Repositories, workspace_id: str, domain: Optional[str]) -> Optional[Customer]:
    """The one customer claiming a domain, or `None` for no match, a public provider or several claimants."""
    if not domain or domain in PUBLIC_EMAIL_PROVIDERS:
        return None
    found = [
        customer
        for customer in repositories.customers.list_customers(workspace_id)
        if domain in {held.casefold() for held in customer.domains}
    ]
    return found[0] if len(found) == 1 else None


def file_intake_request(
    repositories: Repositories, issue: Issue, sender_address: str, note: str
) -> Optional[CustomerRequest]:
    """Tie an emailed-in issue to the customer its sender's domain names, at most once per issue and customer.

    Answers the request filed, or `None` when no customer matches or the issue
    already carries one from that customer, as after a redelivery.
    """
    workspace_id = issue.workspace_id
    customer = customer_for_domain(repositories, workspace_id, sender_domain(sender_address))
    if customer is None:
        return None
    held = repositories.customers.list_for_target(workspace_id, "issue", issue.issue_id)
    if any(request.customer_id == customer.customer_id for request in held):
        return None
    request = CustomerRequest(
        workspace_id=workspace_id,
        request_id=new_customer_id(),
        customer_id=customer.customer_id,
        target_kind="issue",
        target_id=issue.issue_id,
        team_ids=[issue.team_id],
        body=note.strip()[:QUOTE_MAX],
        author_id=INTAKE_AUTHOR,
        source=EMAIL,
        created_at=utc_now(),
    )
    try:
        stored = repositories.customers.add_request(request)
    except ConditionFailed:
        return None
    _log.info(
        "An intake mail was tied to a customer.",
        extra={"event": "email_intake.customer_request", "issue_id": issue.issue_id},
    )
    return stored
