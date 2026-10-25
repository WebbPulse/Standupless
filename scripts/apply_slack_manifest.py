"""Apply a committed Slack app manifest to the live Slack App through the manifest API.

Validates the environment's manifest with ``apps.manifest.validate``, writes it with
``apps.manifest.update`` and reads it back with ``apps.manifest.export``, then prints
the bot scopes and bot events that differ between the committed file and the live
App. ``--dry-run`` validates and diffs against the live App without writing. The
script refuses an App whose name does not match the manifest.

The App ID comes from ``--app-id`` or, when that is omitted, from the environment's
entry in ``slack/app_ids.json``, which holds no secret.

The App configuration token comes from one of two places, and no token is ever
printed or logged:

1. ``SLACK_CONFIG_TOKEN``, a 12-hour access token, when it is set. Pass it through
   ``asm-exec`` with a secret reference so the value never enters a shell.
2. Otherwise the refresh token stored as ``SLACK_CONFIG_REFRESH_TOKEN`` in its own
   secret, ``standupless-production/slack-config``, the only copy for both
   environments. The script reads it, calls ``tooling.tokens.rotate`` and writes the
   new refresh token back. Slack refresh tokens work once, so the write must succeed
   before anything is applied; when it fails the script exits 4 without touching the
   App. The access token stays in memory.

``--role-arn`` names a role to assume for that secret, which is how the deploy
pipeline reaches it: the job runs on the environment's deploy role and passes the
production ``standupless-production-slack-config`` role, which may read and write
that one secret and nothing else. Without it the ambient AWS profile is used.

The token used to live in the shared ``standupless-production/app`` secret. While the
dedicated secret holds no token, the script migrates it once: it rotates the old
``SLACK_CONFIG_REFRESH_TOKEN`` from the app secret, writes the new refresh token only
into the dedicated secret, then removes the old key. The deploy roles cannot read the
app secret, so the migration runs from the production AdministratorAccess profile,
and ``--dry-run`` does it without writing the manifest::

    AWS_PROFILE=Standupless-Production/AdministratorAccess \\
        uv run --no-sync python ../scripts/apply_slack_manifest.py staging --dry-run

Run it from the ``backend`` directory, since the refresh path needs boto3. When the
dedicated secret cannot take the new token during the migration, the token is kept in
the app secret instead and the script exits 4. ``--secret-id``,
``--legacy-secret-id`` and ``--region`` override the two secret ids and
``us-west-2``. The access token path uses only the standard library::

    SLACK_CONFIG_TOKEN='{{resolve:secretsmanager:standupless-staging/app:SecretString:SLACK_CONFIG_TOKEN}}' \\
        asm-exec python3 scripts/apply_slack_manifest.py staging --app-id A0123456789

``--skip-unprovisioned`` makes the pipeline skip cleanly while that setup has not
happened yet: when the role cannot be assumed, or the dedicated secret holds no token
and the app secret cannot be read, the script prints a warning and exits 0 without
calling Slack. Any other failure keeps its exit code.

Exit codes: 0 applied and in sync, or skipped as unprovisioned, 1 a Slack call failed, 2 bad input or no token,
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
DEFAULT_SECRET_ID = "standupless-production/slack-config"
LEGACY_SECRET_ID = "standupless-production/app"
DEFAULT_REGION = "us-west-2"
APP_IDS_FILE = "app_ids.json"
ROLE_SESSION_NAME = "apply-slack-manifest"
WRITE_RETRIES = 3


class SlackApiError(RuntimeError):
    """A Slack Web API call that answered ``ok: false``."""


class TokenError(RuntimeError):
    """No usable configuration token could be found or the stored refresh token is unusable."""


class NotProvisioned(TokenError):
    """The slack-config role or the token in its dedicated secret does not exist yet."""


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

    def remove(self) -> None:
        """Drop the refresh token key, keeping every other key, once the token has moved out."""
        try:
            from webbpulse.ops.config import SecretStore
        except ImportError:
            self._merge(None)
            return
        SecretStore(self._client, self.secret_id, retries=WRITE_RETRIES).unset(self.key)

    def _merge(self, value: str | None) -> None:
        """Read, set or drop the key, re-check the version and write, retrying on a concurrent change."""
        for _ in range(WRITE_RETRIES + 1):
            version, current = self._read_object()
            if value is None and self.key not in current:
                return
            if value is not None and current.get(self.key) == value:
                return
            if self._current_version() != version:
                continue
            if value is None:
                del current[self.key]
            else:
                current[self.key] = value
            self._client.put_secret_value(
                SecretId=self.secret_id,
                SecretString=json.dumps(current, sort_keys=True),
                ClientRequestToken=str(uuid.uuid4()),
            )
            return
        raise WriteBackError(f"secret {self.secret_id} changed between read and write on every attempt")


def error_code(error: BaseException) -> str:
    """Return the AWS error code a botocore ``ClientError`` carries, or an empty string."""
    response = getattr(error, "response", None)
    if not isinstance(response, dict):
        return ""
    return str(response.get("Error", {}).get("Code", ""))


class TokenSecret:
    """The dedicated secret that holds only the refresh token.

    It is read and written with ``GetSecretValue`` and ``PutSecretValue`` alone, the two
    actions the slack-config role carries, and it holds no other key, so a write
    replaces the whole value rather than merging into it.
    """

    def __init__(self, client: Any, secret_id: str, key: str = REFRESH_TOKEN_KEY) -> None:
        """Bind a Secrets Manager client to the dedicated secret."""
        self._client = client
        self.secret_id = secret_id
        self.key = key

    def peek(self) -> str | None:
        """Return the stored refresh token, or ``None`` while the secret has no value or no token."""
        try:
            raw = self._client.get_secret_value(SecretId=self.secret_id).get("SecretString")
        except Exception as error:
            if error_code(error) == "ResourceNotFoundException":
                return None
            raise
        try:
            decoded = json.loads(raw) if raw else {}
        except ValueError:
            decoded = None
        if not isinstance(decoded, dict):
            raise TokenError(f"secret {self.secret_id} does not hold a JSON object")
        value = decoded.get(self.key)
        return value if isinstance(value, str) and value else None

    def read(self) -> str:
        """Return the stored refresh token, raising ``TokenError`` when it is absent."""
        value = self.peek()
        if value is None:
            raise TokenError(f"{self.key} is not set in secret {self.secret_id}")
        return value

    def write(self, value: str) -> None:
        """Store the new refresh token as the secret's only key."""
        self._client.put_secret_value(
            SecretId=self.secret_id,
            SecretString=json.dumps({self.key: value}),
            ClientRequestToken=str(uuid.uuid4()),
        )


