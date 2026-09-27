"""Every path the frontend builds must be a route the backend actually serves.

The frontend and the route contract are written in two languages and reviewed in
two diffs, so a page can call a path no domain serves and every backend test still
passes. That is how `GET /api/users/me` shipped: the auth shell read the profile
from a route no domain declared and no gateway prefix routed, and staging answered
404 on sign in while the suites stayed green.

This reads the request paths straight out of `frontend/src/api/*.ts` and asserts
each one matches a `route_contract.json` entry by method and path shape. It is a
static read rather than a running bundle, so it costs nothing and cannot be
skipped by a test environment that has no node.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

FRONTEND_API = Path(__file__).resolve().parents[2].parent / "frontend" / "src" / "api"

CONTRACT = Path(__file__).with_name("route_contract.json")

API_PREFIX = "/api"

METHODS = ("get", "post", "put", "patch", "delete")

IDENTITY_PREFIXES = ("/api/auth",)
"""Paths served by the `webbpulse.identity` package rather than by a product domain.

The package owns these routes, they are not declared in the product's route
contract, and the shared `AuthClient` builds them itself rather than through this
application's path helpers. A path under one of these is not the product's to
serve, so it is not checked against the contract.
"""

UNCHECKED_MODULES = frozenset({"client.ts"})
"""Modules that configure the client rather than build a request path."""


def _contract_paths() -> "set[tuple[str, str]]":
    """Every method and path shape the backend serves, internal routes included.

    Internal routes stay in: the frontend must not call one, but a frontend path
    that happens to match one is a separate finding from a path that matches
    nothing, and this test is about the second.
    """
    rows = json.loads(CONTRACT.read_text())
    return {(str(row["method"]).upper(), str(row["path"])) for row in rows}


def _normalise(path: str) -> str:
    """A resolved frontend path put in the contract's own terms.

    Prefixes `/api` when it is missing, because a product path is built relative to
    the configured API base URL, which already carries the prefix, while the
    contract names the served path whole.
    """
    if not path.startswith(API_PREFIX + "/"):
        return f"{API_PREFIX}{path}"
    return path


def _shape(path: str) -> str:
    """A path with every placeholder segment reduced to `{}`, so two shapes compare.

    The contract names its placeholders after the handler's parameters and the
    frontend names them after its own variables, so the names never agree and the
    positions always must.
    """
    segments = []
    for segment in path.split("/"):
        segments.append("{}" if segment.startswith("{") and segment.endswith("}") else segment)
    return "/".join(segments)


def _module_sources() -> "dict[str, str]":
    """Every frontend API module's text, keyed by file name."""
    if not FRONTEND_API.is_dir():
        pytest.skip("the frontend tree is not present")
    return {
        path.name: path.read_text()
        for path in sorted(FRONTEND_API.glob("*.ts"))
        if not path.name.endswith(".test.ts") and path.name not in UNCHECKED_MODULES
    }


def _literal_constants(source: str) -> "dict[str, str]":
    """The module's `const NAME = '/literal'` path constants."""
    found: dict[str, str] = {}
    for match in re.finditer(r"(?:export\s+)?const\s+(\w+)\s*(?::\s*string\s*)?=\s*'([^']*)'", source):
        found[match.group(1)] = match.group(2)
    return found


def _template_helpers(source: str) -> "dict[str, str]":
    """The module's arrow functions whose whole body is one template literal.

    These are how every path in this frontend is written: a helper per route, each
    either a literal template or a composition of an earlier helper. Both forms are
    captured here and resolved afterwards.
    """
    pattern = re.compile(
        r"(?:export\s+)?const\s+(\w+)\s*=\s*\((?:[^)]*)\)\s*(?::\s*string\s*)?=>\s*`([^`]*)`",
        re.S,
    )
    return {match.group(1): match.group(2) for match in pattern.finditer(source)}


def _resolve_expression(expression: str, constants: "dict[str, str]", helpers: "dict[str, str]", depth: int) -> str:
    """The path one JavaScript expression evaluates to, or `{}` when it is a value.

    Three forms carry a path: a named constant, a call of a path helper, and a
    template literal. Anything else is a runtime value filling a segment, which is
    a wildcard as far as the shape comparison is concerned.
    """
    if depth > 10:
        return "{}"

    expression = expression.strip()
    if expression.startswith("`") and expression.endswith("`"):
        return _resolve_template(expression[1:-1], constants, helpers, depth + 1)

    call = re.match(r"^(\w+)\s*\(", expression)
    if call is not None and call.group(1) in helpers:
        return _resolve_template(helpers[call.group(1)], constants, helpers, depth + 1)

    if expression in constants:
        return constants[expression]
    if expression in helpers:
        return _resolve_template(helpers[expression], constants, helpers, depth + 1)
    return "{}"


