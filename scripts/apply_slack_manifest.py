"""Apply a committed Slack app manifest to the live Slack App through the manifest API.

Validates the environment's manifest with ``apps.manifest.validate``, writes it with
``apps.manifest.update`` and reads it back with ``apps.manifest.export``, then prints
the bot scopes and bot events that differ between the committed file and the live
App. The App configuration token comes from ``SLACK_CONFIG_TOKEN`` and is never
printed, so run the script through ``asm-exec`` with a secret reference::

    SLACK_CONFIG_TOKEN='{{resolve:secretsmanager:standupless-staging/app:SecretString:SLACK_CONFIG_TOKEN}}' \\
        asm-exec python3 scripts/apply_slack_manifest.py staging --app-id A0123456789

``--dry-run`` validates and diffs against the live App without writing. The script
uses only the standard library, so it runs without the backend environment.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

SLACK_API = "https://slack.com/api/"
MANIFESTS = {
    "staging": "manifest.staging.json",
    "production": "manifest.production.json",
}


class SlackApiError(RuntimeError):
    """A Slack Web API call that answered ``ok: false``."""


def call(method: str, token: str, **params: str) -> dict[str, Any]:
    """Call one Slack Web API method with a form body and return its JSON answer."""
    body = urllib.parse.urlencode(params).encode()
    request = urllib.request.Request(
        SLACK_API + method,
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        answer: dict[str, Any] = json.load(response)
    if not answer.get("ok"):
        details = answer.get("errors") or answer.get("response_metadata") or ""
        raise SlackApiError(f"{method}: {answer.get('error')} {json.dumps(details)}")
    return answer


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
    args = parser.parse_args()

    token = os.environ.get("SLACK_CONFIG_TOKEN", "")
    if not token or token.startswith("{{resolve:"):
        print("SLACK_CONFIG_TOKEN is not set; run through asm-exec", file=sys.stderr)
        return 2

    path = Path(__file__).resolve().parent.parent / "slack" / MANIFESTS[args.environment]
    manifest = json.loads(path.read_text())
    if manifest.get("display_information", {}).get("name", "").endswith("Staging") != (
        args.environment == "staging"
    ):
        print(f"{path.name} does not match environment {args.environment}", file=sys.stderr)
        return 2
    encoded = json.dumps(manifest)

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
