"""Every served route must be reachable through the gateway, under the right authorizer.

A route the application serves is only served in production if API Gateway declares
a route key that reaches it. The two are written in different files in different
languages, so a domain can grow a route the gateway never routes, and the request
then dies at the edge with a bare 404 that no backend test can see. That is exactly
how `GET /api/users/me` presented in staging.

The gateway's own enforcement is the second half: the generated prefixes carry
`require_identity_jwt`, which is what puts a route key in the access gate's list of
keys that must present an identity token. A prefix that lost the attribute would
leave every route under it reachable without one.

`terraform/apigateway.tf` is parsed with the same regex technique
`test_domain_registry.py` uses on `lambda_domains.tf`, so nothing here needs the
terraform binary or a plan.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

TERRAFORM = Path(__file__).resolve().parents[2].parent / "terraform" / "apigateway.tf"

CONTRACT = Path(__file__).with_name("route_contract.json")

PUBLIC = "public"

INTERNAL = "internal"

_SHARED_GAP = (
    "known gap: the views domain serves /api/shared/{token} and its two subpaths, but "
    "every prefix routed to views is workspace scoped, so no gateway route key reaches "
    "them and a share link 404s at the edge. A share recipient is not a workspace member, "
    "so the path cannot move under /api/workspaces/{workspace_id}; views needs /api/shared "
    "as a top level prefix, the same shape as the /api/invites fix. Allowlisted here so "
    "this test guards against new instances rather than failing on a bug it did not "
    "introduce."
)
"""Why the three share link routes are unreachable through the gateway today."""


UNROUTED_BY_DESIGN: "dict[tuple[str, str], str]" = {
    ("POST", "/api/github/webhooks"): (
        "declared as its own explicit route key with authorization_type NONE, because "
        "GitHub posts it directly carrying only an HMAC over the raw body."
    ),
    ("GET", "/api/github/callback"): (
        "declared as its own explicit route key with authorization_type NONE, because "
        "the install callback arrives as a browser redirect carrying only the signed state."
    ),
    ("GET", "/api/shared/{token}"): _SHARED_GAP,
    ("GET", "/api/shared/{token}/issue"): _SHARED_GAP,
    ("GET", "/api/shared/{token}/view"): _SHARED_GAP,
}
"""Contract routes no generated prefix covers, each with why.

Every entry is a deliberate statement. The first two are routed by their own
explicit keys, which this test reads separately. The rest are one live gateway gap
this test found, sitting here with its reason so the check stays green today and
still fails the moment a new route goes unrouted. A fix deletes its entry, and the
staleness test below fails if anyone forgets to: that is what removed the
/api/invites/accept entry once #4 routed it.
"""


def _terraform_source() -> str:
    """The gateway configuration's text, skipping when the tree is not present."""
    if not TERRAFORM.exists():
        pytest.skip("terraform/apigateway.tf is not present")
    return TERRAFORM.read_text()


def _block(source: str, name: str) -> str:
    """The body of one top level `local` assignment that opens a brace.

    Matched on the two-space indentation the file is written with, which is what
    bounds the block without needing an HCL parser.
    """
    match = re.search(rf"^  {re.escape(name)}\s*=\s*\{{(.*?)^  \}}", source, re.S | re.M)
    assert match, f"apigateway.tf declares no {name}"
    return match.group(1)


def _generated_prefixes(source: str) -> "dict[str, str]":
    """Every path prefix a domain's route keys are generated from, mapped to its domain."""
    block = _block(source, "lambda_domain_path_prefixes")
    prefixes: dict[str, str] = {}
    for match in re.finditer(r"^\s{4}(\w+)\s*=\s*\[(.*?)\]", block, re.S | re.M):
        for path in re.findall(r'"([^"]+)"', match.group(2)):
            prefixes[path] = match.group(1)
    assert prefixes, "no path prefixes were parsed out of lambda_domain_path_prefixes"
    return prefixes


def _unauthenticated_prefixes(source: str) -> "frozenset[str]":
    """The prefixes whose generated keys deliberately carry no identity requirement."""
    match = re.search(r"unauthenticated_route_prefixes\s*=\s*\[([^\]]*)\]", source)
    assert match, "apigateway.tf declares no unauthenticated_route_prefixes"
    return frozenset(re.findall(r'"([^"]+)"', match.group(1)))


def _explicit_route_keys(source: str) -> "dict[tuple[str, str], str]":
    """Every hand written route key, mapped to the attributes its declaration carries.

    Two forms exist. Most are `"METHOD /path" = { ... }`, where the attributes sit
    beside the key. The workspaces keys are instead listed as bare strings under
    `domain_identity_jwt_route_paths` and given their attributes by the merge below
    them, so that list is read separately and each of its keys takes the merge's
    attributes.
    """
    found: dict[tuple[str, str], str] = {}
    for match in re.finditer(r'"([A-Z]+) (/[^"]*)"\s*=\s*\{([^}]*)\}', source):
        found[(match.group(1), match.group(2))] = match.group(3)

    listed = _block(source, "domain_identity_jwt_route_paths")
    merge = re.search(
        r"^  domain_identity_jwt_route_keys\s*=\s*(.*?)^  #",
        source,
        re.S | re.M,
    )
    attributes = merge.group(1) if merge is not None else ""
    for match in re.finditer(r'"([A-Z]+) (/[^"]*)"', listed):
        found.setdefault((match.group(1), match.group(2)), attributes)
    return found


