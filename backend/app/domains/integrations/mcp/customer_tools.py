"""The MCP tools for customers and the requests they make for issues and projects.

Every tool runs the same `app.common.customers` path the customer routes do, so
the rights and the visibility of requests match HTTP exactly. A customer is
named by its id, its exact name or one of its domains, an issue by its id or key,
and a project by its id or a unique name.
"""

from __future__ import annotations

from typing import Any

from app.common.api.schemas.customers import (
    CustomerCreate,
    CustomerMerge,
    CustomerPatch,
    CustomerRead,
    CustomerRequestCreate,
    CustomerRequestPatch,
    CustomerRequestRead,
)
from app.common.customers import (
    create_customer,
    create_request,
    delete_customer,
    delete_request,
    find_customer,
    list_customer_requests,
    list_customers,
    list_target_requests,
    list_workspace_requests,
    merge_customers,
    update_customer,
    update_request,
)
from app.common.db.dynamo.customers import CUSTOMER_STATUSES
from app.domains.integrations.mcp.toolkit import (
    Tool,
    ToolCall,
    issue_ref,
    nullable,
    nullable_enum,
    object_schema,
    project_id_ref,
    string,
    string_list,
    user_ref,
)
from app.domains.integrations.mcp.transport import ToolError

CUSTOMER_REFERENCE = "The customer: id, exact name or one of its domains"

CUSTOMER_FIELDS = ("name", "domains", "status", "tier", "owner_id", "revenue", "size")


def _amount(description: str) -> dict[str, Any]:
    """A whole, non-negative number property that also takes null, which clears it."""
    return {"type": ["integer", "null"], "minimum": 0, "description": description}


def _customer_json(customer: CustomerRead) -> dict[str, Any]:
    """One customer as the tools answer it."""
    return {
        "customer_id": customer.customer_id,
        "name": customer.name,
        "domains": customer.domains,
        "status": customer.status,
        "tier": customer.tier,
        "owner_id": customer.owner_id,
        "revenue": customer.revenue,
        "size": customer.size,
        "request_count": customer.request_count,
        "important_count": customer.important_count,
        "created_by": customer.created_by,
        "created_at": customer.created_at.isoformat(),
        "updated_at": customer.updated_at.isoformat(),
    }


def _request_json(request: CustomerRequestRead) -> dict[str, Any]:
    """One customer request as the tools answer it."""
    return {
        "request_id": request.request_id,
        "customer_id": request.customer_id,
        "customer_name": request.customer_name,
        "target_kind": request.target_kind,
        "target_id": request.target_id,
        "target_key": request.target_key,
        "target_title": request.target_title,
        "body": request.body,
        "important": request.important,
        "author_id": request.author_id,
        "created_at": request.created_at.isoformat(),
    }


def _customer_id(call: ToolCall, name: str = "customer_id") -> str:
    """The id of the customer one argument names."""
    return find_customer(call.repositories, call.context, str(call.require(name))).customer_id


def _fields(call: ToolCall) -> dict[str, Any]:
    """The customer fields a create or update call named, with the owner resolved to a user id."""
    fields: dict[str, Any] = {}
    for name in CUSTOMER_FIELDS:
        if call.present(name):
            fields[name] = call.arguments[name]
    owner = fields.get("owner_id")
    if owner is not None:
        fields["owner_id"] = user_ref(call, owner)
    return fields


def _target(call: ToolCall) -> tuple[str, str]:
    """The issue or project a request call names, exactly one of the two."""
    issue = call.optional("issue_id")
    project = call.optional("project_id")
    if bool(issue) == bool(project):
        raise ToolError("give exactly one of issue_id or project_id")
    if issue:
        return "issue", issue_ref(call, issue).issue_id
    return "project", project_id_ref(call, project)


def _list_customers(call: ToolCall) -> Any:
    """Every customer of the workspace by name, with request counts."""
    return {"customers": [_customer_json(row) for row in list_customers(call.repositories, call.context)]}


