"""Routes the post-deploy suite deliberately does not exercise, each with why.

Every entry costs a real hole in the post-deploy check, so each one names the
reason it cannot be driven from a runner rather than the reason nobody got to it
yet. An entry whose reason has stopped being true is deleted, not carried, and the
coverage test fails on a stale entry so that deletion is forced rather than
remembered.

Keyed by method and contract path template, which is what
`backend/tests/common/route_contract.json` names a route by.
"""

from __future__ import annotations

from typing import Final

_API_KEYS: Final[str] = (
    "minting a workspace API key hands back a long lived credential in the response body, "
    "and a post-deploy run that created one on every deploy would leave a trail of live "
    "keys on the stage. The revoke route needs a key this run did not create."
)
"""Why the workspace API key routes carry no post-deploy coverage."""

_SHARE_LINKS: Final[str] = (
    "a share link is only worth asserting on by following it, and the three /api/shared "
    "routes it points at are unreachable at the edge today. Minting one this run cannot "
    "redeem would assert about the mint alone."
)
"""Why the share link management routes carry no post-deploy coverage."""

_SHARED_READS: Final[str] = (
    "the views domain serves these, but every prefix routed to views is workspace scoped, "
    "so no gateway route key reaches them and a share link 404s at the edge. "
    "tests/common/test_gateway_routing.py allowlists the same three routes and fails once "
    "they are routed, which is when these entries should be reconsidered too."
)
"""Why the three share redemption routes carry no post-deploy coverage."""

_TEARDOWN: Final[str] = (
    "the suite does call this, in fixture teardown, so that a run leaves no workspace or "
    "project behind. Teardown runs after the recording the coverage check reads, so the "
    "call is real but uncounted. Asserting on it inside a test would delete the fixture "
    "every later test in the session depends on."
)
"""Why the two delete routes read as uncovered although the suite calls them."""

UNCOVERED_BY_DESIGN: Final[dict[tuple[str, str], str]] = {
    ("POST", "/api/github/webhooks"): (
        "GitHub posts this directly with an HMAC over the raw body. The runner holds no "
        "webhook secret, and forging one would assert about this test's own signing rather "
        "than about GitHub's."
    ),
    ("GET", "/api/github/callback"): (
        "the install callback arrives as a browser redirect carrying state signed during a "
        "real GitHub App installation, which a post-deploy run cannot perform."
    ),
    ("GET", "/api/workspaces/{workspace_id}/github/install-url"): (
        "minting an install URL is harmless but the rest of the GitHub surface below cannot "
        "follow it, so it is grouped with the installation routes it belongs to."
    ),
    ("GET", "/api/workspaces/{workspace_id}/github/installation"): (
        "needs a real GitHub App installation against this stage's App, which only the owner can create."
    ),
    ("DELETE", "/api/workspaces/{workspace_id}/github/installation"): (
        "needs a real installation to remove, and removing the stage's shared installation would break the next run."
    ),
    ("GET", "/api/workspaces/{workspace_id}/github/repositories"): (
        "lists an installation's repositories, so it needs the installation above."
    ),
    ("PATCH", "/api/workspaces/{workspace_id}/github/repositories/{repository_id}"): (
        "pins a repository from an installation this run cannot create."
    ),
    ("GET", "/api/workspaces/{workspace_id}/issues/{issue_id}/github-links"): (
        "a link is written by the webhook consumer from a real pull request event, which this run cannot produce."
    ),
    ("POST", "/api/invites/accept"): (
        "redeeming an invite needs a second account to accept it, and this run holds one "
        "user. The route is reachable at the edge as of #4; this entry is now only about "
        "the second account, which an ephemeral user fixture could supply later."
    ),
    ("POST", "/api/workspaces/{workspace_id}/attachments/uploads"): (
        "mints a presigned S3 upload ticket. The shared E2E client sends JSON only, so the "
        "multipart PUT that follows cannot be made and a ticket with no upload proves less "
        "than the URL attachment route already does."
    ),
    ("POST", "/api/workspaces/{workspace_id}/attachments"): (
        "completes an upload the ticket route above could not start."
    ),
    ("GET", "/api/workspaces/{workspace_id}/attachments/{attachment_id}/download"): (
        "downloads an attachment the upload routes above could not create."
    ),
    ("GET", "/api/workspaces/{workspace_id}/api-keys"): _API_KEYS,
    ("POST", "/api/workspaces/{workspace_id}/api-keys"): _API_KEYS,
    ("DELETE", "/api/workspaces/{workspace_id}/api-keys/{key_id}"): _API_KEYS,
    ("GET", "/api/workspaces/{workspace_id}/share-links"): _SHARE_LINKS,
    ("POST", "/api/workspaces/{workspace_id}/share-links"): _SHARE_LINKS,
    ("DELETE", "/api/workspaces/{workspace_id}/share-links/{token_hash}"): _SHARE_LINKS,
    ("GET", "/api/shared/{token}"): _SHARED_READS,
    ("GET", "/api/shared/{token}/issue"): _SHARED_READS,
    ("GET", "/api/shared/{token}/view"): _SHARED_READS,
    ("DELETE", "/api/workspaces/{workspace_id}"): _TEARDOWN,
    ("DELETE", "/api/workspaces/{workspace_id}/projects/{project_id}"): _TEARDOWN,
}
"""Routes with no post-deploy coverage, mapped to why a runner cannot drive them.

The GitHub group needs a real App installation and the attachment upload group needs
multipart bytes the shared client does not send. The API key and share link groups
need a credential or a redemption path a run cannot safely create, and the two delete
routes are called in fixture teardown, after the recording is read. None of these is
a route nobody thought about.

The three `/api/mcp` routes were here until `e2e/test_mcp_oauth.py` gave the suite a
way to mint an MCP token: it drives the OAuth flow the deployed authorization server
serves, so the endpoint is now reached with the credential it actually takes rather
than only probed for its 401.
"""
