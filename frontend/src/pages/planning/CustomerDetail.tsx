/**
 * One customer's page: its status and fields in a properties column, and every
 * request it made, newest first, each linking to the issue or project asked
 * for, with the important ones counted. Each request's menu marks, edits or
 * moves it, and edit, merge and delete sit in the header menu for whoever may
 * run them.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import {
  LuBox,
  LuChevronRight,
  LuCircleAlert,
  LuEllipsis,
  LuGitMerge,
  LuPencil,
  LuSquareDot,
  LuTrash2,
} from 'react-icons/lu';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  deleteCustomer,
  deleteCustomerRequest,
  getCustomer,
  listCustomerRequests,
  updateCustomer,
} from '../../api/customers';
import CustomerDialog from '../../components/customers/CustomerDialog';
import CustomerRequestRow from '../../components/customers/CustomerRequestRow';
import { CustomerStatusPicker } from '../../components/customers/CustomerStatusPicker';
import { CustomerTierPicker } from '../../components/customers/CustomerTierPicker';
import MergeCustomerDialog from '../../components/customers/MergeCustomerDialog';
import { ErrorAlert } from '../../components/ui/alert';
import Avatar from '../../components/ui/avatar';
import Button, { IconButton } from '../../components/ui/button';
import Dialog from '../../components/ui/dialog';
import EmptyState from '../../components/ui/empty-state';
import Menu, { MenuItem, MenuSeparator } from '../../components/ui/menu';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useCustomerRequestActions } from '../../hooks/useCustomerRequestActions';
import { useCustomerFields } from '../../hooks/useCustomerFields';
import { useCustomers } from '../../hooks/useCustomers';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceMembers } from '../../hooks/useWorkspaceMembers';
import { revenueLabel, sizeLabel } from '../../lib/customerDisplay';
import { errorMessage } from '../../lib/errors';
import { personAvatar, personLabel } from '../../lib/issuePeople';
import {
  customerPath,
  customersPath,
  issuePath,
  projectPath,
} from '../../lib/paths';
import {
  customerKey,
  customerRequestsKey,
  customersKey,
} from '../../lib/queryKeys';
import { showToast } from '../../lib/toast';
import type {
  CustomerRead,
  CustomerPatch,
  CustomerRequestRead,
} from '../../types/Api';

/** How often the customer and its requests re-read. */
const POLL_MS = 60000;

/** One labelled value in the properties column. */
const Property: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-start gap-2 py-1 text-sm">
    <dt className="text-xs leading-5 text-text-faint">{label}</dt>
    <dd className="min-w-0 leading-5 text-text">{children}</dd>
  </div>
);

/** The quiet text an unset property shows. */
const Unset: React.FC<{ label: string }> = ({ label }) => (
  <span className="text-text-faint">{label}</span>
);

