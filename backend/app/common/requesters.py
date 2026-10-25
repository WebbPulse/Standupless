"""The requester an intake keeps on an issue it files for someone, built from what the intake already holds.

Email intake knows the sender's display name and address, and Slack intake the
`users.info` answer for the person who wrote the message. Both are reduced here
to an `IssueRequester`: an email address is masked before it is kept, a display
name that is itself an address is dropped, and a Slack avatar is kept only when
it is an `https` link, so a requester row can be shown to any reader as stored.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

from app.common.change_source import EMAIL, SLACK
from app.common.db.dynamo.issues import IssueRequester
from app.common.workspace_export import mask_email

NAME_MAX = 80
"""The most characters of a requester's name or handle kept."""

AVATAR_MAX = 512
"""The longest avatar link kept."""

_AVATAR_FIELDS: tuple[str, ...] = ("image_72", "image_48", "image_192", "image_32")
"""The Slack profile images tried in order, the first one present kept."""


def _clean(value: Any) -> str:
    """One line of text, whitespace collapsed and trimmed to the name limit."""
    return " ".join(str(value or "").split())[:NAME_MAX].strip()


def email_requester(name: str, address: str, *, user_id: Optional[str] = None) -> IssueRequester:
    """The requester of an emailed-in issue: the sender's name, unless it is an address, and the address masked."""
    clean = "" if "@" in name else _clean(name)
    address = address.strip()
    return IssueRequester(
        source=EMAIL,
        name=clean,
        masked_email=mask_email(address) if address else None,
        user_id=user_id,
    )


def slack_requester(
    profile: Mapping[str, Any], slack_user_id: str, *, user_id: Optional[str] = None
) -> Optional[IssueRequester]:
    """The requester of an issue filed from a Slack message, from its author's `users.info` answer.

    Answers `None` when Slack described nobody and no member stands behind the
    author, so an unreadable author leaves the issue without a requester rather
    than with an empty one. A linked member needs no name, since they are shown
    as that member.
    """
    user = profile.get("user") or {}
    if not isinstance(user, Mapping) or not slack_user_id:
        return None
    details = user.get("profile") or {}
    details = details if isinstance(details, Mapping) else {}
    real = _clean(details.get("real_name")) or _clean(user.get("real_name"))
    handle = _clean(details.get("display_name")) or _clean(user.get("name"))
    if not real and not handle and user_id is None:
        return None
    avatar = next(
        (
            str(details.get(field))
            for field in _AVATAR_FIELDS
            if str(details.get(field) or "").startswith("https://") and len(str(details.get(field))) <= AVATAR_MAX
        ),
        None,
    )
    return IssueRequester(
        source=SLACK,
        name=real or handle,
        handle=handle or None,
        avatar_url=avatar,
        external_id=slack_user_id,
        user_id=user_id,
    )
