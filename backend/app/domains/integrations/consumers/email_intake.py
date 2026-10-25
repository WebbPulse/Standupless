"""The create by email consumer: files one issue per inbound intake mail.

SES stores each mail in the intake bucket and S3 queues the object's key, so a
record names a bucket and key and nothing a sender wrote. The mail is read,
checked and either filed or dropped, and the object is deleted once it is done
with either way; only an unexpected failure leaves it, and the message, for a
retry. Nothing is ever sent back to an intake sender, whatever happens.

A mail to a `reply-<token>` address is a reply to a notification email rather
than intake, and is handed to `app.domains.integrations.email_replies`, which
posts it as a comment.

A mail is dropped when SES's verdicts fail it, when no live address it was sent
to resolves, when it replies to a mail already filed, when its address has
passed its hourly ceiling, or when its Message-ID was already filed.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import replace
from typing import Any, Mapping, Optional
from urllib.parse import unquote_plus

from fastapi import APIRouter, HTTPException
from webbpulse.events import register_stream_consumer
from webbpulse.ratelimit import RateLimiter

from app.common.api.dependencies.repositories import Repositories, build_bundle
from app.common.api.schemas.issues import IssueCreate
from app.common.change_source import EMAIL
from app.common.core.config import settings
from app.common.core.constants import ISSUE_BODY_MAX_BYTES
from app.common.db.dynamo.attachments import build_attachment, new_upload_id, object_key, stored_bytes
from app.common.db.dynamo.email_intake import EmailIntake
from app.common.db.dynamo.issues import Issue
from app.common.email_replies import reply_tokens
from app.common.issue_rules import triage_on
from app.common.issue_writes import create_issue
from app.common.plan_limits import storage_limit_of
from app.common.recurring_issues import creator_context
from app.common.upload_rules import ATTACHMENT_CONTENT_TYPES, normalized_content_type, upload_ceiling
from app.domains.integrations.email_intake import intake_domain
from app.domains.integrations.email_replies import handle_reply
from app.domains.integrations.intake_mail import (
    IntakeFile,
    IntakeMail,
    intake_tokens,
    masked_sender,
    message_key,
    parse_mail,
    title_of,
)

_log = logging.getLogger(__name__)

EMAIL_REPOSITORIES: tuple[str, ...] = (
    "issues",
    "counters",
    "activity",
    "team_config",
    "subscriptions",
    "planning",
    "attachments",
    "idempotency",
    "inbox",
    "comments",
    "relations",
)
"""What filing a mail writes: the issue and everything an issue create touches, its files and the claims."""

EMAIL_READ_REPOSITORIES: tuple[str, ...] = ("workspaces", "memberships", "users", "teams", "github")
"""What filing a mail only reads: the address, the team, the admin it files as and the plan."""

INTAKE_SCOPE = "email-intake"

MESSAGE_TTL_SECONDS = 90 * 24 * 60 * 60
"""How long a filed Message-ID is remembered, for redeliveries and for the replies to it that are dropped."""

HOURLY_CEILING = 300
"""Mail one address files in an hour before more is dropped, far above any real team's intake."""

FILES_MAX = 20
"""The most files one mail attaches; the rest are skipped."""

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


def _objects(record: Mapping[str, Any]) -> list[tuple[str, str]]:
    """The intake bucket objects one SQS record names, skipping anything for another bucket."""
    raw = record.get("body")
    if not isinstance(raw, str):
        return []
    try:
        event = json.loads(raw)
    except ValueError:
        _log.warning("An intake record would not parse.", extra={"event": "email_intake.unparseable"})
        return []
    rows = event.get("Records") if isinstance(event, Mapping) else None
    found: list[tuple[str, str]] = []
    for row in rows if isinstance(rows, list) else []:
        s3 = row.get("s3") if isinstance(row, Mapping) else None
        bucket = str((s3 or {}).get("bucket", {}).get("name", "")) if isinstance(s3, Mapping) else ""
        key = str((s3 or {}).get("object", {}).get("key", "")) if isinstance(s3, Mapping) else ""
        if bucket and key and bucket == settings.EMAIL_INTAKE_BUCKET.strip():
            found.append((bucket, unquote_plus(key)))
    return found


def _s3() -> Any:
    """An S3 client in the configured region."""
    import boto3

    return boto3.client("s3", region_name=settings.AWS_REGION or None)


def handle_record(repositories: Repositories, record: Mapping[str, Any], *, s3: Any = None) -> None:
    """File the mail each object in one record holds, then delete the object."""
    from botocore.exceptions import ClientError

    client = s3 if s3 is not None else _s3()
    for bucket, key in _objects(record):
        try:
            raw = client.get_object(Bucket=bucket, Key=key)["Body"].read()
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"NoSuchKey", "404"}:
                continue
            raise
        handle_mail(repositories, bytes(raw), s3=client)
        client.delete_object(Bucket=bucket, Key=key)


def _dropped(reason: str) -> None:
    """Log one dropped mail by reason alone, never by who sent it."""
    _log.info("An intake mail was dropped.", extra={"event": "email_intake.dropped", "reason": reason})


def handle_mail(repositories: Repositories, raw: bytes, *, s3: Any = None) -> Optional[Issue]:
    """File one raw mail as an issue, answering it, or `None` when the mail is dropped or was a reply.

    A reply to a notification email is posted as a comment and answers `None`,
    since it filed no issue.
    """
    mail = parse_mail(raw)
    if mail.rejected:
        _dropped(mail.rejected)
        return None
    replies = reply_tokens(mail.recipients, intake_domain())
    if replies:
        handle_reply(repositories, mail, replies[0])
        return None
    for _key, token in intake_tokens(mail.recipients, intake_domain()):
        intake = repositories.github.email_intake.resolve(token)
        if intake is not None:
            return _file(repositories, intake, mail, s3=s3)
    _dropped("unknown_address")
    return None


