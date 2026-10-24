/**
 * The customer requests naming one issue or project: in the issue rail as a
 * folding group, and on a project's overview as a section beside its
 * documents. Each row names the customer and quotes what they said, and a
 * member who can write here adds another from the plus button.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import { LuPlus } from 'react-icons/lu';
import { deleteCustomerRequest, listTargetRequests } from '../../api/customers';
import { errorMessage } from '../../lib/errors';
import { customerPath } from '../../lib/paths';
import { customersKey, targetCustomerRequestsKey } from '../../lib/queryKeys';
import { showToast } from '../../lib/toast';
import type { CustomerRequestRead, CustomerTargetKind } from '../../types/Api';
import RailSection from '../issues/RailSection';
import { IconButton } from '../ui/button';
import AddCustomerRequestDialog from './AddCustomerRequestDialog';
import CustomerRequestRow from './CustomerRequestRow';

/** How often the list re-reads. Requests arrive rarely, so this is slow. */
const POLL_MS = 120000;

/** Props for CustomerRequestsSection. */
export interface CustomerRequestsSectionProps {
  workspaceId: string;
  slug: string;
  targetKind: CustomerTargetKind;
  targetId: string;
  /** The issue key or project name, for the add dialog's heading. */
  targetLabel: string;
  /** Whether the caller may file a request here. */
  canAdd: boolean;
  /** A folding rail group, or a section on a page. */
  variant?: 'rail' | 'section';
}

/** Lists one issue's or project's customer requests with a way to add one. */
export const CustomerRequestsSection: React.FC<
  CustomerRequestsSectionProps
> = ({
  workspaceId,
  slug,
  targetKind,
  targetId,
  targetLabel,
  canAdd,
  variant = 'rail',
}) => {
  const auth = useQueryAuth();
  const queryKey = targetCustomerRequestsKey(workspaceId, targetKind, targetId);
  const { data, error } = usePolledQuery(
    ({ signal }) =>
      listTargetRequests(workspaceId, targetKind, targetId, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );
  const [isAdding, setIsAdding] = useState(false);

  const requests = data ?? [];

  const remove = (request: CustomerRequestRead): void => {
    deleteCustomerRequest(
      workspaceId,
      request.customer_id,
      request.request_id
    ).then(
      () => {
        invalidateQueries(queryKey);
        invalidateQueries(customersKey(workspaceId));
        showToast(`Removed the request from ${request.customer_name}`);
      },
      (failure: unknown) => {
        showToast(
          errorMessage(failure, 'Could not remove that request.'),
          'error'
        );
      }
    );
  };

  const open = (): void => {
    setIsAdding(true);
  };

  const rows = (
    <ul aria-label="Customer requests" className="-mx-1.5">
      {requests.map((request) => (
        <CustomerRequestRow
          key={request.request_id}
          request={request}
          to={customerPath(slug, request.customer_id)}
          heading={request.customer_name}
          onRemove={remove}
        />
      ))}
    </ul>
  );

  const dialog = isAdding && (
    <AddCustomerRequestDialog
      workspaceId={workspaceId}
      targetKind={targetKind}
      targetId={targetId}
      targetLabel={targetLabel}
      onClose={() => {
        setIsAdding(false);
      }}
      onAdded={(request) => {
        setIsAdding(false);
        invalidateQueries(queryKey);
        showToast(`Added a request from ${request.customer_name}`);
      }}
    />
  );

  if (variant === 'rail') {
    if (requests.length === 0 && !canAdd) return null;
    return (
      <>
        <RailSection
          title="Customer requests"
          {...(requests.length > 0 ? { count: String(requests.length) } : {})}
          {...(canAdd
            ? { add: { label: 'Add customer request', onClick: open } }
            : {})}
        >
          {requests.length > 0 ? (
            rows
          ) : (
            <p className="text-xs text-text-faint">
              {error !== null
                ? 'Could not load the requests.'
                : 'No customer has asked for this yet.'}
            </p>
          )}
        </RailSection>
        {dialog}
      </>
    );
  }

  const headingId = `${targetKind}-customer-requests`;
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 id={headingId} className="text-sm font-medium text-text">
          Customer requests
          {requests.length > 0 && (
            <span className="ml-1.5 text-xs font-normal text-text-faint tabular-nums">
              {String(requests.length)}
            </span>
          )}
        </h2>
        {canAdd && (
          <IconButton label="Add customer request" size="sm" onClick={open}>
            <LuPlus className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
      {requests.length > 0 ? (
        rows
      ) : (
        <p className="text-xs text-text-muted">
          {error !== null
            ? 'Could not load the requests.'
            : `No customer has asked for this ${targetKind} yet.`}
        </p>
      )}
      {dialog}
    </section>
  );
};

export default CustomerRequestsSection;
