"""The single sign-on domain recheck: a verified domain keeps its rights only while its TXT record stays.

The hourly workspaces sweep runs it after starting the due purges. Each verified
domain's claim says when its record is next due, a day after the last check that
found it, so the sweep only looks up the few that are due. A record found missing
is checked again an hour later, and a second miss in a row lapses the domain: it
leaves the user index, so no sign-in finds the workspace by it and nobody new
joins or links through it, its claim is freed for whoever proves it next, and the
settings page shows the lapse. A DNS failure is neither a find nor a miss, so the
domain is left as it was and checked on the next run.

A claim whose holder no longer has the domain verified, such as one left behind by
a purged workspace, is deleted, so the claims partition stays the list of domains
that really are verified.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta

from webbpulse.dynamodb import ConditionFailed

from app.common import audit
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.memberships import SsoDomainClaim
from app.common.team_purge import Deadline

_log = logging.getLogger(__name__)

DUE_MARGIN = timedelta(minutes=10)
"""How early a claim counts as due, so an hourly retry is not pushed back by a run that starts a little early."""


@dataclass
class RecheckSummary:
    """What one recheck did, for the log line."""

    checked: int = 0
    missed: int = 0
    lapsed: int = 0
    unavailable: int = 0
    stale: int = 0
    failed: int = 0


def _due(claim: SsoDomainClaim, now: datetime) -> bool:
    """Whether a claim's record is due to be looked up."""
    return claim.next_check_at <= now + DUE_MARGIN


def _lapse(repositories: Repositories, claim: SsoDomainClaim, summary: RecheckSummary) -> None:
    """Lapse one domain and audit it in its workspace."""
    if not repositories.memberships.lapse_sso_domain(claim):
        return
    summary.lapsed += 1
    audit.record_system(
        repositories,
        claim.holder_workspace_id,
        "sso.domain_lapsed",
        target_type="sso_domain",
        target_id=claim.domain,
        target_label=claim.domain,
        before={"verified": True},
        after={"verified": False},
    )
    _log.warning(
        "A single sign-on domain lapsed because its TXT record is gone.",
        extra={"event": "sso.domain_lapsed", "workspace_id": claim.holder_workspace_id, "domain": claim.domain},
    )


def _recheck_one(repositories: Repositories, claim: SsoDomainClaim, summary: RecheckSummary) -> None:
    """Look one claimed domain's record up and record what was found."""
    from webbpulse.identity import DomainVerificationUnavailable

    from app.common.sso import domain_is_verified

    row = repositories.memberships.get_sso_domain(claim.holder_workspace_id, claim.domain)
    if row is None or not row.verified:
        summary.stale += 1
        repositories.memberships.release_sso_domain_claim(claim.holder_workspace_id, claim.domain)
        return
    summary.checked += 1
    try:
        found = domain_is_verified(claim.domain, row.token)
    except DomainVerificationUnavailable:
        summary.unavailable += 1
        return
    if not found and claim.missed_at is not None:
        _lapse(repositories, claim, summary)
        return
    if not found:
        summary.missed += 1
    try:
        repositories.memberships.record_sso_domain_check(claim, found=found)
    except ConditionFailed:
        return


def recheck(repositories: Repositories, deadline: Deadline, *, now: datetime | None = None) -> RecheckSummary:
    """Recheck every verified domain whose record is due, until the deadline.

    One domain failing is logged and skipped, so it never holds up the rest or the
    purges the same sweep started.
    """
    summary = RecheckSummary()
    moment = now or utc_now()
    for claim in repositories.memberships.list_sso_domain_claims():
        if deadline.expired():
            break
        if not _due(claim, moment):
            continue
        try:
            _recheck_one(repositories, claim, summary)
        except Exception:
            summary.failed += 1
            _log.exception(
                "A single sign-on domain recheck failed.",
                extra={"event": "sso.domain_recheck_failed", "domain": claim.domain},
            )
    _log.info(
        "Rechecked single sign-on domains.",
        extra={
            "event": "sso.domain_recheck",
            "checked": summary.checked,
            "missed": summary.missed,
            "lapsed": summary.lapsed,
            "unavailable": summary.unavailable,
            "stale": summary.stale,
            "failed": summary.failed,
        },
    )
    return summary
