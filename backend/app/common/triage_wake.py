"""Ending a triage snooze early when someone else comments on the issue.

Held apart from `issue_triage` because that module posts accept comments through
`comment_writes`, and every comment write path calls in here, so living there
would make the import circular. A snooze in triage hides an issue until its time
or new activity from someone other than the person who snoozed it, whichever
comes first.
"""

from __future__ import annotations

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue


def wake_on_activity(repositories: Repositories, issue: Issue, actor_id: str) -> bool:
    """Bring a snoozed triage issue back for a new comment by `actor_id`, answering whether it did.

    A comment by the person who snoozed it, an issue out of triage and one whose
    snooze has already run out are left as they are. The write records no history
    and leaves `updated_at` alone, as the snooze itself does.
    """
    if not issue.in_triage or issue.snoozed_until is None or issue.snoozed_until <= utc_now():
        return False
    if issue.snoozed_by is not None and issue.snoozed_by == actor_id:
        return False
    return repositories.issues.wake_snoozed(issue)
