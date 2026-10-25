"""Customers and their requests, shared by the planning routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and a request an agent files must pass the same rights a person's does.

Customers are workspace data that carry revenue, so every member who is not a
guest reads them and guests reach none of it. Any such member creates, edits and
merges customers; deleting one is its creator's or a workspace admin's.

A request ties a customer to one issue or one project, with an optional quote
and an important flag. It is filed and edited by whoever may write on the issue's
team or on one of the project's teams, moved only by someone who writes on both
the old target and the new, and removed by its author or a workspace admin. A request is shown only
while its issue or project is still there and visible to the caller, so a request
never reveals work in a team the reader is outside, and a request left behind by
a deleted issue simply stops appearing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Iterable, cast

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.customers import (
    CustomerCreate,
    CustomerMerge,
    CustomerPatch,
    CustomerRead,
    CustomerRequestCreate,
    CustomerRequestPatch,
    CustomerRequestRead,
)
from app.common.change_source import ChangeSource
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.customers import TARGET_KINDS, Customer, CustomerRequest, TargetKind, new_customer_id
from app.common.issue_rules import load_visible_issue
from app.common.planning_rules import (
    forbidden,
    load_readable_project,
    not_found,
    require_project_editor,
    require_workspace_member,
    team_role,
    unprocessable,
    visible_project_teams,
    visible_team_ids,
)


def conflict(message: str) -> HTTPException:
    """A 409 carrying the product's error envelope."""
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"error_code": "CONFLICT", "message": message},
    )


def require_customer_reader(context: AuthzContext) -> None:
    """Hold that the caller is a workspace member who is not a guest, or 403."""
    if context.is_guest:
        raise forbidden()


@dataclass
class Target:
    """The issue or project a request names, as this caller sees it."""

    kind: TargetKind
    target_id: str
    key: str
    title: str
    teams: list[str] = field(default_factory=list)


@dataclass
class Targets:
    """The issues and projects a set of requests names, read once and narrowed to what the caller sees."""

    found: dict[tuple[str, str], Target] = field(default_factory=dict)

    def get(self, request: CustomerRequest) -> Target | None:
        """The visible target of one request, or `None` when it is gone or hidden."""
        return self.found.get((request.target_kind, request.target_id))


def resolve_targets(repositories: Repositories, context: AuthzContext, requests: Iterable[CustomerRequest]) -> Targets:
    """The visible issues and projects the requests name, in one batch read and one projects query."""
    rows = list(requests)
    issue_ids = sorted({row.target_id for row in rows if row.target_kind == "issue"})
    project_ids = {row.target_id for row in rows if row.target_kind == "project"}
    targets = Targets()
    if issue_ids:
        for issue in repositories.issues.get_many(context.workspace_id, issue_ids).values():
            if context.can_see_team(issue.team_id):
                targets.found[("issue", issue.issue_id)] = Target(
                    kind="issue", target_id=issue.issue_id, key=issue.key, title=issue.title, teams=[issue.team_id]
                )
    if project_ids:
        visible = set(visible_team_ids(repositories, context))
        for project in repositories.planning.list_projects(context.workspace_id):
            if project.project_id not in project_ids:
                continue
            teams = visible_project_teams(project, visible)
            if teams:
                targets.found[("project", project.project_id)] = Target(
                    kind="project", target_id=project.project_id, key="", title=project.name, teams=teams
                )
    return targets


def _can_delete_customer(context: AuthzContext, customer: Customer) -> bool:
    """Whether the caller may delete one customer."""
    return context.is_workspace_admin or customer.created_by == context.user_id


def _customer_read(
    context: AuthzContext, customer: Customer, request_count: int, important_count: int = 0
) -> CustomerRead:
    """One customer's response shape, with this caller's rights on it."""
    return CustomerRead(
        customer_id=customer.customer_id,
        workspace_id=customer.workspace_id,
        name=customer.name,
        domains=customer.domains,
        status=customer.status,
        tier=customer.tier,
        owner_id=customer.owner_id,
        revenue=customer.revenue,
        size=customer.size,
        created_by=customer.created_by,
        created_at=customer.created_at,
        updated_at=customer.updated_at,
        request_count=request_count,
        important_count=important_count,
        can_edit=not context.is_guest,
        can_delete=_can_delete_customer(context, customer),
    )


