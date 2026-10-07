"""Snapshot tests for every email Standupless sends, in HTML and plain text.

Each template is rendered with fixed inputs against a fixed frontend origin and
compared byte for byte with the files in `email_snapshots/`. A deliberate change
to a template or to the shared shell is accepted by rerunning with
`UPDATE_EMAIL_SNAPSHOTS=1` and reviewing the diff. The same renders are what the
preview HTML files are made from, so what a reviewer sees is what is mailed.
"""

from __future__ import annotations

import functools
import os
import pathlib
from collections.abc import Callable, Iterator
from datetime import datetime, timezone

import pytest
from webbpulse.identity import IdentitySettings
from webbpulse.identity.email import (
    EmailMessage,
    render_password_changed,
    render_password_reset,
    render_registration_notice,
    render_verification,
)

from app.common.core.config import settings
from app.common.db.dynamo.notify_digests import DigestEntry
from app.common.email.brand import BRAND_ACCENT, logo_url
from app.domains.identity.email import render_account_deletion
from app.domains.identity.package_glue import build_identity_settings
from app.domains.views.email import render_digest, render_notification, render_project_update_notification
from app.common.email.invite import render_invite
from app.domains.workspaces.email import render_workspace_deletion

SNAPSHOTS = pathlib.Path(__file__).parent / "email_snapshots"
ORIGIN = "https://standupless.example"
TO = "member@example.com"
WHEN = datetime(2026, 10, 7, 9, 30, tzinfo=timezone.utc)
IDENTITY_ENVIRONMENT = {
    "IDENTITY_ISSUER": "http://api.test",
    "IDENTITY_AUDIENCE": "standupless",
    "IDENTITY_ENVIRONMENT": "test",
    "IDENTITY_SIGNER": "local",
    "IDENTITY_SIGNING_KEY_ARNS": '["arn:aws:kms:us-west-2:000000000000:key/test-signing-key"]',
}
"""The minimum the identity function's settings need to build outside Lambda."""
NOTIFICATION_KINDS = ("assigned", "commented", "mentioned", "mentioned_in_description", "status_changed")


def _entry(index: int, **fields: object) -> DigestEntry:
    """One digest entry with stable ids and times."""
    values: dict[str, object] = {
        "workspace_id": "w1",
        "recipient_id": "u1",
        "notification_id": f"n{index:02d}",
        "kind": "commented",
        "team_id": "t1",
        "actor_name": "Ada Lovelace",
        "issue_id": "i1",
        "issue_key": "ENG-12",
        "issue_title": "Fix the login redirect",
        "created_at": WHEN.replace(minute=index),
    }
    values.update(fields)
    return DigestEntry.model_validate(values)


def _identity_settings() -> IdentitySettings:
    """The product's identity settings, pinned to the snapshot origin."""
    return build_identity_settings(settings).model_copy(
        update={
            "product_name": "Standupless",
            "frontend_base_url": ORIGIN,
            "logo_url": f"{ORIGIN}/email-logo.png",
            "support_email": "support@standupless.example",
        }
    )


