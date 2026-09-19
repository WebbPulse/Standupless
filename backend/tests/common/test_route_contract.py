"""The route contract: every route, with the authorization class guarding it.

The fixture beside this module is regenerated whenever it drifts, so the diff on
`route_contract.json` is the review artifact for "did a route just become
public". A reviewer reads that file rather than re-deriving the answer from the
dependency graph of every handler.

Run with `REGENERATE_ROUTE_CONTRACT=1` to accept an intended change.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from app.common.composition.domains import DOMAIN_NAMES, DOMAINS
from app.common.composition.wiring import build_domain_app

FIXTURE = Path(__file__).with_name("route_contract.json")

PUBLIC = "public"

AUTHENTICATED = "authenticated"

INTERNAL = "internal"


def _auth_class(route: Any) -> str:
    """The authorization class one route carries, read off its dependencies.

    A route guarded by the workspace dependency reports the capability it
    declared, which is the fact a reviewer is checking. Anything with no
    identity dependency at all is `public`, and that is the word the fixture is
    read for.
    """
    from app.common.api.dependencies.authz import Capability

    if not route.include_in_schema:
        return INTERNAL

    for dependency in route.dependant.dependencies:
        call = dependency.call
        capability = getattr(call, "__wrapped_capability__", None)
        if isinstance(capability, Capability):
            return capability.value
        if getattr(call, "__name__", "") == "caller_subject":
            return AUTHENTICATED

    return PUBLIC


ROOT_PATHS = ("/", "/health", "/ready")


def _api_routes(app: Any) -> "list[tuple[str, Any]]":
    """Every routed endpoint of an application, with its full path.

    A domain's routers are wrapped in a lazy include, so its endpoints are not in
    `app.routes` directly; each wrapper carries the router it included and the
    prefix it was mounted under, which is what reconstructs the served path.
    """
    found: "list[tuple[str, Any]]" = []
    for route in app.routes:
        included = getattr(route, "original_router", None)
        if included is not None:
            prefix = getattr(getattr(route, "include_context", None), "prefix", "")
            for inner in included.routes:
                if hasattr(inner, "dependant"):
                    found.append((f"{prefix}{inner.path}", inner))
            continue
        if hasattr(route, "dependant"):
            found.append((route.path, route))
    return found


def _routes() -> "list[dict[str, Any]]":
    """Every route of every domain, with its methods and authorization class."""
    collected: "list[dict[str, Any]]" = []
    for name in DOMAIN_NAMES:
        app = build_domain_app(DOMAINS[name])
        for path, route in _api_routes(app):
            if path in ROOT_PATHS:
                continue
            for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
                collected.append(
                    {
                        "domain": name,
                        "method": method,
                        "path": path,
                        "auth": _auth_class(route),
                    }
                )
    collected.sort(key=lambda row: (row["domain"], row["path"], row["method"]))
    return collected


def test_the_route_contract_matches_the_fixture() -> None:
    """Every route's authorization class, pinned so a change has to be reviewed.

    Regenerates the fixture when `REGENERATE_ROUTE_CONTRACT` is set, so an
    intended change is one env var and a diff rather than a hand edit.
    """
    current = _routes()
    rendered = json.dumps(current, indent=2, sort_keys=True) + "\n"

    if os.environ.get("REGENERATE_ROUTE_CONTRACT") or not FIXTURE.exists():
        FIXTURE.write_text(rendered)

    assert json.loads(FIXTURE.read_text()) == current, (
        "The route contract changed. Review the diff, then regenerate it with "
        "REGENERATE_ROUTE_CONTRACT=1 uv run pytest tests/common/test_route_contract.py"
    )


PUBLIC_ROUTES = {
    ("POST", "/api/github/webhooks"),
    ("GET", "/api/github/callback"),
}
"""The routes GitHub reaches directly, which therefore carry no caller identity.

Neither can take an authenticated caller: the webhook arrives from GitHub with
only its HMAC over the raw body, and the install callback arrives as a browser
redirect carrying only the signed state. Each proves itself before it reads the
payload, so the credential moves from the session to the request. Anything else
appearing as public is the regression this test exists to surface.
"""


def test_no_route_is_public() -> None:
    """Only the two GitHub entry points are anonymous, and both by design.

    Every other route sits behind a workspace capability or the signed in caller
    dependency. Widening this set is a deliberate edit that shows up in review.
    """
    public = {(row["method"], row["path"]) for row in _routes() if row["auth"] == PUBLIC}
    unexpected = sorted(public - PUBLIC_ROUTES)
    assert unexpected == [], f"these routes take no authenticated caller: {unexpected}"

    missing = sorted(PUBLIC_ROUTES - public)
    assert missing == [], f"these routes are allowlisted as public but are not served as public: {missing}"