WriterCheck = Callable[[Target], bool]
"""Whether the caller may write on one request's target."""


def _writer_check(repositories: Repositories, context: AuthzContext) -> WriterCheck:
    """A check of write rights on targets that reads each team's membership at most once."""
    roles: dict[str, bool] = {}

    def writes(team_id: str) -> bool:
        if team_id not in roles:
            roles[team_id] = team_role(repositories, context, team_id) is not None
        return roles[team_id]

    def check(target: Target) -> bool:
        return not context.is_guest and any(writes(team_id) for team_id in target.teams)

    return check


def _request_read(
    context: AuthzContext,
    request: CustomerRequest,
    target: Target,
    customer_name: str,
    can_edit: bool = False,
) -> CustomerRequestRead:
    """One request's response shape, with the names a list draws beside it."""
    return CustomerRequestRead(
        request_id=request.request_id,
        workspace_id=request.workspace_id,
        customer_id=request.customer_id,
        customer_name=customer_name,
        target_kind=request.target_kind,
        target_id=request.target_id,
        target_key=target.key,
        target_title=target.title,
        body=request.body,
        important=request.important,
        author_id=request.author_id,
        source=cast("ChangeSource | None", request.source),
        created_at=request.created_at,
        updated_at=request.updated_at,
        can_edit=can_edit,
        can_delete=context.is_workspace_admin or request.author_id == context.user_id,
    )


def _visible_counts(
    repositories: Repositories, context: AuthzContext, requests: list[CustomerRequest] | None = None
) -> tuple[dict[str, int], dict[str, int]]:
    """How many visible requests, and visible important ones, each customer has, from one query."""
    rows = repositories.customers.list_requests(context.workspace_id) if requests is None else requests
    targets = resolve_targets(repositories, context, rows)
    counts: dict[str, int] = {}
    important: dict[str, int] = {}
    for request in rows:
        if targets.get(request) is not None:
            counts[request.customer_id] = counts.get(request.customer_id, 0) + 1
            if request.important:
                important[request.customer_id] = important.get(request.customer_id, 0) + 1
    return counts, important


def _load_customer(repositories: Repositories, context: AuthzContext, customer_id: str) -> Customer:
    """A customer of the caller's workspace, or a 403 for a guest and a 404 when it is not there."""
    require_customer_reader(context)
    customer = repositories.customers.get(context.workspace_id, customer_id)
    if customer is None:
        raise not_found()
    return customer


def _check_owner(repositories: Repositories, context: AuthzContext, owner_id: str | None) -> None:
    """Hold that a named owner is a workspace member, or 422."""
    if owner_id is not None:
        require_workspace_member(repositories, context, owner_id)


def _check_domains_free(
    repositories: Repositories, context: AuthzContext, domains: list[str], *, ignore: Iterable[str] = ()
) -> None:
    """Hold that no other customer already claims one of the domains, or 409."""
    if not domains:
        return
    skipped = set(ignore)
    wanted = set(domains)
    for other in repositories.customers.list_customers(context.workspace_id):
        if other.customer_id in skipped:
            continue
        taken = wanted.intersection(other.domains)
        if taken:
            raise conflict(f"{sorted(taken)[0]} already belongs to {other.name}")


def list_customers(repositories: Repositories, context: AuthzContext) -> list[CustomerRead]:
    """Every customer of the workspace, by name, each with its visible request count."""
    require_customer_reader(context)
    counts, important = _visible_counts(repositories, context)
    customers = repositories.customers.list_customers(context.workspace_id)
    customers.sort(key=lambda row: (row.name.casefold(), row.customer_id))
    return [
        _customer_read(context, row, counts.get(row.customer_id, 0), important.get(row.customer_id, 0))
        for row in customers
    ]