def _create_customer(call: ToolCall) -> Any:
    """Add a customer."""
    payload = CustomerCreate.model_validate({**_fields(call), "name": call.require("name")})
    return _customer_json(create_customer(call.repositories, call.context, payload))


def _update_customer(call: ToolCall) -> Any:
    """Edit a customer's fields."""
    customer_id = _customer_id(call)
    payload = CustomerPatch.model_validate(_fields(call))
    return _customer_json(update_customer(call.repositories, call.context, customer_id, payload))


def _merge_customers(call: ToolCall) -> Any:
    """Fold one customer into another."""
    source = _customer_id(call)
    into = _customer_id(call, "into_customer_id")
    payload = CustomerMerge(into_customer_id=into)
    return _customer_json(merge_customers(call.repositories, call.context, source, payload))


def _delete_customer(call: ToolCall) -> Any:
    """Delete a customer with its requests."""
    customer_id = _customer_id(call)
    delete_customer(call.repositories, call.context, customer_id)
    return {"deleted": True, "customer_id": customer_id}


def _create_customer_request(call: ToolCall) -> Any:
    """File a customer's request for an issue or a project."""
    kind, target_id = _target(call)
    payload = CustomerRequestCreate.model_validate(
        {
            "customer_id": _customer_id(call),
            "body": call.optional("body") or "",
            "important": bool(call.optional("important", False)),
        }
    )
    return _request_json(create_request(call.repositories, call.context, kind, target_id, payload))


def _update_customer_request(call: ToolCall) -> Any:
    """Edit a customer request's quote, customer or important flag, or move it to another issue or project."""
    customer_id = _customer_id(call)
    request_id = str(call.require("request_id"))
    fields: dict[str, Any] = {}
    if call.present("body"):
        fields["body"] = call.arguments["body"]
    if call.optional("important") is not None:
        fields["important"] = bool(call.arguments["important"])
    if call.optional("new_customer_id"):
        fields["customer_id"] = _customer_id(call, "new_customer_id")
    if call.optional("issue_id") or call.optional("project_id"):
        kind, target_id = _target(call)
        fields["target_kind"] = kind
        fields["target_id"] = target_id
    payload = CustomerRequestPatch.model_validate(fields)
    return _request_json(update_request(call.repositories, call.context, customer_id, request_id, payload))


def _list_customer_requests(call: ToolCall) -> Any:
    """Requests of one customer, one issue or one project, or of the whole workspace when none is named."""
    named = [name for name in ("customer_id", "issue_id", "project_id") if call.optional(name)]
    if len(named) > 1:
        raise ToolError("give at most one of customer_id, issue_id or project_id")
    if not named:
        rows = list_workspace_requests(call.repositories, call.context)
    elif named[0] == "customer_id":
        rows = list_customer_requests(call.repositories, call.context, _customer_id(call))
    else:
        kind, target_id = _target(call)
        rows = list_target_requests(call.repositories, call.context, kind, target_id)
    return {"requests": [_request_json(row) for row in rows]}


def _delete_customer_request(call: ToolCall) -> Any:
    """Remove one customer request."""
    customer_id = _customer_id(call)
    request_id = str(call.require("request_id"))
    delete_request(call.repositories, call.context, customer_id, request_id)
    return {"deleted": True, "request_id": request_id}


CUSTOMER_PROPERTIES: dict[str, Any] = {
    "status": nullable_enum(CUSTOMER_STATUSES, "Where the customer stands; null clears it"),
    "domains": string_list("Domains such as acme.com; the list replaces the current one"),
    "tier": nullable("A short tier label such as Enterprise; null clears it"),
    "owner_id": nullable("The workspace member who owns the account: me, id or email; null clears it"),
    "revenue": _amount("Annual revenue in whole currency units; null clears it"),
    "size": _amount("Headcount; null clears it"),
}