def rotated_pair(
    refresh: str,
    rotate: Callable[[str], dict[str, Any]] | None = None,
) -> tuple[str, str]:
    """Spend one refresh token with ``tooling.tokens.rotate`` and return the new access and refresh tokens."""
    rotate = rotate or (lambda token: call("tooling.tokens.rotate", None, refresh_token=token))
    answer = rotate(refresh)
    access, successor = answer.get("token"), answer.get("refresh_token")
    if not isinstance(access, str) or not access or not isinstance(successor, str) or not successor:
        raise TokenError("tooling.tokens.rotate answered without a token and refresh token")
    return access, successor


def rotate_config_token(
    secret: RefreshTokenSecret | TokenSecret,
    rotate: Callable[[str], dict[str, Any]] | None = None,
) -> str:
    """Rotate the stored refresh token, store the new one, and return the access token.

    Raises ``WriteBackError`` when the new refresh token cannot be stored; the access
    token is then withheld so nothing is applied with a token whose successor is lost.
    """
    access, refresh = rotated_pair(secret.read(), rotate)
    try:
        secret.write(refresh)
    except Exception as error:
        raise WriteBackError(
            f"could not store the rotated {secret.key} in secret {secret.secret_id} "
            f"({type(error).__name__}: {error}); the old refresh token is spent, so mint a new "
            "App configuration token and store its refresh token before running again"
        ) from None
    return access


def migrate_config_token(
    legacy: RefreshTokenSecret,
    store: TokenSecret,
    rotate: Callable[[str], dict[str, Any]] | None = None,
) -> str:
    """Move the refresh token from the shared app secret into the dedicated one, and return an access token.

    The old token is rotated, its successor is written only into the dedicated secret,
    and then the old key is removed. When the dedicated secret refuses the write, the
    successor goes back into the app secret so it is not lost, and ``WriteBackError``
    still stops the run. A failed removal only warns, because the key it leaves holds a
    spent token that is never read again once the dedicated secret has one.
    """
    try:
        refresh = legacy.read()
    except TokenError:
        raise
    except Exception as error:
        raise NotProvisioned(
            f"secret {store.secret_id} holds no {store.key} yet and secret {legacy.secret_id} could not be read "
            f"({type(error).__name__}); migrate it once from the production AdministratorAccess profile"
        ) from None
    access, successor = rotated_pair(refresh, rotate)
    try:
        store.write(successor)
    except Exception as error:
        try:
            legacy.write(successor)
        except Exception:
            raise WriteBackError(
                f"could not store the rotated {store.key} in secret {store.secret_id} ({type(error).__name__}: "
                f"{error}) or put it back in secret {legacy.secret_id}; the old refresh token is spent, so mint "
                "a new App configuration token and store its refresh token before running again"
            ) from None
        raise WriteBackError(
            f"could not store the rotated {store.key} in secret {store.secret_id} ({type(error).__name__}: "
            f"{error}); it was kept in secret {legacy.secret_id}, so fix the access and run again"
        ) from None
    try:
        legacy.remove()
    except Exception as error:
        print(
            f"warning: moved {legacy.key} to secret {store.secret_id} but could not remove it from secret "
            f"{legacy.secret_id} ({type(error).__name__}); remove the spent key by hand",
            file=sys.stderr,
        )
    else:
        print(f"moved {legacy.key} from secret {legacy.secret_id} to secret {store.secret_id}")
    return access