def get_customer(repositories: Repositories, context: AuthzContext, customer_id: str) -> CustomerRead:
    """One customer with its visible request count."""
    customer = _load_customer(repositories, context, customer_id)
    requests = repositories.customers.list_for_customer(context.workspace_id, customer.customer_id)
    counts, important = _visible_counts(repositories, context, requests)
    return _customer_read(
        context, customer, counts.get(customer.customer_id, 0), important.get(customer.customer_id, 0)
    )


def find_customer(repositories: Repositories, context: AuthzContext, reference: str) -> Customer:
    """A customer named by its id, its exact name ignoring case, or one of its domains, or a 404.

    The MCP tools take any of the three, so an agent can say `acme.com` rather
    than look the id up first.
    """
    require_customer_reader(context)
    text = reference.strip()
    if not text:
        raise not_found()
    direct = repositories.customers.get(context.workspace_id, text)
    if direct is not None:
        return direct
    folded = text.casefold()
    customers = repositories.customers.list_customers(context.workspace_id)
    for customer in customers:
        if customer.name.casefold() == folded or folded in customer.domains:
            return customer
    raise not_found()


def create_customer(repositories: Repositories, context: AuthzContext, payload: CustomerCreate) -> CustomerRead:
    """Add a customer to the workspace, as a member who is not a guest."""
    require_customer_reader(context)
    _check_owner(repositories, context, payload.owner_id)
    _check_domains_free(repositories, context, payload.domains)
    now = utc_now()
    customer = Customer(
        workspace_id=context.workspace_id,
        customer_id=new_customer_id(),
        name=payload.name,
        domains=payload.domains,
        status=payload.status,
        tier=payload.tier,
        owner_id=payload.owner_id,
        revenue=payload.revenue,
        size=payload.size,
        created_by=context.user_id,
        created_at=now,
        updated_at=now,
    )
    try:
        repositories.customers.create(customer)
    except ConditionFailed as exc:
        raise conflict("That customer already exists") from exc
    return _customer_read(context, customer, 0)


def update_customer(
    repositories: Repositories, context: AuthzContext, customer_id: str, payload: CustomerPatch
) -> CustomerRead:
    """Edit a customer's fields; a field left out is kept and `null` clears it."""
    existing = _load_customer(repositories, context, customer_id)
    fields = payload.model_dump(exclude_unset=True)
    if "owner_id" in fields:
        _check_owner(repositories, context, fields["owner_id"])
    if "domains" in fields:
        _check_domains_free(repositories, context, fields["domains"], ignore=[existing.customer_id])
    changes = {name: value for name, value in fields.items() if getattr(existing, name) != value}
    if not changes:
        return get_customer(repositories, context, existing.customer_id)
    edited = existing.model_copy(update={**changes, "updated_at": utc_now()})
    try:
        repositories.customers.replace(edited)
    except ConditionFailed as exc:
        raise not_found() from exc
    return get_customer(repositories, context, edited.customer_id)


def delete_customer(repositories: Repositories, context: AuthzContext, customer_id: str) -> None:
    """Delete a customer and every request it made, as its creator or a workspace admin."""
    customer = _load_customer(repositories, context, customer_id)
    if not _can_delete_customer(context, customer):
        raise forbidden()
    repositories.customers.delete(context.workspace_id, customer.customer_id)


def merge_customers(
    repositories: Repositories, context: AuthzContext, customer_id: str, payload: CustomerMerge
) -> CustomerRead:
    """Fold one customer into another and delete it.

    The surviving customer gains the other's requests and domains, and takes its
    status, tier, owner, revenue and size only where it has none of its own, so a merge
    never overwrites what the survivor already says about itself. Deleting the
    merged customer is a delete, so it takes the same right.
    """
    source = _load_customer(repositories, context, customer_id)
    if payload.into_customer_id == source.customer_id:
        raise unprocessable("A customer cannot be merged into itself")
    target = repositories.customers.get(context.workspace_id, payload.into_customer_id)
    if target is None:
        raise not_found()
    if not _can_delete_customer(context, source):
        raise forbidden()
    domains = list(dict.fromkeys([*target.domains, *source.domains]))
    merged = target.model_copy(
        update={
            "domains": domains[:20],
            "status": target.status if target.status is not None else source.status,
            "tier": target.tier if target.tier is not None else source.tier,
            "owner_id": target.owner_id if target.owner_id is not None else source.owner_id,
            "revenue": target.revenue if target.revenue is not None else source.revenue,
            "size": target.size if target.size is not None else source.size,
            "updated_at": utc_now(),
        }
    )
    repositories.customers.move_requests(context.workspace_id, source.customer_id, target.customer_id)
    try:
        repositories.customers.replace(merged)
    except ConditionFailed as exc:
        raise not_found() from exc
    repositories.customers.delete(context.workspace_id, source.customer_id)
    return get_customer(repositories, context, merged.customer_id)


