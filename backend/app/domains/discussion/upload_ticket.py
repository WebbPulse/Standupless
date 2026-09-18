"""The upload ticket the presign route mints and the commit route verifies.

The three-call upload needs the second call to prove that the third one is naming
an upload it actually minted, for this caller, on this issue. A signed token does
that with no table and no read: the claims carry everything the commit needs, the
signature is what makes them unforgeable, and `exp` is what makes an abandoned
ticket stop working on its own rather than needing a sweep.

A row would have been the other option and is strictly worse here. It would add a
fourth table, a write on a call that stores nothing by design, and a second thing
for the lifecycle rule to reconcile against the orphaned object.

The ticket is not a credential for the bucket. The presigned PUT is, and it is
already bounded by key, type and size. The ticket only says which key was signed.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Mapping

from webbpulse.security import ExpiredToken, InvalidToken, create_token, decode_token

from app.common.core.config import settings

TICKET_AUDIENCE = "standupless.attachment-upload"
"""What this token may be presented for.

Pinned so a token signed elsewhere under the same `SECRET_KEY` cannot be replayed
as an upload ticket, and an upload ticket cannot be replayed as anything else.
"""

TICKET_TTL_SECONDS = 3600
"""How long a ticket stays committable.

Matches the presigned PUT's own window, so the ticket and the URL it describes
expire together and a commit can never name a key whose upload URL is already
dead.
"""


class TicketError(Exception):
    """A ticket that did not verify, whatever the reason.

    One exception for expired, malformed, wrongly signed and wrong audience alike,
    because the route answers all four with the same 404 and a caller must not be
    able to tell them apart.
    """


def mint_ticket(
    workspace_id: str,
    issue_id: str,
    user_id: str,
    upload_id: str,
    key: str,
    filename: str,
    content_type: str,
    size_bytes: int,
) -> str:
    """Sign one upload ticket describing exactly what was presigned.

    Every field the commit route needs is in here rather than re-derived, so the
    commit cannot record a content type or a size different from the one S3 was
    told to enforce.
    """
    return create_token(
        {
            "workspace_id": workspace_id,
            "issue_id": issue_id,
            "user_id": user_id,
            "upload_id": upload_id,
            "key": key,
            "filename": filename,
            "content_type": content_type,
            "size_bytes": size_bytes,
        },
        settings.SECRET_KEY,
        expires_in=timedelta(seconds=TICKET_TTL_SECONDS),
        audience=TICKET_AUDIENCE,
    )


def read_ticket(ticket: str, workspace_id: str, issue_id: str, user_id: str) -> Mapping[str, Any]:
    """The claims of a ticket this caller minted for this issue, or `TicketError`.

    The three bindings are checked here rather than by the route, so there is one
    place that decides a ticket belongs to the request presenting it. A ticket
    minted for another workspace, another issue or another member is refused even
    though its signature is good, which is what stops a ticket from being passed
    around to attach an object somewhere it was never authorised for.
    """
    try:
        claims = decode_token(
            ticket,
            settings.SECRET_KEY,
            audience=TICKET_AUDIENCE,
            require=["exp", "upload_id", "key"],
        )
    except (ExpiredToken, InvalidToken) as exc:
        raise TicketError("The upload ticket is not valid") from exc

    if claims.get("workspace_id") != workspace_id:
        raise TicketError("The upload ticket is for another workspace")
    if claims.get("issue_id") != issue_id:
        raise TicketError("The upload ticket is for another issue")
    if claims.get("user_id") != user_id:
        raise TicketError("The upload ticket belongs to another member")
    return claims
