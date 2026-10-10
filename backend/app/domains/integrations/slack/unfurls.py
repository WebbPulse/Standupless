"""Issue previews in Slack: the unfurl of a pasted issue link and the card a command shows.

An unfurl is seen by everyone in the channel whoever pasted the link, so only an
issue of a non private team of the workspace the Slack team is bound to is
previewed, and a link to anything else is left as Slack shows it. The card says
the issue's key, title, team, status and assignee, all escaped for mrkdwn.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Mapping
from urllib.parse import unquote, urlsplit

from app.common.api.dependencies.repositories import Repositories
from app.common.core.config import settings
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.slack import SlackInstallation
from app.common.issue_keys import display_key
from app.common.issue_move import find_issue_by_number
from app.domains.integrations.channels.messages import clip, slack_escape
from app.domains.integrations.outbound.payloads import Links
from app.domains.integrations.slack import install
from app.domains.integrations.slack.api import SlackError

_log = logging.getLogger(__name__)

ISSUE_KEY = re.compile(r"^([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,9})$")

ISSUE_PATH = re.compile(r"^/w/([^/]+)/issues/([^/?#]+)/?$")

MAX_UNFURLS = 5


def split_key(key: str) -> tuple[str, int] | None:
    """The prefix and number of an issue key such as `ABC-12`, or `None`."""
    match = ISSUE_KEY.match(key.strip())
    if match is None:
        return None
    return match.group(1).upper(), int(match.group(2))


def issue_by_key(repositories: Repositories, workspace_id: str, key: str) -> Issue | None:
    """The live issue a key names in one workspace, following a move, or `None`."""
    parts = split_key(key)
    if parts is None:
        return None
    team = repositories.teams.get_by_key_prefix(workspace_id, parts[0])
    if team is None:
        return None
    issue = find_issue_by_number(repositories, workspace_id, team.team_id, parts[1])
    if issue is None or issue.archived_at is not None:
        return None
    return issue


def issue_blocks(repositories: Repositories, issue: Issue) -> list[dict[str, Any]]:
    """The Block Kit card for one issue."""
    workspace_id = issue.workspace_id
    key = display_key(repositories.teams, workspace_id, issue.team_id, issue.key)
    url = Links(repositories, workspace_id).issue(key)
    team = repositories.teams.get(workspace_id, issue.team_id)
    status = repositories.team_config.get_status(workspace_id, issue.team_id, issue.status_id)
    details = [team.name if team is not None else "", status.name if status is not None else ""]
    if issue.assignee_id:
        assignee = repositories.users.get(issue.assignee_id)
        if assignee is not None and assignee.display_name:
            details.append(assignee.display_name)
    else:
        details.append("Unassigned")
    line = "  |  ".join(slack_escape(part) for part in details if part)
    heading = f"*<{url}|{slack_escape(key)} {slack_escape(clip(issue.title, 150))}>*"
    blocks: list[dict[str, Any]] = [{"type": "section", "text": {"type": "mrkdwn", "text": heading}}]
    if line:
        blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": line}]})
    return blocks


def _key_in(url: str, slug: str) -> str:
    """The issue key an issue link of this environment and workspace carries, or an empty string."""
    parts = urlsplit(url)
    expected = urlsplit(settings.frontend_base_url)
    if parts.scheme not in ("https", "http") or parts.netloc.lower() != expected.netloc.lower():
        return ""
    match = ISSUE_PATH.match(parts.path)
    if match is None or unquote(match.group(1)) != slug:
        return ""
    return unquote(match.group(2))


def unfurls_for(repositories: Repositories, workspace_id: str, links: list[Mapping[str, Any]]) -> dict[str, Any]:
    """The `unfurls` map for the links of one `link_shared` event that are previewable issues."""
    workspace = repositories.workspaces.get(workspace_id)
    if workspace is None:
        return {}
    private = set(repositories.memberships.list_private_team_ids(workspace_id))
    found: dict[str, Any] = {}
    for link in links[:MAX_UNFURLS]:
        url = str(link.get("url", "")) if isinstance(link, Mapping) else ""
        key = _key_in(url, workspace.slug) if url else ""
        issue = issue_by_key(repositories, workspace_id, key) if key else None
        if issue is None or issue.team_id in private:
            continue
        found[url] = {"blocks": issue_blocks(repositories, issue)}
    return found


def unfurl(repositories: Repositories, installation: SlackInstallation, event: Mapping[str, Any]) -> int:
    """Answer one `link_shared` event with previews, reporting how many links were unfurled."""
    links = event.get("links") or []
    if not isinstance(links, list):
        return 0
    found = unfurls_for(repositories, installation.workspace_id, links)
    if not found:
        return 0
    payload: dict[str, Any] = {"unfurls": found}
    if event.get("unfurl_id") and event.get("source"):
        payload["unfurl_id"] = str(event["unfurl_id"])
        payload["source"] = str(event["source"])
    else:
        payload["channel"] = str(event.get("channel", ""))
        payload["ts"] = str(event.get("message_ts", ""))
    try:
        install.call(installation, "chat.unfurl", payload)
    except (SlackError, install.BotUnavailable) as error:
        _log.info(
            "Slack refused an unfurl.",
            extra={"event": "integrations.slack.unfurl_failed", "reason": getattr(error, "code", "unreadable")},
        )
        return 0
    return len(found)