def _load_target(repositories: Repositories, context: AuthzContext, target_kind: str, target_id: str) -> Target:
    """An issue or project the caller may read, or the 404 its own loader gives."""
    if target_kind == "issue":
        issue = load_visible_issue(repositories, context, target_id)
        return Target(kind="issue", target_id=issue.issue_id, key=issue.key, title=issue.title, teams=[issue.team_id])
    if target_kind == "project":
        project, teams = load_readable_project(repositories, context, target_id)
        return Target(kind="project", target_id=project.project_id, key="", title=project.name, teams=teams)
    raise unprocessable(f"target_kind must be one of {', '.join(TARGET_KINDS)}")


def _require_target_writer(repositories: Repositories, context: AuthzContext, target: Target) -> None:
    """Hold that the caller may write on the issue's team or one of the project's teams, or 403."""
    if target.kind == "project":
        require_project_editor(repositories, context, target.teams)
        return
    if team_role(repositories, context, target.teams[0]) is None:
        raise forbidden()


def _names(repositories: Repositories, context: AuthzContext) -> dict[str, str]:
    """Every customer's name by id, from one query."""
    return {row.customer_id: row.name for row in repositories.customers.list_customers(context.workspace_id)}


def _newest_first(rows: list[CustomerRequestRead]) -> list[CustomerRequestRead]:
    """Requests newest first, ties broken by id so the order is stable."""
    return sorted(rows, key=lambda row: (row.created_at, row.request_id), reverse=True)


def list_target_requests(
    repositories: Repositories, context: AuthzContext, target_kind: str, target_id: str
) -> list[CustomerRequestRead]:
    """Every request naming one issue or project the caller may read, newest first."""
    require_customer_reader(context)
    target = _load_target(repositories, context, target_kind, target_id)
    requests = repositories.customers.list_for_target(context.workspace_id, target.kind, target.target_id)
    if not requests:
        return []
    names = _names(repositories, context)
    can_edit = _writer_check(repositories, context)(target)
    return _newest_first(
        [
            _request_read(context, request, target, names[request.customer_id], can_edit)
            for request in requests
            if request.customer_id in names
        ]
    )


def list_customer_requests(
    repositories: Repositories, context: AuthzContext, customer_id: str
) -> list[CustomerRequestRead]:
    """Every request of one customer whose issue or project the caller can see, newest first."""
    customer = _load_customer(repositories, context, customer_id)
    requests = repositories.customers.list_for_customer(context.workspace_id, customer.customer_id)
    targets = resolve_targets(repositories, context, requests)
    writes = _writer_check(repositories, context)
    rows: list[CustomerRequestRead] = []
    for request in requests:
        target = targets.get(request)
        if target is not None:
            rows.append(_request_read(context, request, target, customer.name, writes(target)))
    return _newest_first(rows)


def list_workspace_requests(repositories: Repositories, context: AuthzContext) -> list[CustomerRequestRead]:
    """Every request in the workspace whose issue or project the caller can see, newest first."""
    require_customer_reader(context)
    requests = repositories.customers.list_requests(context.workspace_id)
    targets = resolve_targets(repositories, context, requests)
    names = _names(repositories, context)
    writes = _writer_check(repositories, context)
    rows: list[CustomerRequestRead] = []
    for request in requests:
        target = targets.get(request)
        if target is not None and request.customer_id in names:
            rows.append(_request_read(context, request, target, names[request.customer_id], writes(target)))
    return _newest_first(rows)


