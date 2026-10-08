"""The MCP tools for whole-workspace exports.

They run the same `app.common.workspace_export` functions as the workspaces
export routes and check the same workspace admin capability and scopes, so an
agent can start a backup and fetch its download link exactly as an admin can in
the app.
"""

from __future__ import annotations

from typing import Any

from app.common import workspace_export
from app.common.api.dependencies.authz import Capability, check_capability
from app.domains.integrations.mcp.team_tools import boolean
from app.domains.integrations.mcp.toolkit import NOT_VISIBLE, Tool, ToolCall, object_schema, string
from app.domains.integrations.mcp.transport import ToolError


def _job_json(job: workspace_export.ExportJob, download: workspace_export.Download | None = None) -> dict[str, Any]:
    """One export as the tools answer it, without the requester's authorization snapshot."""
    row = job.model_dump(mode="json", exclude={"requester_role", "team_ids", "private_team_ids"})
    row["download_url"] = download.url if download is not None else None
    row["download_expires_at"] = download.expires_at.isoformat() if download is not None else None
    return row


def _export_workspace(call: ToolCall) -> Any:
    """Queue an export of the whole workspace."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    include_emails = call.optional("include_emails", True)
    try:
        job = workspace_export.start_export(call.context, include_emails=bool(include_emails))
    except (workspace_export.ExportUnavailable, workspace_export.ExportInProgress) as exc:
        raise ToolError(str(exc)) from exc
    return _job_json(job, workspace_export.download_for(job))


def _get_workspace_export(call: ToolCall) -> Any:
    """One export, with a fresh download link once it is ready."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    try:
        job = workspace_export.load_job(call.context.workspace_id, str(call.require("export_id")).strip())
    except workspace_export.ExportUnavailable as exc:
        raise ToolError(str(exc)) from exc
    if job is None:
        raise ToolError(NOT_VISIBLE)
    return _job_json(job, workspace_export.download_for(job))


def _list_workspace_exports(call: ToolCall) -> Any:
    """The workspace's most recent exports, newest first."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    try:
        jobs = workspace_export.list_jobs(call.context.workspace_id)
    except workspace_export.ExportUnavailable as exc:
        raise ToolError(str(exc)) from exc
    return {"exports": [_job_json(job) for job in jobs]}


EXPORT_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="export_workspace",
        description=(
            "Start an export of the whole workspace as a zip of NDJSON files: teams, members, statuses, labels, "
            "issues with relations, comments, attachments, projects with milestones and updates, cycles, views "
            "and releases. Runs in the background; poll get_workspace_export for the download link, or wait for "
            "the inbox notice. Refused while another export is running. Needs workspace owner or admin."
        ),
        scopes=("settings:write", "admin"),
        schema=object_schema(
            {"include_emails": boolean("false masks member email addresses in the bundle; defaults to true")}
        ),
        handler=_export_workspace,
    ),
    Tool(
        name="get_workspace_export",
        description=(
            "One workspace export's status and row counts, with a download link valid for 15 minutes once it "
            "is ready. Needs workspace owner or admin."
        ),
        scopes=("settings:read", "admin"),
        schema=object_schema(
            {"export_id": string("The export_id export_workspace answered")},
            required=("export_id",),
        ),
        handler=_get_workspace_export,
    ),
    Tool(
        name="list_workspace_exports",
        description="The workspace's most recent exports, newest first. Needs workspace owner or admin.",
        scopes=("settings:read", "admin"),
        schema=object_schema({}),
        handler=_list_workspace_exports,
    ),
)
