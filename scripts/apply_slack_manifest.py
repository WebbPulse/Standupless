"""Apply a committed Slack app manifest to the live Slack App through the manifest API.

Validates the environment's manifest with ``apps.manifest.validate``, writes it with
``apps.manifest.update`` and reads it back with ``apps.manifest.export``, then prints
the bot scopes and bot events that differ between the committed file and the live
App. ``--dry-run`` validates and diffs against the live App without writing. The
script refuses an App whose name does not match the manifest.

The App configuration token comes from one of two places, and no token is ever
printed or logged:

1. ``SLACK_CONFIG_TOKEN``, a 12-hour access token, when it is set. Pass it through
   ``asm-exec`` with a secret reference so the value never enters a shell.
2. Otherwise the refresh token stored as ``SLACK_CONFIG_REFRESH_TOKEN`` in the
   ``standupless-production/app`` secret, the only copy for both environments. The
   script reads it, calls ``tooling.tokens.rotate``, and merges the new refresh token
   back into that one key, re-checking the secret version and retrying on a
   concurrent change (``webbpulse.ops.config.SecretStore`` when the webbpulse package
   is importable, the same pattern with boto3 otherwise). Slack refresh tokens work
   once, so the write must succeed before anything is applied; when it fails the
   script exits 4 without touching the App. The access token stays in memory.

The refresh path needs boto3, so run it from the backend environment on the
production AdministratorAccess profile, from the ``backend`` directory::

    AWS_PROFILE=Standupless-Production/AdministratorAccess \\
        uv run --no-sync python ../scripts/apply_slack_manifest.py staging --app-id A0123456789

``--secret-id`` and ``--region`` override ``standupless-production/app`` and
``us-west-2``. The access token path uses only the standard library::

    SLACK_CONFIG_TOKEN='{{resolve:secretsmanager:standupless-staging/app:SecretString:SLACK_CONFIG_TOKEN}}' \\
        asm-exec python3 scripts/apply_slack_manifest.py staging --app-id A0123456789

Exit codes: 0 applied and in sync, 1 a Slack call failed, 2 bad input or no token,
3 the live App still differs, 4 the rotated refresh token could not be stored.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
import uuid
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

SLACK_API = "https://slack.com/api/"
MANIFESTS = {
    "staging": "manifest.staging.json",
    "production": "manifest.production.json",
}
ACCESS_TOKEN_ENV = "SLACK_CONFIG_TOKEN"
REFRESH_TOKEN_KEY = "SLACK_CONFIG_REFRESH_TOKEN"
DEFAULT_SECRET_ID = "standupless-production/app"
DEFAULT_REGION = "us-west-2"
WRITE_RETRIES = 3


class SlackApiError(RuntimeError):
    """A Slack Web API call that answered ``ok: false``."""


class TokenError(RuntimeError):
    """No usable configuration token could be found or the stored refresh token is unusable."""


class WriteBackError(RuntimeError):
    """The rotated refresh token could not be stored, so nothing may be applied."""


def call(method: str, token: str | None, **params: str) -> dict[str, Any]:
    """Call one Slack Web API method with a form body and return its JSON answer."""
    body = urllib.parse.urlencode(params).encode()
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(SLACK_API + method, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=30) as response:
        answer: dict[str, Any] = json.load(response)
    if not answer.get("ok"):
        details = answer.get("errors") or answer.get("response_metadata") or ""
        raise SlackApiError(f"{method}: {answer.get('error')} {json.dumps(details)}")
    return answer


class RefreshTokenSecret:
    """Reads and writes the one refresh token key of a Secrets Manager JSON secret."""

    def __init__(self, client: Any, secret_id: str, key: str = REFRESH_TOKEN_KEY) -> None:
        """Bind a Secrets Manager client to one secret id and key."""
        self._client = client
        self.secret_id = secret_id
        self.key = key

    def _current_version(self) -> str | None:
        """Return the version id staged AWSCURRENT, or ``None`` when the secret has no value."""
        described = self._client.describe_secret(SecretId=self.secret_id)
        for version_id, stages in described.get("VersionIdsToStages", {}).items():
            if "AWSCURRENT" in stages:
                return str(version_id)
        return None

    def _read_object(self) -> tuple[str | None, dict[str, Any]]:
        """Return the current version id and its decoded JSON object, pinned to that version."""
        version = self._current_version()
        if version is None:
            return None, {}
        raw = self._client.get_secret_value(SecretId=self.secret_id, VersionId=version).get("SecretString")
        try:
            decoded = json.loads(raw) if raw is not None else None
        except ValueError:
            decoded = None
        if not isinstance(decoded, dict):
            raise TokenError(f"secret {self.secret_id} does not hold a JSON object")
        return version, decoded

    def read(self) -> str:
        """Return the stored refresh token, raising ``TokenError`` when it is absent or empty."""
        value = self._read_object()[1].get(self.key)
        if not isinstance(value, str) or not value:
            raise TokenError(f"{self.key} is not set in secret {self.secret_id}")
        return value

    def write(self, value: str) -> None:
        """Merge the new refresh token into its key, keeping every other key."""
        try:
            from webbpulse.ops.config import SecretStore
        except ImportError:
            self._merge(value)
            return
        SecretStore(self._client, self.secret_id, retries=WRITE_RETRIES).set(self.key, value)

    def _merge(self, value: str) -> None:
        """Read, set the key, re-check the version and write, retrying on a concurrent change."""
        for _ in range(WRITE_RETRIES + 1):
            version, current = self._read_object()
            if current.get(self.key) == value:
                return
            if self._current_version() != version:
                continue
            current[self.key] = value
            self._client.put_secret_value(
                SecretId=self.secret_id,
                SecretString=json.dumps(current, sort_keys=True),
                ClientRequestToken=str(uuid.uuid4()),
            )
            return
        raise WriteBackError(f"secret {self.secret_id} changed between read and write on every attempt")


def rotate_config_token(
    secret: RefreshTokenSecret,
    rotate: Callable[[str], dict[str, Any]] | None = None,
) -> str:
    """Rotate the stored refresh token, store the new one, and return the access token.

    Raises ``WriteBackError`` when the new refresh token cannot be stored; the access
    token is then withheld so nothing is applied with a token whose successor is lost.
    """
    rotate = rotate or (lambda refresh: call("tooling.tokens.rotate", None, refresh_token=refresh))
    answer = rotate(secret.read())
    access, refresh = answer.get("token"), answer.get("refresh_token")
    if not isinstance(access, str) or not access or not isinstance(refresh, str) or not refresh:
        raise TokenError("tooling.tokens.rotate answered without a token and refresh token")
    try:
        secret.write(refresh)
    except Exception as error:
        raise WriteBackError(
            f"could not store the rotated {secret.key} in secret {secret.secret_id} "
            f"({type(error).__name__}: {error}); the old refresh token is spent, so mint a new "
            "App configuration token and store its refresh token before running again"
        ) from None
    return access


def open_secret(secret_id: str, region: str) -> RefreshTokenSecret:
    """Open the refresh token secret with boto3 on the ambient AWS profile."""
    try:
        import boto3
    except ImportError:
        raise TokenError(
            "the refresh token path needs boto3; run from the backend environment, or set SLACK_CONFIG_TOKEN"
        ) from None
    return RefreshTokenSecret(boto3.client("secretsmanager", region_name=region), secret_id)


def resolve_token(
    environ: Mapping[str, str],
    open_store: Callable[[], RefreshTokenSecret],
    rotate: Callable[[str], dict[str, Any]] | None = None,
) -> str:
    """Return ``SLACK_CONFIG_TOKEN`` when set, otherwise an access token from a stored refresh token."""
    token = environ.get(ACCESS_TOKEN_ENV, "")
    if token.startswith("{{resolve:"):
        raise TokenError(f"{ACCESS_TOKEN_ENV} is an unresolved reference; run through asm-exec")
    if token:
        return token
    return rotate_config_token(open_store(), rotate)


def scopes_and_events(manifest: dict[str, Any]) -> tuple[set[str], set[str]]:
    """Return the bot scopes and bot events a manifest declares."""
    scopes = manifest.get("oauth_config", {}).get("scopes", {}).get("bot", [])
    events = manifest.get("settings", {}).get("event_subscriptions", {}).get("bot_events", [])
    return set(scopes), set(events)


def diff(label: str, wanted: set[str], live: set[str]) -> bool:
    """Print what the live App lacks and carries beyond the manifest; return True when equal."""
    missing = sorted(wanted - live)
    extra = sorted(live - wanted)
    print(f"{label}: missing {missing or 'none'}, extra {extra or 'none'}")
    return not missing and not extra


def main() -> int:
    """Parse arguments, apply the manifest unless dry run, and report the live diff."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("environment", choices=sorted(MANIFESTS))
    parser.add_argument("--app-id", required=True, help="The App ID from Basic Information")
    parser.add_argument("--dry-run", action="store_true", help="Validate and diff only")
    parser.add_argument("--secret-id", default=DEFAULT_SECRET_ID, help="The secret holding the refresh token")
    parser.add_argument("--region", default=DEFAULT_REGION, help="The secret's AWS region")
    args = parser.parse_args()

    path = Path(__file__).resolve().parent.parent / "slack" / MANIFESTS[args.environment]
    manifest = json.loads(path.read_text())
    if manifest.get("display_information", {}).get("name", "").endswith("Staging") != (
        args.environment == "staging"
    ):
        print(f"{path.name} does not match environment {args.environment}", file=sys.stderr)
        return 2
    encoded = json.dumps(manifest)

    try:
        token = resolve_token(os.environ, lambda: open_secret(args.secret_id, args.region))
    except WriteBackError as error:
        print(f"nothing applied: {error}", file=sys.stderr)
        return 4
    except SlackApiError as error:
        print(error, file=sys.stderr)
        return 1
    except Exception as error:
        print(f"no App configuration token: {type(error).__name__}: {error}", file=sys.stderr)
        return 2

    try:
        call("apps.manifest.validate", token, app_id=args.app_id, manifest=encoded)
        print(f"validated {path.name} for {args.app_id}")
        live_name = call("apps.manifest.export", token, app_id=args.app_id)["manifest"]
        live_display = live_name.get("display_information", {}).get("name")
        if live_display != manifest["display_information"]["name"]:
            print(f"App {args.app_id} is named {live_display!r}, refusing", file=sys.stderr)
            return 2
        if not args.dry_run:
            answer = call("apps.manifest.update", token, app_id=args.app_id, manifest=encoded)
            print(f"updated {args.app_id}, permissions_updated={answer.get('permissions_updated')}")
        live = call("apps.manifest.export", token, app_id=args.app_id)["manifest"]
    except SlackApiError as error:
        print(error, file=sys.stderr)
        return 1

    wanted_scopes, wanted_events = scopes_and_events(manifest)
    live_scopes, live_events = scopes_and_events(live)
    scopes_equal = diff("bot scopes", wanted_scopes, live_scopes)
    events_equal = diff("bot events", wanted_events, live_events)
    return 0 if scopes_equal and events_equal else 3


if __name__ == "__main__":
    sys.exit(main())