def _allowed(token: str) -> bool:
    """Whether one address is still under its hourly ceiling."""
    identity = message_key(token)
    return RateLimiter(namespace=INTAKE_SCOPE).check(identity, limit=HOURLY_CEILING, window_seconds=3600).allowed


def _file(repositories: Repositories, intake: EmailIntake, mail: IntakeMail, *, s3: Any = None) -> Optional[Issue]:
    """File one accepted mail through one address, at most once per Message-ID."""
    workspace_id = intake.workspace_id
    claims = repositories.idempotency
    if any(claims.held(workspace_id, INTAKE_SCOPE, message_key(ref)) for ref in mail.references):
        _dropped("reply")
        return None
    if not _allowed(intake.token):
        _dropped("rate_limited")
        return None
    if not claims.claim(workspace_id, INTAKE_SCOPE, message_key(mail.message_id), ttl_seconds=MESSAGE_TTL_SECONDS):
        _dropped("duplicate")
        return None
    try:
        issue = _create(repositories, intake, mail)
    except HTTPException as exc:
        _log.info(
            "An intake mail could not be filed.",
            extra={"event": "email_intake.refused", "status_code": exc.status_code},
        )
        return None
    except Exception:
        claims.release(workspace_id, INTAKE_SCOPE, message_key(mail.message_id))
        raise
    if issue is not None:
        _attach(repositories, issue, intake.enabled_by, mail.files, s3=s3)
        _log.info("An intake mail was filed.", extra={"event": "email_intake.filed", "issue_id": issue.issue_id})
    return issue


def _body(mail: IntakeMail) -> str:
    """The issue description: who sent it, masked, then the new text of the mail, within the body cap."""
    lead = f"Sent by email by {masked_sender(mail.sender_name, mail.sender_address)}."
    text = f"{lead}\n\n{mail.body}" if mail.body else lead
    encoded = text.encode("utf-8")
    if len(encoded) <= ISSUE_BODY_MAX_BYTES:
        return text
    return encoded[: ISSUE_BODY_MAX_BYTES - 16].decode("utf-8", errors="ignore").rstrip() + "\n\n…"


def _create(repositories: Repositories, intake: EmailIntake, mail: IntakeMail) -> Optional[Issue]:
    """Create the issue as the admin who turned the address on, attributed to email."""
    workspace_id = intake.workspace_id
    context = creator_context(repositories, workspace_id, intake.enabled_by)
    if context is None:
        _dropped("creator_gone")
        return None
    payload = IssueCreate(
        team_id=intake.team_id,
        title=title_of(mail.subject),
        template_id=intake.template_id,
        body=_body(mail),
        triage=triage_on(repositories, workspace_id, intake.team_id),
    )
    return create_issue(repositories, replace(context, source=EMAIL), payload, origin_ref=mail.message_id)


def safe_filename(name: str, index: int) -> str:
    """A filename safe in an object key, keeping its extension, or a numbered one when nothing is left."""
    clean = _UNSAFE.sub("_", name.strip()).strip("._")[:120]
    return clean or f"attachment-{index}"


def _attach(
    repositories: Repositories, issue: Issue, uploaded_by: str, files: tuple[IntakeFile, ...], *, s3: Any
) -> None:
    """Store each allowed file on the issue within the upload limits and the plan's storage, skipping the rest."""
    bucket = settings.ATTACHMENTS_BUCKET.strip()
    if not bucket or not files:
        return
    workspace_id = issue.workspace_id
    limit = storage_limit_of(repositories.workspaces.get(workspace_id))
    client = s3 if s3 is not None else _s3()
    for index, file in enumerate(files[:FILES_MAX], start=1):
        content_type = normalized_content_type(file.content_type)
        size = len(file.data)
        if content_type not in ATTACHMENT_CONTENT_TYPES or size > upload_ceiling(content_type):
            _dropped("attachment_refused")
            continue
        filename = safe_filename(file.filename, index)
        key = object_key(workspace_id, issue.issue_id, new_upload_id(), filename)
        attachment = build_attachment(
            workspace_id,
            issue.issue_id,
            issue.team_id,
            "file",
            filename,
            uploaded_by,
            s3_key=key,
            content_type=content_type,
            size_bytes=size,
        )
        reserved = stored_bytes([attachment])
        if not repositories.attachments.reserve_storage(workspace_id, reserved, limit):
            _dropped("storage_full")
            return
        try:
            client.put_object(Bucket=bucket, Key=key, Body=file.data, ContentType=content_type)
            repositories.attachments.create(attachment)
        except Exception:
            repositories.attachments.add_storage(workspace_id, -reserved)
            _log.warning("An intake attachment could not be stored.", extra={"event": "email_intake.attachment_failed"})


def build_router(repositories: Repositories | None = None) -> APIRouter:
    """The intake consumer's router, mounted at the root with no API prefix."""
    bundle = (
        repositories
        if repositories is not None
        else build_bundle(
            (*EMAIL_REPOSITORIES, *EMAIL_READ_REPOSITORIES),
            name="integrations-email",
            read_only=EMAIL_READ_REPOSITORIES,
        )
    )
    router = APIRouter()

    def consume(record: Mapping[str, Any]) -> None:
        """Handle one record against the intake's bundle."""
        handle_record(bundle, record)

    register_stream_consumer(router, consume, log_event="email_intake.batch")
    return router