def secrets_client(region: str, role_arn: str | None = None) -> Any:
    """Return a Secrets Manager client on the ambient AWS profile, or on a session of ``role_arn``."""
    try:
        import boto3
    except ImportError:
        raise TokenError(
            "the refresh token path needs boto3; run from the backend environment, or set SLACK_CONFIG_TOKEN"
        ) from None
    if role_arn is None:
        return boto3.client("secretsmanager", region_name=region)
    try:
        credentials = boto3.client("sts", region_name=region).assume_role(
            RoleArn=role_arn, RoleSessionName=ROLE_SESSION_NAME, DurationSeconds=900
        )["Credentials"]
    except Exception as error:
        if error_code(error) == "AccessDenied":
            raise NotProvisioned(
                f"role {role_arn} cannot be assumed (AccessDenied); it does not exist yet or does not trust this caller"
            ) from None
        raise
    return boto3.client(
        "secretsmanager",
        region_name=region,
        aws_access_key_id=credentials["AccessKeyId"],
        aws_secret_access_key=credentials["SecretAccessKey"],
        aws_session_token=credentials["SessionToken"],
    )


def open_secret(secret_id: str, region: str, role_arn: str | None = None) -> TokenSecret:
    """Open the dedicated refresh token secret, through ``role_arn`` when one is given."""
    return TokenSecret(secrets_client(region, role_arn), secret_id)


def open_legacy_secret(secret_id: str, region: str) -> RefreshTokenSecret:
    """Open the shared app secret the token is migrated out of, on the ambient AWS profile."""
    return RefreshTokenSecret(secrets_client(region), secret_id)


def resolve_token(
    environ: Mapping[str, str],
    open_store: Callable[[], RefreshTokenSecret | TokenSecret],
    rotate: Callable[[str], dict[str, Any]] | None = None,
    open_legacy: Callable[[], RefreshTokenSecret] | None = None,
) -> str:
    """Return ``SLACK_CONFIG_TOKEN`` when set, otherwise an access token from a stored refresh token.

    With ``open_legacy`` and a dedicated secret that holds no token yet, the token is
    migrated out of the shared app secret first.
    """
    token = environ.get(ACCESS_TOKEN_ENV, "")
    if token.startswith("{{resolve:"):
        raise TokenError(f"{ACCESS_TOKEN_ENV} is an unresolved reference; run through asm-exec")
    if token:
        return token
    store = open_store()
    if open_legacy is not None and isinstance(store, TokenSecret) and store.peek() is None:
        return migrate_config_token(open_legacy(), store, rotate)
    return rotate_config_token(store, rotate)


def committed_app_id(environment: str, directory: Path) -> str:
    """Return the environment's App ID from ``slack/app_ids.json``, raising ``TokenError`` when it is unset."""
    try:
        app_ids = json.loads((directory / APP_IDS_FILE).read_text())
    except (OSError, ValueError):
        app_ids = {}
    app_id = app_ids.get(environment) if isinstance(app_ids, dict) else None
    if not isinstance(app_id, str) or not app_id:
        raise TokenError(f"no App ID for {environment} in slack/{APP_IDS_FILE}; pass --app-id")
    return app_id


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
    parser.add_argument("--app-id", help="The App ID from Basic Information, defaulting to slack/app_ids.json")
    parser.add_argument("--dry-run", action="store_true", help="Validate and diff only")
    parser.add_argument("--secret-id", default=DEFAULT_SECRET_ID, help="The secret holding the refresh token")
    parser.add_argument(
        "--legacy-secret-id", default=LEGACY_SECRET_ID, help="The shared secret the token is migrated out of"
    )
    parser.add_argument("--role-arn", help="A role to assume for the refresh token secret, as the deploy pipeline does")
    parser.add_argument("--region", default=DEFAULT_REGION, help="The secrets' AWS region")
    parser.add_argument(
        "--skip-unprovisioned",
        action="store_true",
        help="Exit 0 with a warning when the slack-config role or the dedicated token does not exist yet",
    )
    args = parser.parse_args()

    slack_dir = Path(__file__).resolve().parent.parent / "slack"
    if not args.app_id:
        try:
            args.app_id = committed_app_id(args.environment, slack_dir)
        except TokenError as error:
            print(error, file=sys.stderr)
            return 2
    path = slack_dir / MANIFESTS[args.environment]
    manifest = json.loads(path.read_text())
    if manifest.get("display_information", {}).get("name", "").endswith("Staging") != (
        args.environment == "staging"
    ):
        print(f"{path.name} does not match environment {args.environment}", file=sys.stderr)
        return 2
    encoded = json.dumps(manifest)

    try:
        token = resolve_token(
            os.environ,
            lambda: open_secret(args.secret_id, args.region, args.role_arn),
            open_legacy=lambda: open_legacy_secret(args.legacy_secret_id, args.region),
        )
    except WriteBackError as error:
        print(f"nothing applied: {error}", file=sys.stderr)
        return 4
    except SlackApiError as error:
        print(error, file=sys.stderr)
        return 1
    except NotProvisioned as error:
        if not args.skip_unprovisioned:
            print(f"no App configuration token: {error}", file=sys.stderr)
            return 2
        print(f"::warning title=Slack manifest skipped::{error}")
        return 0
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