/** One customer with its requests. */
export const CustomerDetail: React.FC = () => {
  const { customerId = '' } = useParams<{ customerId: string }>();
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const auth = useQueryAuth();
  const slug = workspace?.slug ?? '';
  const workspaceId = workspace?.id ?? '';
  const isMember = workspace !== null && workspace.role !== 'guest';
  const enabled = isMember && workspaceId !== '' && customerId !== '';

  const detailKey = customerKey(workspaceId, customerId);
  const requestsKey = customerRequestsKey(workspaceId, customerId);
  const detail = usePolledQuery(
    ({ signal }) => getCustomer(workspaceId, customerId, signal),
    { intervalMs: POLL_MS, enabled, queryKey: detailKey, auth }
  );
  const requests = usePolledQuery(
    ({ signal }) => listCustomerRequests(workspaceId, customerId, signal),
    { intervalMs: POLL_MS, enabled, queryKey: requestsKey, auth }
  );
  const { customers } = useCustomers(workspaceId, isMember);
  const { statuses, tiers } = useCustomerFields(workspaceId, isMember);
  const members = useWorkspaceMembers(workspaceId, isMember);

  const [isEditing, setIsEditing] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const requestActions = useCustomerRequestActions(workspaceId);

  const customer: CustomerRead | null = detail.data ?? null;
  const rows: CustomerRequestRead[] = requests.data ?? [];

  const refresh = (): void => {
    invalidateQueries(detailKey);
    invalidateQueries(requestsKey);
    invalidateQueries(customersKey(workspaceId));
  };

  const crumbs = (
    <span className="hidden min-w-0 shrink items-center gap-1 text-sm text-text-muted sm:inline-flex">
      <Link
        to={customersPath(slug)}
        className="shrink-0 rounded-xs hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
      >
        Customers
      </Link>
      <LuChevronRight
        className="h-3.5 w-3.5 shrink-0 text-text-faint"
        aria-hidden="true"
      />
    </span>
  );

  if (!isMember) {
    return (
      <WorkspaceShell title="Customer" leading={crumbs}>
        <EmptyState message="Customers are open to workspace members, not guests." />
      </WorkspaceShell>
    );
  }

  if (customer === null) {
    return (
      <WorkspaceShell
        title={detail.error === null ? 'Customer' : 'Customer not found'}
        leading={crumbs}
      >
        {detail.error === null ? (
          <SkeletonRows label="Loading customer" />
        ) : (
          <>
            <ErrorAlert
              message={errorMessage(
                detail.error,
                'Could not load this customer.'
              )}
            />
            <EmptyState message="That customer does not exist, or it was merged or deleted." />
          </>
        )}
      </WorkspaceShell>
    );
  }

  const owner = members.find((person) => person.user_id === customer.owner_id);
  const revenue = revenueLabel(customer.revenue);
  const size = sizeLabel(customer.size);

  const removeRequest = (request: CustomerRequestRead): void => {
    deleteCustomerRequest(
      workspaceId,
      request.customer_id,
      request.request_id
    ).then(
      () => {
        refresh();
        showToast('Removed the request');
      },
      (failure: unknown) => {
        showToast(
          errorMessage(failure, 'Could not remove that request.'),
          'error'
        );
      }
    );
  };

  const change = (patch: CustomerPatch, failed: string): void => {
    updateCustomer(workspaceId, customer.customer_id, patch).then(
      () => {
        refresh();
      },
      (failure: unknown) => {
        showToast(errorMessage(failure, failed), 'error');
      }
    );
  };

  const remove = (): void => {
    setIsDeleting(false);
    deleteCustomer(workspaceId, customer.customer_id).then(
      () => {
        invalidateQueries(customersKey(workspaceId));
        showToast(`Deleted ${customer.name}`);
        void navigate(customersPath(slug));
      },
      (failure: unknown) => {
        showToast(
          errorMessage(failure, 'Could not delete that customer.'),
          'error'
        );
      }
    );
  };

  const actions =
    customer.can_edit || customer.can_delete ? (
      <Menu
        label={`${customer.name} actions`}
        align="end"
        trigger={(trigger) => (
          <IconButton label={`${customer.name} actions`} size="sm" {...trigger}>
            <LuEllipsis className="h-3.5 w-3.5" />
          </IconButton>
        )}
      >
        {customer.can_edit && (
          <MenuItem
            onSelect={() => {
              setIsEditing(true);
            }}
          >
            <LuPencil aria-hidden="true" className="h-3.5 w-3.5" />
            Edit customer
          </MenuItem>
        )}
        {customer.can_delete && (
          <>
            <MenuItem
              onSelect={() => {
                setIsMerging(true);
              }}
            >
              <LuGitMerge aria-hidden="true" className="h-3.5 w-3.5" />
              Merge into another customer
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              danger
              onSelect={() => {
                setIsDeleting(true);
              }}
            >
              <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
              Delete customer
            </MenuItem>
          </>
        )}
      </Menu>
    ) : undefined;

  return (
    <WorkspaceShell
      title={<span className="truncate">{customer.name}</span>}
      leading={crumbs}
      actions={actions}
    >
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <section
          aria-labelledby="customer-requests"
          className="min-w-0 space-y-2"
        >
          <h2 id="customer-requests" className="text-sm font-medium text-text">
            Requests
            <span className="ml-1.5 text-xs font-normal text-text-faint tabular-nums">
              {String(rows.length)}
            </span>
            {customer.important_count > 0 && (
              <span className="ml-2 inline-flex items-center gap-1 text-xs font-normal text-warning tabular-nums">
                <LuCircleAlert aria-hidden="true" className="h-3 w-3" />
                {`${String(customer.important_count)} important`}
              </span>
            )}
          </h2>
          {requests.error !== null && (
            <ErrorAlert
              message={errorMessage(
                requests.error,
                'Could not load the requests.'
              )}
            />
          )}
          {rows.length === 0 && requests.error === null ? (
            <p className="text-xs text-text-muted">
              {`No requests from ${customer.name} yet. Add one from an issue or a project.`}
            </p>
          ) : (
            <ul aria-label="Requests" className="-mx-1.5">
              {rows.map((request) => (
                <CustomerRequestRow
                  key={request.request_id}
                  request={request}
                  to={
                    request.target_kind === 'issue'
                      ? issuePath(slug, request.target_key)
                      : projectPath(slug, {
                          project_id: request.target_id,
                          name: request.target_title,
                        })
                  }
                  heading={request.target_title}
                  detail={
                    request.target_kind === 'issue'
                      ? request.target_key
                      : 'Project'
                  }
                  icon={
                    request.target_kind === 'issue' ? (
                      <LuSquareDot className="h-3.5 w-3.5" />
                    ) : (
                      <LuBox className="h-3.5 w-3.5" />
                    )
                  }
                  onRemove={removeRequest}
                  onToggleImportant={requestActions.toggleImportant}
                  onEdit={requestActions.edit}
                  onMove={requestActions.move}
                />
              ))}
            </ul>
          )}
        </section>
        <aside
          aria-label="Properties"
          className="lg:border-l lg:border-line lg:pl-6"
        >
          <dl>
            <Property label="Status">
              <CustomerStatusPicker
                value={customer.status_id}
                valueName={customer.status_name}
                statuses={statuses}
                onChange={(statusId) => {
                  change(
                    { status_id: statusId },
                    'Could not change the status.'
                  );
                }}
                disabled={!customer.can_edit}
                variant="rail"
                className="-my-1 -ml-2"
              />
            </Property>
            <Property label="Domains">
              {customer.domains.length === 0 ? (
                <Unset label="No domains" />
              ) : (
                <span className="flex flex-col">
                  {customer.domains.map((domain) => (
                    <span key={domain} className="truncate">
                      {domain}
                    </span>
                  ))}
                </span>
              )}
            </Property>
            <Property label="Tier">
              <CustomerTierPicker
                value={customer.tier_id}
                valueName={customer.tier}
                tiers={tiers}
                onChange={(tierId) => {
                  change({ tier_id: tierId }, 'Could not change the tier.');
                }}
                disabled={!customer.can_edit}
                variant="rail"
                className="-my-1 -ml-2"
              />
            </Property>
            <Property label="Owner">
              {owner === undefined ? (
                <Unset label="No owner" />
              ) : (
                <span className="flex min-w-0 items-center gap-1.5">
                  <Avatar
                    name={personLabel(owner)}
                    src={personAvatar(owner)}
                    size="xs"
                  />
                  <span className="truncate">{personLabel(owner)}</span>
                </span>
              )}
            </Property>
            <Property label="Revenue">
              {revenue === null ? (
                <Unset label="Not set" />
              ) : (
                <span className="tabular-nums">{revenue}</span>
              )}
            </Property>
            <Property label="Size">
              {size === null ? (
                <Unset label="Not set" />
              ) : (
                <span className="tabular-nums">{size}</span>
              )}
            </Property>
          </dl>
          {customer.can_edit && (
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={() => {
                setIsEditing(true);
              }}
            >
              <LuPencil aria-hidden="true" />
              Edit
            </Button>
          )}
        </aside>
      </div>

      {requestActions.dialogs}
      {isEditing && (
        <CustomerDialog
          workspaceId={workspaceId}
          people={members}
          customer={customer}
          onClose={() => {
            setIsEditing(false);
          }}
          onSaved={() => {
            setIsEditing(false);
            refresh();
          }}
        />
      )}
      {isMerging && (
        <MergeCustomerDialog
          workspaceId={workspaceId}
          customer={customer}
          customers={customers}
          onClose={() => {
            setIsMerging(false);
          }}
          onMerged={(survivor) => {
            setIsMerging(false);
            invalidateQueries(customersKey(workspaceId));
            showToast(`Merged ${customer.name} into ${survivor.name}`);
            void navigate(customerPath(slug, survivor.customer_id));
          }}
        />
      )}
      {isDeleting && (
        <Dialog
          open
          size="sm"
          title={`Delete ${customer.name}`}
          description="The customer and every request it made are deleted for everyone."
          onClose={() => {
            setIsDeleting(false);
          }}
        >
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setIsDeleting(false);
              }}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={remove}>
              Delete
            </Button>
          </div>
        </Dialog>
      )}
    </WorkspaceShell>
  );
};

export default CustomerDetail;