def create_request(
    repositories: Repositories,
    context: AuthzContext,
    target_kind: str,
    target_id: str,
    payload: CustomerRequestCreate,
) -> CustomerRequestRead:
    """File a customer's request for an issue or project the caller may write on."""
    require_customer_reader(context)
    target = _load_target(repositories, context, target_kind, target_id)
    _require_target_writer(repositories, context, target)
    customer = repositories.customers.get(context.workspace_id, payload.customer_id)
    if customer is None:
        raise unprocessable(f"No such customer: {payload.customer_id}")
    request = CustomerRequest(
        workspace_id=context.workspace_id,
        request_id=new_customer_id(),
        customer_id=customer.customer_id,
        target_kind=target.kind,
        target_id=target.target_id,
        team_ids=target.teams,
        body=payload.body,
        important=payload.important,
        author_id=context.user_id,
        source=context.source,
        created_at=utc_now(),
    )
    try:
        stored = repositories.customers.add_request(request)
    except ConditionFailed as exc:
        raise conflict("That request already exists") from exc
    return _request_read(context, stored, target, customer.name, True)


def update_request(
    repositories: Repositories,
    context: AuthzContext,
    customer_id: str,
    request_id: str,
    payload: CustomerRequestPatch,
) -> CustomerRequestRead:
    """Edit a request's quote, customer or important flag, or move it to another issue or project.

    The caller must write on the request's current target, and a move also on
    the new one, so a request is never carried into or out of a team the caller
    cannot write in. A target the caller cannot see is the same 404 a read gives.
    """
    customer = _load_customer(repositories, context, customer_id)
    request = repositories.customers.get_request(context.workspace_id, customer.customer_id, request_id)
    if request is None:
        raise not_found()
    current = resolve_targets(repositories, context, [request]).get(request)
    if current is None:
        raise not_found()
    _require_target_writer(repositories, context, current)
    fields = payload.model_dump(exclude_unset=True)
    target = current
    moving = fields.get("target_kind") is not None or fields.get("target_id") is not None
    if moving:
        kind = fields.get("target_kind")
        target_id = fields.get("target_id")
        if kind is None or not target_id:
            raise unprocessable("target_kind and target_id move a request together")
        target = _load_target(repositories, context, kind, target_id)
        if (target.kind, target.target_id) != (current.kind, current.target_id):
            _require_target_writer(repositories, context, target)
    owner = customer
    if fields.get("customer_id") is not None and fields["customer_id"] != customer.customer_id:
        found = repositories.customers.get(context.workspace_id, fields["customer_id"])
        if found is None:
            raise unprocessable(f"No such customer: {fields['customer_id']}")
        owner = found
    changes: dict[str, object] = {}
    if "body" in fields and fields["body"] != request.body:
        changes["body"] = fields["body"]
    if fields.get("important") is not None and fields["important"] != request.important:
        changes["important"] = fields["important"]
    if owner.customer_id != request.customer_id:
        changes["customer_id"] = owner.customer_id
    if (target.kind, target.target_id) != (request.target_kind, request.target_id):
        changes.update({"target_kind": target.kind, "target_id": target.target_id, "team_ids": target.teams})
    if not changes:
        return _request_read(context, request, target, owner.name, True)
    edited = request.model_copy(update={**changes, "updated_at": utc_now()})
    stored = repositories.customers.replace_request(request, edited)
    return _request_read(context, stored, target, owner.name, True)


def delete_request(repositories: Repositories, context: AuthzContext, customer_id: str, request_id: str) -> None:
    """Remove one request, as its author or a workspace admin."""
    customer = _load_customer(repositories, context, customer_id)
    request = repositories.customers.get_request(context.workspace_id, customer.customer_id, request_id)
    if request is None:
        raise not_found()
    targets = resolve_targets(repositories, context, [request])
    if targets.get(request) is None and not context.is_workspace_admin:
        raise not_found()
    if not (context.is_workspace_admin or request.author_id == context.user_id):
        raise forbidden()
    repositories.customers.delete_request(request)