def _resolve_template(template: str, constants: "dict[str, str]", helpers: "dict[str, str]", depth: int = 0) -> str:
    """One template literal with every interpolation replaced by the path it builds.

    The helpers compose, so this recurses through `_resolve_expression`: `issuePath`
    is `${issuesPath(id)}/${x}` and `issuesPath` is a literal. Depth is capped so a
    cycle fails the parse rather than hanging the suite.
    """
    if depth > 10:
        return template

    def _substitute(match: re.Match[str]) -> str:
        """The resolved path for one `${...}` interpolation, or a wildcard."""
        return _resolve_expression(match.group(1), constants, helpers, depth)

    return re.sub(r"\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}", _substitute, template)


def _first_argument(source: str, start: int) -> str:
    """The text of the first argument of the call whose `(` sits at `start`.

    Scanned with a depth counter rather than matched with a regex, because the
    first argument is routinely a nested call of its own, such as
    `viewPath(workspaceId, viewId)`, and a non-greedy match stops at the comma
    inside it.
    """
    depth = 0
    for index in range(start, len(source)):
        character = source[index]
        if character in "([{`":
            depth += 1
        elif character in ")]}":
            depth -= 1
            if depth == 0:
                return source[start + 1 : index].strip()
        elif character == "," and depth == 1:
            return source[start + 1 : index].strip()
    return ""


def _calls(source: str) -> "list[tuple[str, str]]":
    """Every `apiClient.<method>(<pathExpression>)` in one module, as method and expression.

    The generic type argument and the options argument are both skipped: the path
    is always the first argument, and only its text is needed.
    """
    pattern = re.compile(r"apiClient\.(" + "|".join(METHODS) + r")\s*(?:<[^(]*>)?\s*\(")
    found: list[tuple[str, str]] = []
    for match in pattern.finditer(source):
        argument = _first_argument(source, match.end() - 1)
        if argument:
            found.append((match.group(1).upper(), argument))
    return found


def frontend_requests() -> "list[tuple[str, str, str]]":
    """Every request the frontend API modules make, as module, method and path shape."""
    requests: list[tuple[str, str, str]] = []
    for name, source in _module_sources().items():
        constants = _literal_constants(source)
        helpers = _template_helpers(source)
        for method, expression in _calls(source):
            resolved = _resolve_expression(expression, constants, helpers, 0)
            if not resolved.startswith("/"):
                continue
            requests.append((name, method, _shape(_normalise(resolved))))
    return requests


def test_the_frontend_api_modules_were_parsed() -> None:
    """The parse found requests in every module, so a silent parse failure cannot pass.

    Every assertion below is over what the parse produced, so a regex that stopped
    matching would make this file assert nothing while still reporting green. This
    holds the floor the parse has to clear.
    """
    requests = frontend_requests()
    assert len(requests) >= 50, f"only {len(requests)} frontend requests parsed, so the parse is broken"

    modules = {name for name, _, _ in requests}
    expected = {name for name in _module_sources() if name not in {"identityClient.ts"}}
    assert modules == expected, f"no requests parsed out of {sorted(expected - modules)}"


@pytest.mark.parametrize(("module", "method", "path"), frontend_requests(), ids=lambda value: str(value))
def test_every_frontend_path_is_a_route_the_backend_serves(module: str, method: str, path: str) -> None:
    """One frontend request path matches a contract route by method and shape.

    A failure here is a page calling a route nothing serves, which is a 404 for
    every user of that page and is invisible to a unit test on either side.
    """
    if path.startswith(IDENTITY_PREFIXES):
        pytest.skip("served by the identity package, not by the product route contract")

    served = {(served_method, _shape(served_path)) for served_method, served_path in _contract_paths()}
    assert (method, path) in served, (
        f"{module} calls {method} {path}, which no route in route_contract.json serves. "
        "Either the route is missing from the backend or the frontend path is wrong."
    )


def test_the_profile_route_the_auth_shell_reads_is_served() -> None:
    """`GET /api/users/me` is served, because the auth shell cannot sign anyone in without it.

    The shell loads the profile from this path on every page load, so a backend
    that does not serve it logs every signed in caller straight back out. It is
    asserted by name as well as through the parse, because the parse reads the
    product modules and this path is built inside `identityClient.ts` against the
    identity origin rather than through a product path helper.
    """
    identity_client = FRONTEND_API / "identityClient.ts"
    if not identity_client.is_file():
        pytest.skip("the frontend tree is not present")

    match = re.search(r"CURRENT_USER_PATH\s*(?::\s*string\s*)?=\s*'([^']+)'", identity_client.read_text())
    assert match is not None, "identityClient.ts no longer declares CURRENT_USER_PATH"

    path = match.group(1)
    served = {(method, _shape(served_path)) for method, served_path in _contract_paths()}
    assert ("GET", _shape(path)) in served, (
        f"the auth shell loads the signed in profile from {path}, which no route in "
        "route_contract.json serves, so every sign in would fail on it."
    )
