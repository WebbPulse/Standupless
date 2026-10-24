/**
 * The add customer request dialog, opened from an issue or a project: pick the
 * customer who asked, or type a new name to add one on the spot, then paste
 * what they said. Cmd or Ctrl and Enter files it from anywhere in the dialog.
 */

import React, { useMemo, useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { LuBuilding2 } from 'react-icons/lu';
import { createCustomer, createCustomerRequest } from '../../api/customers';
import { useCustomers } from '../../hooks/useCustomers';
import { errorMessage } from '../../lib/errors';
import type {
  CustomerRead,
  CustomerRequestRead,
  CustomerTargetKind,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Combobox from '../ui/combobox';
import Dialog from '../ui/dialog';

/** Props for AddCustomerRequestDialog: the issue or project being asked for. */
export interface AddCustomerRequestDialogProps {
  workspaceId: string;
  targetKind: CustomerTargetKind;
  targetId: string;
  /** The issue key or project name, shown in the dialog's heading. */
  targetLabel: string;
  onClose: () => void;
  onAdded: (request: CustomerRequestRead) => void;
}

/** The dialog that files a customer request. */
export const AddCustomerRequestDialog: React.FC<
  AddCustomerRequestDialogProps
> = ({ workspaceId, targetKind, targetId, targetLabel, onClose, onAdded }) => {
  const { customers, queryKey } = useCustomers(workspaceId);
  const [added, setAdded] = useState<CustomerRead[]>([]);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [quote, setQuote] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const known = useMemo(() => {
    const ids = new Set(customers.map((row) => row.customer_id));
    return [...customers, ...added.filter((row) => !ids.has(row.customer_id))];
  }, [customers, added]);

  const options = useMemo(
    () =>
      known.map((row) => ({
        value: row.customer_id,
        label: row.name,
        icon: <LuBuilding2 aria-hidden="true" className="h-3.5 w-3.5" />,
        detail: row.domains[0] ?? '',
        keywords: row.domains,
      })),
    [known]
  );

  const addCustomer = (text: string): void => {
    const name = text.trim();
    if (name === '' || isSaving) return;
    setIsSaving(true);
    setError(null);
    createCustomer(workspaceId, { name }).then(
      (customer) => {
        setIsSaving(false);
        setAdded((current) => [...current, customer]);
        setCustomerId(customer.customer_id);
        invalidateQueries(queryKey);
      },
      (failure: unknown) => {
        setIsSaving(false);
        setError(failure);
      }
    );
  };

  const submit = (): void => {
    if (customerId === null || isSaving) return;
    setIsSaving(true);
    setError(null);
    createCustomerRequest(workspaceId, targetKind, targetId, {
      customer_id: customerId,
      body: quote.trim(),
    }).then(
      (request) => {
        setIsSaving(false);
        invalidateQueries(queryKey);
        onAdded(request);
      },
      (failure: unknown) => {
        setIsSaving(false);
        setError(failure);
      }
    );
  };

  const chosen = known.find((row) => row.customer_id === customerId) ?? null;

  return (
    <Dialog
      open
      title="Add customer request"
      description={`Record which customer asked for ${targetLabel}.`}
      size="md"
      onClose={onClose}
    >
      <div
        className="space-y-3"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      >
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not add that request.')}
          />
        )}
        {chosen === null ? (
          <Combobox
            label="Customer"
            options={options}
            selected={[]}
            onSelect={setCustomerId}
            onCreate={addCustomer}
            createLabel={(text) => `Add customer "${text}"`}
            placeholder="Find or add a customer..."
            emptyMessage="No customers yet. Type a name to add one."
          />
        ) : (
          <div className="flex h-8 items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-sm">
            <LuBuilding2
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 text-text-muted"
            />
            <span className="min-w-0 flex-1 truncate font-medium text-text">
              {chosen.name}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setCustomerId(null);
              }}
            >
              Change
            </Button>
          </div>
        )}
        <textarea
          aria-label="What the customer said"
          placeholder="Paste what the customer said (optional)"
          rows={4}
          maxLength={5000}
          value={quote}
          onChange={(event) => {
            setQuote(event.target.value);
          }}
          className="w-full resize-none rounded-md border border-line bg-transparent px-2.5 py-2 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none"
        />
        <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={customerId === null || isSaving}
            onClick={submit}
          >
            {isSaving ? 'Adding' : 'Add request'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};

export default AddCustomerRequestDialog;
