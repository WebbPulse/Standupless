"""Document templates applied: which ones a project or initiative offers, and filling a new document or update.

Held in `common` because the planning routes and the MCP tools in the
integrations image both start documents and updates from a template. A project
offers the document templates of each of its teams the caller sees, those
teams' visible parents', and the workspace's; an initiative belongs to no team,
so it offers the workspace's alone, which `app.common.initiative_writes` reads
after loading the initiative. The default a project's new document or
update starts from is the first of its teams, in the project's order, that sets
one, so a project shared between teams opens the same way for everyone.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.documents import TITLE_MAX, DocumentCreate
from app.common.api.schemas.planning import UPDATE_BODY_MAX_BYTES
from app.common.db.dynamo.team_templates import DOCUMENT_TEMPLATE, IssueTemplate
from app.common.issue_templates import effective_default, visible_parent_id
from app.common.planning_rules import load_readable_project, unprocessable

UNTITLED = "Untitled"
"""The title a document takes when neither the create nor its template gives one."""

DOCUMENT_DEFAULT = "default_document_template_id"
"""The settings field naming the template a new document starts from."""

UPDATE_DEFAULT = "default_update_template_id"
"""The settings field naming the template a new update starts from."""


@dataclass
class Offer:
    """The document templates one parent offers the caller, and the defaults its composers open with."""

    templates: list[IssueTemplate]
    default_document_template_id: Optional[str] = None
    default_update_template_id: Optional[str] = None

    def find(self, reference: str) -> IssueTemplate:
        """One offered template by id, else by a name only one of them carries, or a 422 naming it.

        A name is matched ignoring case, so an agent may name a template as a
        person sees it in the picker.
        """
        for row in self.templates:
            if row.template_id == reference:
                return row
        wanted = reference.strip().casefold()
        named = [row for row in self.templates if row.name.casefold() == wanted]
        if len(named) == 1:
            return named[0]
        if named:
            raise unprocessable(f"More than one template is named {reference}; give its id")
        raise unprocessable(f"No such template: {reference}")


def offer(repositories: Repositories, context: AuthzContext, teams: list[str]) -> Offer:
    """The document templates offered under a parent on `teams`, the caller's visible teams of it.

    An initiative passes no teams and is offered the workspace's templates only.
    """
    workspace_id = context.workspace_id
    rows: dict[str, IssueTemplate] = {}
    scopes: list[str] = []
    for team_id in teams:
        scopes.append(team_id)
        parent_id = visible_parent_id(repositories, context, team_id)
        if parent_id is not None:
            scopes.append(parent_id)
    for scope in dict.fromkeys(scopes):
        for row in repositories.team_config.list_team_templates(workspace_id, scope, kind=DOCUMENT_TEMPLATE):
            rows.setdefault(row.template_id, row)
    for row in repositories.team_config.list_workspace_templates(workspace_id, kind=DOCUMENT_TEMPLATE):
        rows.setdefault(row.template_id, row)
    templates = list(rows.values())
    return Offer(
        templates=templates,
        default_document_template_id=_default(repositories, context, teams, templates, DOCUMENT_DEFAULT),
        default_update_template_id=_default(repositories, context, teams, templates, UPDATE_DEFAULT),
    )


def _default(
    repositories: Repositories, context: AuthzContext, teams: list[str], templates: list[IssueTemplate], field: str
) -> Optional[str]:
    """The first default of `field` one of the teams sets, in the project's team order."""
    for team_id in teams:
        chosen = effective_default(repositories, context, team_id, templates, DOCUMENT_TEMPLATE, field)
        if chosen is not None:
            return chosen
    return None


def project_offer(repositories: Repositories, context: AuthzContext, project_id: str) -> Offer:
    """The document templates a project the caller reads offers, or the project's 404."""
    _, teams = load_readable_project(repositories, context, project_id)
    return offer(repositories, context, teams)


def fill_document(
    repositories: Repositories, context: AuthzContext, teams: list[str], payload: DocumentCreate
) -> DocumentCreate:
    """A document create with its template's title and body wherever it left one out.

    Without a template the title is required. With one, a left out title takes
    the template's, else `UNTITLED`, so a template that only sets a body still
    starts a document.
    """
    if not payload.template_id:
        if not payload.title:
            raise unprocessable("title must not be blank")
        return payload.model_copy(update={"body": payload.body or ""})
    template = offer(repositories, context, teams).find(payload.template_id)
    title = payload.title or (template.title or "").strip()[:TITLE_MAX].strip() or UNTITLED
    body = payload.body if payload.body is not None else (template.body or "")
    return payload.model_copy(update={"title": title, "body": body})


def fill_update_body(
    repositories: Repositories,
    context: AuthzContext,
    teams: list[str],
    body: Optional[str],
    template_id: Optional[str],
) -> str:
    """The body a new update posts: the one sent, else its template's, held to the update rules.

    A template is checked even when a body is sent, so a stale id is caught
    rather than silently ignored.
    """
    template = offer(repositories, context, teams).find(template_id) if template_id else None
    if body is not None:
        return body
    if template is None:
        raise unprocessable("body must not be blank")
    filled = template.body or ""
    if not filled.strip():
        raise unprocessable("The template has no body; write the update or choose another template")
    if len(filled.encode("utf-8")) > UPDATE_BODY_MAX_BYTES:
        raise unprocessable(f"The template's body is over the {UPDATE_BODY_MAX_BYTES} byte cap an update takes")
    return filled