def _generated_merge(source: str) -> str:
    """The body of the `lambda_domain_generated_route_keys` merge expression.

    It is a `merge(flatten([...]))` rather than an object literal, so it is bounded
    by the next top level assignment instead of by a closing brace at this
    indentation.
    """
    match = re.search(
        r"^  lambda_domain_generated_route_keys\s*=\s*(.*?)^  \w+\s*=",
        source,
        re.S | re.M,
    )
    assert match, "apigateway.tf declares no lambda_domain_generated_route_keys"
    return match.group(1)


def _generated_keys_require_identity(source: str) -> bool:
    """Whether the generated key merge still attaches `require_identity_jwt`.

    The attribute is what puts a key in the access gate's enforced list, so losing
    it from the merge would silently unenforce every generated route at once.
    """
    return "require_identity_jwt" in _generated_merge(source)


def _contract_rows() -> "list[dict[str, str]]":
    """Every route the backend serves, with its authorization class."""
    return [{key: str(value) for key, value in row.items()} for row in json.loads(CONTRACT.read_text())]


def _covering_prefix(path: str, prefixes: "dict[str, str]") -> str:
    """The longest declared prefix that routes this path, or "" when none does.

    Longest wins because that is how an HTTP API picks between overlapping route
    keys: the most specific match takes the request.
    """
    matching = [prefix for prefix in prefixes if path == prefix or path.startswith(prefix + "/")]
    return max(matching, key=len) if matching else ""


def routed_rows() -> "list[tuple[str, str, str]]":
    """Every non-internal contract route, as method, path and authorization class."""
    return [(row["method"], row["path"], row["auth"]) for row in _contract_rows() if row["auth"] != INTERNAL]


def test_every_served_route_is_reachable_through_the_gateway() -> None:
    """A route the application serves is routed by a prefix or by its own explicit key.

    A route reaching neither is served by the Lambda and unreachable in production,
    which is a 404 at the edge for every caller of it.
    """
    source = _terraform_source()
    prefixes = _generated_prefixes(source)
    explicit = _explicit_route_keys(source)

    unrouted: list[str] = []
    for method, path, _ in routed_rows():
        if _covering_prefix(path, prefixes):
            continue
        if (method, path) in explicit or ("ANY", path) in explicit:
            continue
        if (method, path) in UNROUTED_BY_DESIGN:
            continue
        unrouted.append(f"{method} {path}")

    assert unrouted == [], (
        "these routes are served by a domain but no gateway route key reaches them, so "
        f"every request for them 404s at the edge: {sorted(unrouted)}"
    )


def test_the_unrouted_allowlist_names_only_routes_that_exist() -> None:
    """A stale allowlist entry would hide a route the gateway did start routing.

    An entry that no longer names a served route, or that names one a prefix now
    covers, is removed rather than carried, so the allowlist stays a list of live
    decisions.
    """
    source = _terraform_source()
    prefixes = _generated_prefixes(source)
    served = {(method, path) for method, path, _ in routed_rows()}
    explicit = _explicit_route_keys(source)

    stale: list[str] = []
    for method, path in UNROUTED_BY_DESIGN:
        if (method, path) not in served:
            stale.append(f"{method} {path} is allowlisted but no longer served")
        elif _covering_prefix(path, prefixes) and (method, path) not in explicit:
            stale.append(f"{method} {path} is allowlisted but a prefix now routes it")

    assert stale == [], f"the unrouted allowlist is out of date: {sorted(stale)}"


def test_the_generated_route_keys_still_carry_the_identity_requirement() -> None:
    """The generated merge attaches `require_identity_jwt` to every authenticated prefix.

    Before this was generated, only five hand listed route keys carried it, so every
    other route was reachable at the gateway without an identity token. Losing the
    attribute from the merge would put the surface straight back there.
    """
    source = _terraform_source()
    assert _generated_keys_require_identity(source), (
        "lambda_domain_generated_route_keys no longer attaches require_identity_jwt, so no "
        "generated route key is in the access gate's enforced list."
    )


@pytest.mark.parametrize(("method", "path", "auth"), routed_rows(), ids=lambda value: str(value))
def test_the_gateway_agrees_with_the_routes_authorization_class(method: str, path: str, auth: str) -> None:
    """One route's authorization class agrees with the enforcement its route key carries.

    An `authenticated` or capability route must fall under a prefix the generated
    merge marks, or under an explicit key that marks itself. A `public` route must
    fall under neither, because a gateway that demanded a token would make an
    anonymous entry point unreachable for the caller it exists for.

    The assertion is that `require_identity_jwt` is declared on the key, not that it
    reads `true`: the attribute is rendered from `var.domain_jwt_enforced`, and it
    is its presence that puts the key in the gate Lambda's list. A key that lost the
    attribute is out of that list whatever the variable says.
    """
    source = _terraform_source()
    prefixes = _generated_prefixes(source)
    unauthenticated = _unauthenticated_prefixes(source)
    explicit = _explicit_route_keys(source)

    key = explicit.get((method, path), explicit.get(("ANY", path)))
    prefix = _covering_prefix(path, prefixes)

    if key is not None:
        enforced = "require_identity_jwt" in key
        nothing_enforced = "authorization_type" in key and "NONE" in key
    elif prefix:
        enforced = prefix not in unauthenticated and _generated_keys_require_identity(source)
        nothing_enforced = prefix in unauthenticated
    else:
        pytest.skip(UNROUTED_BY_DESIGN.get((method, path), "no route key reaches this path"))

    if auth == PUBLIC:
        assert nothing_enforced or not enforced, (
            f"{method} {path} is served as public but its gateway route key requires an "
            "identity token, so the anonymous caller it exists for cannot reach it."
        )
        return

    assert enforced, (
        f"{method} {path} is served as {auth} but its gateway route key carries no identity "
        "requirement, so the access gate does not enforce a token on it."
    )
