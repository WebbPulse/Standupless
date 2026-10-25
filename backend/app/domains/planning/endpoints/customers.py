"""Customer routes: the workspace's customers and the requests they make for issues and projects.

A customer is reached by its own id under the workspace. A request is filed and
listed through the issue or project it names, listed again under its customer,
and edited, moved and removed through its customer. The rules live in `app.common.customers`, which
the MCP tools share.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.customers import (
    CustomerCreate,
    CustomerListRead,
    CustomerMerge,
    CustomerPatch,
    CustomerRead,
    CustomerRequestCreate,
    CustomerRequestListRead,
    CustomerRequestPatch,
    CustomerRequestRead,
)
from app.common.customers import (
    create_customer,
    create_request,
    delete_customer,
    delete_request,
    get_customer,
    list_customer_requests,
    list_customers,
    list_target_requests,
    list_workspace_requests,
    merge_customers,
    update_customer,
    update_request,
)

router = APIRouter()


@router.get("/{workspace_id}/customers", response_model=CustomerListRead)
def list_all_customers(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
) -> Any:
    """Every customer of the workspace by name, each with its visible request count."""
    return CustomerListRead(items=list_customers(repositories, context), next_cursor=None)


@router.post("/{workspace_id}/customers", response_model=CustomerRead, status_code=status.HTTP_201_CREATED)
def add_customer(
    payload: CustomerCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
) -> CustomerRead:
    """Add a customer, as a workspace member who is not a guest."""
    return create_customer(repositories, context, payload)


@router.get("/{workspace_id}/customers/requests", response_model=CustomerRequestListRead)
def list_all_requests(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
) -> Any:
    """Every request whose issue or project the caller can see, newest first.

    A list grouped by customer reads this once to place each issue under every
    customer that asked for it. Declared before `/customers/{customer_id}` so
    `requests` is not swallowed as an id.
    """
    return CustomerRequestListRead(items=list_workspace_requests(repositories, context), next_cursor=None)


@router.get("/{workspace_id}/customers/{customer_id}", response_model=CustomerRead)
def read_customer(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    customer_id: Annotated[str, Path()],
) -> CustomerRead:
    """One customer with its visible request count."""
    return get_customer(repositories, context, customer_id)


@router.patch("/{workspace_id}/customers/{customer_id}", response_model=CustomerRead)
def edit_customer(
    payload: CustomerPatch,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    customer_id: Annotated[str, Path()],
) -> CustomerRead:
    """Edit a customer; a field left out is kept and `null` clears it."""
    return update_customer(repositories, context, customer_id, payload)


@router.delete("/{workspace_id}/customers/{customer_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_customer(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    customer_id: Annotated[str, Path()],
) -> Response:
    """Delete a customer with its requests, as its creator or a workspace admin."""
    delete_customer(repositories, context, customer_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{workspace_id}/customers/{customer_id}/merge", response_model=CustomerRead)
def merge_customer(
    payload: CustomerMerge,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    customer_id: Annotated[str, Path()],
) -> CustomerRead:
    """Fold this customer into another, moving its requests and domains, and answer the survivor."""
    return merge_customers(repositories, context, customer_id, payload)


@router.get("/{workspace_id}/customers/{customer_id}/requests", response_model=CustomerRequestListRead)
def list_requests_of_customer(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    customer_id: Annotated[str, Path()],
) -> Any:
    """A customer's requests whose issue or project the caller can see, newest first."""
    return CustomerRequestListRead(items=list_customer_requests(repositories, context, customer_id), next_cursor=None)


@router.patch(
    "/{workspace_id}/customers/{customer_id}/requests/{request_id}",
    response_model=CustomerRequestRead,
)
def edit_request(
    payload: CustomerRequestPatch,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    customer_id: Annotated[str, Path()],
    request_id: Annotated[str, Path()],
) -> CustomerRequestRead:
    """Edit a request's quote, customer or important flag, or move it to another issue or project."""
    return update_request(repositories, context, customer_id, request_id, payload)


@router.delete(
    "/{workspace_id}/customers/{customer_id}/requests/{request_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_request(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    customer_id: Annotated[str, Path()],
    request_id: Annotated[str, Path()],
) -> Response:
    """Remove one request, as its author or a workspace admin."""
    delete_request(repositories, context, customer_id, request_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{workspace_id}/issues/{issue_id}/customer-requests", response_model=CustomerRequestListRead)
def list_issue_requests(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    issue_id: Annotated[str, Path()],
) -> Any:
    """The customer requests naming one issue, newest first."""
    return CustomerRequestListRead(
        items=list_target_requests(repositories, context, "issue", issue_id), next_cursor=None
    )


@router.post(
    "/{workspace_id}/issues/{issue_id}/customer-requests",
    response_model=CustomerRequestRead,
    status_code=status.HTTP_201_CREATED,
)
def add_issue_request(
    payload: CustomerRequestCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    issue_id: Annotated[str, Path()],
) -> CustomerRequestRead:
    """File a customer's request for an issue, as a writer on its team."""
    return create_request(repositories, context, "issue", issue_id, payload)


@router.get("/{workspace_id}/projects/{project_id}/customer-requests", response_model=CustomerRequestListRead)
def list_project_requests(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
) -> Any:
    """The customer requests naming one project, newest first."""
    return CustomerRequestListRead(
        items=list_target_requests(repositories, context, "project", project_id), next_cursor=None
    )


@router.post(
    "/{workspace_id}/projects/{project_id}/customer-requests",
    response_model=CustomerRequestRead,
    status_code=status.HTTP_201_CREATED,
)
def add_project_request(
    payload: CustomerRequestCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
) -> CustomerRequestRead:
    """File a customer's request for a project, as a writer on one of its teams."""
    return create_request(repositories, context, "project", project_id, payload)