CUSTOMER_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_customers",
        description="Every customer of the workspace by name, with how many requests each has made.",
        scopes=("projects:read",),
        schema=object_schema({}),
        handler=_list_customers,
    ),
    Tool(
        name="create_customer",
        description="Add a customer: a company the workspace builds for, with optional domains, tier, owner, "
        "revenue and size.",
        scopes=("projects:write",),
        schema=object_schema({"name": string("The customer name"), **CUSTOMER_PROPERTIES}, required=("name",)),
        handler=_create_customer,
    ),
    Tool(
        name="update_customer",
        description="Edit a customer. Only the fields named are written.",
        scopes=("projects:write",),
        schema=object_schema(
            {
                "customer_id": string(CUSTOMER_REFERENCE),
                "name": string("The new name"),
                **CUSTOMER_PROPERTIES,
            },
            required=("customer_id",),
        ),
        handler=_update_customer,
    ),
    Tool(
        name="merge_customers",
        description="Fold one customer into another: its requests and domains move over, and it is deleted.",
        scopes=("projects:write",),
        schema=object_schema(
            {
                "customer_id": string(f"{CUSTOMER_REFERENCE}, which goes away"),
                "into_customer_id": string(f"{CUSTOMER_REFERENCE}, which survives"),
            },
            required=("customer_id", "into_customer_id"),
        ),
        handler=_merge_customers,
        destructive=True,
    ),
    Tool(
        name="delete_customer",
        description="Permanently delete a customer and every request it made, as its creator or an admin.",
        scopes=("projects:write",),
        schema=object_schema({"customer_id": string(CUSTOMER_REFERENCE)}, required=("customer_id",)),
        handler=_delete_customer,
        destructive=True,
    ),
    Tool(
        name="create_customer_request",
        description="Record that a customer asked for an issue or a project, with an optional quote of what they said.",
        scopes=("projects:write",),
        schema=object_schema(
            {
                "customer_id": string(CUSTOMER_REFERENCE),
                "issue_id": string("The issue: id or key such as ABC-12. Give this or project_id"),
                "project_id": string("The project: id or name. Give this or issue_id"),
                "body": string("What the customer said, quoted"),
                "important": {"type": "boolean", "description": "Mark the request important, default false"},
            },
            required=("customer_id",),
        ),
        handler=_create_customer_request,
    ),
    Tool(
        name="update_customer_request",
        description="Edit a customer request: its quote, its customer or its important flag, or move it to "
        "another issue or project. Only the fields named are written.",
        scopes=("projects:write",),
        schema=object_schema(
            {
                "customer_id": string(f"{CUSTOMER_REFERENCE}, which made the request now"),
                "request_id": string("The request id"),
                "body": nullable("The new quote; null or empty clears it"),
                "important": {"type": "boolean", "description": "true marks the request important, false unmarks it"},
                "new_customer_id": string(f"{CUSTOMER_REFERENCE}, to hand the request to"),
                "issue_id": string("Move the request to this issue: id or key such as ABC-12"),
                "project_id": string("Move the request to this project: id or name"),
            },
            required=("customer_id", "request_id"),
        ),
        handler=_update_customer_request,
    ),
    Tool(
        name="list_customer_requests",
        description="Customer requests, newest first: one customer's, one issue's or one project's, or the "
        "whole workspace's when none is named.",
        scopes=("projects:read",),
        schema=object_schema(
            {
                "customer_id": string(CUSTOMER_REFERENCE),
                "issue_id": string("The issue: id or key such as ABC-12"),
                "project_id": string("The project: id or name"),
            }
        ),
        handler=_list_customer_requests,
    ),
    Tool(
        name="delete_customer_request",
        description="Remove one customer request, as its author or an admin.",
        scopes=("projects:write",),
        schema=object_schema(
            {"customer_id": string(CUSTOMER_REFERENCE), "request_id": string("The request id")},
            required=("customer_id", "request_id"),
        ),
        handler=_delete_customer_request,
        destructive=True,
    ),
)
