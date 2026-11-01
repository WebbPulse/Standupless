"""The Apple sender against a fake transport: what it sends and what Apple's answers mean.

Reaching a real device needs a signed app, so these stop at the request. The
properties held are that a finished token is reported, a dead connection is retried
once and then pauses sending, and a bad credential turns push off rather than raising.
"""

from __future__ import annotations

import base64
import json
from typing import Any, Callable

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from app.common import push_senders
from app.common.push_senders import (
    ApnsSender,
    PushAlert,
    PushMessage,
    PushOutcome,
    load_apns_private_key,
)

TOKEN = "ab" * 32
KEY = ec.generate_private_key(ec.SECP256R1())
ALERT = PushAlert(
    title="ABC-1 An issue", body="Assigned", path="/w/acme/issues/ABC-1", collapse_id="n1", thread_id="i1"
)


def _pem() -> str:
    """The test key as a `.p8` PEM."""
    return KEY.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()


def _sender(handler: Callable[[httpx.Request], httpx.Response]) -> ApnsSender:
    """A sender whose requests go to `handler` instead of Apple."""
    return ApnsSender(
        key=KEY,
        key_id="KEYID12345",
        team_id="TEAM123456",
        topic="dev.standupless.app",
        host="https://apns.test",
        transport=httpx.MockTransport(handler),
    )


def test_an_alert_carries_the_badge_the_text_and_the_path() -> None:
    """A send addresses the token and topic, signs with the key, and carries where a tap goes."""
    seen: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        """Record the request and accept it."""
        seen.append(request)
        return httpx.Response(200)

    assert _sender(answer).send(TOKEN, PushMessage(badge=3, alert=ALERT)) is PushOutcome.SENT

    [request] = seen
    assert request.url.path == f"/3/device/{TOKEN}"
    assert request.headers["apns-topic"] == "dev.standupless.app"
    assert request.headers["apns-push-type"] == "alert"
    assert request.headers["apns-priority"] == "10"
    assert len(request.headers["apns-collapse-id"]) <= 64
    body: dict[str, Any] = json.loads(request.content)
    assert body["aps"]["badge"] == 3
    assert body["aps"]["alert"] == {"title": ALERT.title, "body": ALERT.body}
    assert body["path"] == ALERT.path
    bearer = request.headers["authorization"].removeprefix("bearer ")
    assert jwt.get_unverified_header(bearer)["kid"] == "KEYID12345"
    claims = jwt.decode(bearer, KEY.public_key(), algorithms=["ES256"])
    assert claims["iss"] == "TEAM123456"


def test_a_badge_alone_shows_nothing_and_goes_at_low_priority() -> None:
    """Moving the badge carries no alert, and Apple requires the lower priority for it."""
    seen: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        """Record the request and accept it."""
        seen.append(request)
        return httpx.Response(200)

    assert _sender(answer).send(TOKEN, PushMessage(badge=0)) is PushOutcome.SENT
    [request] = seen
    assert request.headers["apns-priority"] == "5"
    assert json.loads(request.content) == {"aps": {"badge": 0}}


@pytest.mark.parametrize(
    ("status", "reason"),
    [(410, "Unregistered"), (400, "BadDeviceToken"), (400, "DeviceTokenNotForTopic")],
)
def test_a_finished_token_is_reported(status: int, reason: str) -> None:
    """The answers meaning a token will never work again report it gone, so the device is removed."""
    sender = _sender(lambda _: httpx.Response(status, json={"reason": reason}))
    assert sender.send(TOKEN, PushMessage(badge=1)) is PushOutcome.GONE


def test_other_refusals_keep_the_device() -> None:
    """A throttle or a provider error says nothing about the token, so the device stays."""
    sender = _sender(lambda _: httpx.Response(429, json={"reason": "TooManyRequests"}))
    assert sender.send(TOKEN, PushMessage(badge=1)) is PushOutcome.FAILED


def test_a_refused_provider_token_is_minted_again() -> None:
    """Apple refusing an expired provider token means the next send signs a new one."""
    bearers: list[str] = []

    def answer(request: httpx.Request) -> httpx.Response:
        """Record the bearer and refuse it the first time."""
        bearers.append(request.headers["authorization"])
        return (
            httpx.Response(403, json={"reason": "ExpiredProviderToken"}) if len(bearers) == 1 else httpx.Response(200)
        )

    sender = _sender(answer)
    assert sender.send(TOKEN, PushMessage(badge=1)) is PushOutcome.FAILED
    sender._provider_token_at -= 1
    assert sender.send(TOKEN, PushMessage(badge=1)) is PushOutcome.SENT
    assert len(bearers) == 2


def test_a_dead_connection_is_retried_once() -> None:
    """A connection that died while the function was frozen costs one retry, not the send."""
    calls: list[int] = []

    def answer(_: httpx.Request) -> httpx.Response:
        """Fail the first attempt only."""
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ReadError("gone")
        return httpx.Response(200)

    assert _sender(answer).send(TOKEN, PushMessage(badge=1)) is PushOutcome.SENT
    assert len(calls) == 2


def test_an_outage_pauses_sending_and_logs_no_token(caplog: pytest.LogCaptureFixture) -> None:
    """Two failures in a row stop further attempts for a while, and nothing logged names the token."""
    calls: list[int] = []

    def answer(request: httpx.Request) -> httpx.Response:
        """Fail every attempt, with the URL in the error as httpx would have it."""
        calls.append(1)
        raise httpx.ConnectError(f"cannot reach {request.url}")

    sender = _sender(answer)
    with caplog.at_level("INFO"):
        assert sender.send(TOKEN, PushMessage(badge=1)) is PushOutcome.FAILED
        assert sender.send(TOKEN, PushMessage(badge=1)) is PushOutcome.FAILED
    assert len(calls) == 2
    assert TOKEN not in caplog.text


@pytest.mark.parametrize(
    "encode",
    [
        lambda pem: pem,
        lambda pem: pem.replace("\n", "\\n"),
        lambda pem: base64.b64encode(pem.encode()).decode(),
        lambda _: base64.b64encode(
            KEY.private_bytes(
                serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
            )
        ).decode(),
    ],
)
def test_the_key_loads_however_it_was_stored(encode: Callable[[str], str]) -> None:
    """How the key was stored has not been read back, so each likely form works."""
    assert load_apns_private_key(encode(_pem())) is not None


@pytest.mark.parametrize(
    "raw", ["", "   ", "not a key", "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----"]
)
def test_an_unusable_key_is_refused_quietly(raw: str) -> None:
    """A key that does not parse answers `None` rather than raising."""
    assert load_apns_private_key(raw) is None


def test_missing_or_malformed_credentials_turn_push_off(monkeypatch: pytest.MonkeyPatch) -> None:
    """No credentials, partial credentials or a bad key leave the platform with no sender."""
    for key, key_id, team_id in [("", "", ""), (_pem(), "", "TEAM"), ("not a key", "KEY", "TEAM")]:
        monkeypatch.setattr(
            push_senders,
            "settings",
            type("Fake", (), {"apns_key": key, "apns_key_id": key_id, "apns_team_id": team_id}),
        )
        push_senders.sender_for.cache_clear()
        assert push_senders.sender_for("ios") is None
    push_senders.sender_for.cache_clear()


def test_a_platform_with_no_sender_answers_none() -> None:
    """Android has no sender yet, so its devices could only ever do nothing."""
    assert push_senders.sender_for("android") is None
