/**
 * The merge dialog: pick the customer this one folds into. The survivor keeps
 * its own fields, gains this customer's domains and requests, and this one is
 * deleted, so the dialog says so before it runs.
 */

import React, { useMemo, useState } from 'react';
import { LuBuilding2 } from 'react-icons/lu';
import { mergeCustomer } from '../../api/customers';
import { errorMessage } from '../../lib/errors';
import type { CustomerRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Combobox from '../ui/combobox';
import Dialog from '../ui/dialog';

/** Props for MergeCustomerDialog: the customer that goes away and the rest. */
export interface MergeCustomerDialogProps {
  workspaceId: string;
  customer: CustomerRead;
  customers: CustomerRead[];
  onClose: () => void;
  onMerged: (survivor: CustomerRead) => void;
}

/** The dialog that folds one customer into another. */
export const MergeCustomerDialog: React.FC<MergeCustomerDialogProps> = ({
  workspaceId,
  customer,
  customers,
  onClose,
  onMerged,
}) => {
  const [intoId, setIntoId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const options = useMemo(
    () =>
      customers
        .filter((row) => row.customer_id !== customer.customer_id)
        .map((row) => ({
          value: row.customer_id,
          label: row.name,
          icon: <LuBuilding2 aria-hidden="true" className="h-3.5 w-3.5" />,
          detail: row.domains[0] ?? '',
          keywords: row.domains,
        })),
    [customers, customer.customer_id]
  );
  const into = customers.find((row) => row.customer_id === intoId) ?? null;

  const submit = (): void => {
    if (intoId === null || isSaving) return;
    setIsSaving(true);
    setError(null);
    mergeCustomer(workspaceId, customer.customer_id, intoId).then(
      (survivor) => {
        setIsSaving(false);
        onMerged(survivor);
      },
      (failure: unknown) => {
        setIsSaving(false);
        setError(failure);
      }
    );
  };

  return (
    <Dialog
      open
      title={`Merge ${customer.name}`}
      description="Its requests and domains move to the customer you pick, and it is deleted."
      size="md"
      onClose={onClose}
    >
      <div className="space-y-3">
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not merge those customers.')}
          />
        )}
        <Combobox
          label="Merge into"
          options={options}
          selected={intoId === null ? [] : [intoId]}
          onSelect={setIntoId}
          placeholder="Find a customer..."
          emptyMessage="No other customers."
        />
        {into !== null && (
          <p className="text-xs text-text-muted">
            {`${customer.name} merges into ${into.name}.`}
          </p>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={intoId === null || isSaving}
            onClick={submit}
          >
            {isSaving ? 'Merging' : 'Merge customers'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};

export default MergeCustomerDialog;
