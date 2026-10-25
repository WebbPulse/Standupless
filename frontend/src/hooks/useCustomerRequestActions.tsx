/**
 * The actions a customer request row offers beyond delete: mark it important,
 * edit it, and move it to another issue or project. One hook serves the issue
 * rail, a project's section and a customer's page, and refreshes every list
 * the old and new request appear in.
 */

import React, { useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { updateCustomerRequest } from '../api/customers';
import AddCustomerRequestDialog from '../components/customers/AddCustomerRequestDialog';
import MoveCustomerRequestDialog from '../components/customers/MoveCustomerRequestDialog';
import { errorMessage } from '../lib/errors';
import {
  customerKey,
  customerRequestsKey,
  customersKey,
  targetCustomerRequestsKey,
} from '../lib/queryKeys';
import { showToast } from '../lib/toast';
import type { CustomerRequestRead } from '../types/Api';

/** The row handlers and the dialogs they open. */
export interface CustomerRequestActions {
  toggleImportant: (request: CustomerRequestRead) => void;
  edit: (request: CustomerRequestRead) => void;
  move: (request: CustomerRequestRead) => void;
  /** The open edit or move dialog, rendered once by the caller. */
  dialogs: React.ReactNode;
}

/** The name a request's issue or project goes by. */
const targetLabel = (request: CustomerRequestRead): string =>
  request.target_kind === 'issue'
    ? request.target_key || request.target_title
    : request.target_title;

/** Builds the request actions for one workspace. */
export const useCustomerRequestActions = (
  workspaceId: string
): CustomerRequestActions => {
  const [editing, setEditing] = useState<CustomerRequestRead | null>(null);
  const [moving, setMoving] = useState<CustomerRequestRead | null>(null);

  const refresh = (
    before: CustomerRequestRead,
    after: CustomerRequestRead
  ): void => {
    for (const request of [before, after]) {
      invalidateQueries(
        targetCustomerRequestsKey(
          workspaceId,
          request.target_kind,
          request.target_id
        )
      );
      invalidateQueries(customerRequestsKey(workspaceId, request.customer_id));
      invalidateQueries(customerKey(workspaceId, request.customer_id));
    }
    invalidateQueries(customersKey(workspaceId));
  };

  const toggleImportant = (request: CustomerRequestRead): void => {
    const important = !request.important;
    updateCustomerRequest(
      workspaceId,
      request.customer_id,
      request.request_id,
      {
        important,
      }
    ).then(
      (saved) => {
        refresh(request, saved);
        showToast(
          important ? 'Marked the request important' : 'Unmarked the request'
        );
      },
      (failure: unknown) => {
        showToast(
          errorMessage(failure, 'Could not update that request.'),
          'error'
        );
      }
    );
  };

  const dialogs = (
    <>
      {editing !== null && (
        <AddCustomerRequestDialog
          workspaceId={workspaceId}
          targetKind={editing.target_kind}
          targetId={editing.target_id}
          targetLabel={targetLabel(editing)}
          request={editing}
          onClose={() => {
            setEditing(null);
          }}
          onAdded={(saved) => {
            refresh(editing, saved);
            setEditing(null);
            showToast('Saved the request');
          }}
        />
      )}
      {moving !== null && (
        <MoveCustomerRequestDialog
          workspaceId={workspaceId}
          request={moving}
          onClose={() => {
            setMoving(null);
          }}
          onMoved={(saved) => {
            refresh(moving, saved);
            setMoving(null);
            showToast(`Moved the request to ${targetLabel(saved)}`);
          }}
        />
      )}
    </>
  );

  return {
    toggleImportant,
    edit: setEditing,
    move: setMoving,
    dialogs,
  };
};
