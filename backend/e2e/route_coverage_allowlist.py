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
        "user. It is also unreachable at the edge today: no gateway prefix covers "
        "/api/invites, so a redeemed invite 404s before any function runs. "
        "tests/common/test_gateway_routing.py allowlists the same route and fails once it "
        "is routed, which is when this entry should be reconsidered too."
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
}
"""Routes with no post-deploy coverage, mapped to why a runner cannot drive them.

The GitHub group needs a real App installation, the attachment upload group needs
multipart bytes the shared client does not send. Both are gaps the browser suite or
a fixture stage could close later; neither is a route nobody thought about.
"""