def _cases() -> dict[str, Callable[[], EmailMessage]]:
    """Every template, by snapshot name."""
    link = f"{ORIGIN}/auth/link?token=abc123"
    cases: dict[str, Callable[[], EmailMessage]] = {
        "identity_verification": lambda: render_verification(
            _identity_settings(), to=TO, link=link, expiry="24 hours"
        ),
        "identity_password_reset": lambda: render_password_reset(
            _identity_settings(), to=TO, link=link, expiry="1 hour"
        ),
        "identity_registration_notice": lambda: render_registration_notice(
            _identity_settings(), to=TO, link=link
        ),
        "identity_password_changed": lambda: render_password_changed(
            _identity_settings(), to=TO, link=link
        ),
        "workspace_invite": lambda: render_invite(
            to=TO,
            token="tok_123",
            workspace_name="Acme",
            role="member",
            inviter_name="Olive Owner",
            expires_at=WHEN,
        ),
        "workspace_deletion_scheduled": lambda: render_workspace_deletion(
            to=TO, workspace_name="Acme", slug="acme", actor_name="Olive Owner", purge_after=WHEN
        ),
        "workspace_deletion_cancelled": lambda: render_workspace_deletion(
            to=TO, workspace_name="Acme", slug="acme", actor_name="Olive Owner", purge_after=None, cancelled=True
        ),
        "account_deleted": lambda: render_account_deletion(to=TO, workspaces_deleted=["Side project"]),
        "notification_project_update": lambda: render_project_update_notification(
            to=TO,
            actor_name="Ada Lovelace",
            project_id="p1",
            project_name="Launch",
            health="at_risk",
            workspace_slug="acme",
            body="Payments slipped a week.",
        ),
        "notification_digest": lambda: render_digest(
            [
                _entry(1),
                _entry(2, kind="assigned", excerpt=""),
                _entry(3, issue_id="i2", issue_key="ENG-14", issue_title="Speed up search", excerpt="Indexed it."),
                _entry(4, kind="project_update", project_id="p1", project_name="Launch", health="on_track"),
            ],
            to=TO,
            workspace_slug="acme",
        ),
        "notification_digest_workspace_accent": lambda: render_digest(
            [_entry(1), _entry(2, kind="assigned", excerpt="")],
            to=TO,
            workspace_slug="acme",
            accent="#3b82f6",
        ),
    }
    for kind in NOTIFICATION_KINDS:
        cases[f"notification_{kind}"] = functools.partial(
            render_notification,
            kind=kind,
            to=TO,
            actor_name="Ada Lovelace",
            issue_key="ENG-12",
            issue_title="Fix the login redirect",
            workspace_slug="acme",
            comment_excerpt="" if kind in {"assigned", "status_changed"} else "The redirect drops the next parameter.",
        )
    return cases


@pytest.fixture(autouse=True)
def _fixed_origin(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Pin the frontend origin, so the snapshots do not depend on the environment."""
    monkeypatch.setattr(settings, "FRONTEND_URL", ORIGIN)
    for key, value in IDENTITY_ENVIRONMENT.items():
        monkeypatch.setenv(key, value)
    yield


@pytest.mark.parametrize("name", sorted(_cases()))
@pytest.mark.parametrize("part", ["html", "txt"])
def test_email_matches_its_snapshot(name: str, part: str) -> None:
    """Each template renders exactly its reviewed snapshot."""
    message = _cases()[name]()
    rendered = message.html if part == "html" else message.text
    path = SNAPSHOTS / f"{name}.{part}"
    if os.environ.get("UPDATE_EMAIL_SNAPSHOTS") == "1":
        path.write_text(rendered, encoding="utf-8")
    assert path.exists(), f"No snapshot at {path}; rerun with UPDATE_EMAIL_SNAPSHOTS=1."
    assert rendered == path.read_text(encoding="utf-8")


@pytest.mark.parametrize("name", sorted(_cases()))
def test_every_email_is_branded_and_follows_house_style(name: str) -> None:
    """The logo is the hosted PNG, the copy has no em dash and never says developer."""
    message = _cases()[name]()
    assert f'src="{ORIGIN}/email-logo.png"' in message.html
    for part in (message.subject, message.text, message.html):
        assert "—" not in part
        assert "developer" not in part.lower()


def test_brand_orange_is_the_default_and_a_workspace_accent_replaces_it() -> None:
    """Product emails use the brand orange unless a workspace accent is passed."""
    assert f'bgcolor="{BRAND_ACCENT}"' in _cases()["notification_digest"]().html
    themed = _cases()["notification_digest_workspace_accent"]().html
    assert 'bgcolor="#3b82f6"' in themed
    assert f'bgcolor="{BRAND_ACCENT}"' not in themed


def test_an_unusable_workspace_accent_falls_back_to_brand_orange() -> None:
    """A stored colour that is not a colour still mails, in the brand orange."""
    message = render_digest([_entry(1), _entry(2)], to=TO, workspace_slug="acme", accent="orange")
    assert f'bgcolor="{BRAND_ACCENT}"' in message.html


def test_the_identity_emails_carry_the_product_logo_and_accent() -> None:
    """The package's own emails are configured with the same logo and brand orange."""
    identity = build_identity_settings(settings)
    assert identity.logo_url == logo_url()
    assert identity.email_accent_color == BRAND_ACCENT
    assert logo_url() == f"{ORIGIN}/email-logo.png"
