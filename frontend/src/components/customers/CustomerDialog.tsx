/**
 * The customer dialog, for adding a customer or editing one: a large name
 * field, then domains, revenue and size, with the status, the tier and the
 * account owner as chips picking from the workspace's lists. Cmd or Ctrl and Enter saves it from anywhere in the dialog.
 */

import React, { useState } from 'react';
import { createCustomer, updateCustomer } from '../../api/customers';
import useCustomerFields from '../../hooks/useCustomerFields';
import { parseAmount, parseDomains } from '../../lib/customerDisplay';
import { errorMessage } from '../../lib/errors';
import type { Assignable } from '../../lib/issuePeople';
import type { CustomerRead } from '../../types/Api';
import { LeadPicker } from '../planning/ProjectPickers';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import Field from '../ui/field';
import CustomerStatusPicker from './CustomerStatusPicker';
import CustomerTierPicker from './CustomerTierPicker';

/** Props for CustomerDialog: the customer to edit, or none to add one. */
export interface CustomerDialogProps {
  workspaceId: string;
  /** The workspace members an owner is picked from. */
  people: Assignable[];
  /** The customer being edited; unset adds a new one. */
  customer?: CustomerRead | null;
  /** The name a new customer starts with, such as text typed into a picker. */
  initialName?: string;
  onClose: () => void;
  onSaved: (customer: CustomerRead) => void;
}

/** An amount as the text its field starts with. */
const amountText = (value: number | null | undefined): string =>
  value === null || value === undefined ? '' : String(value);

/** The dialog that adds or edits a customer. */
export const CustomerDialog: React.FC<CustomerDialogProps> = ({
  workspaceId,
  people,
  customer = null,
  initialName = '',
  onClose,
  onSaved,
}) => {
  const [name, setName] = useState(customer?.name ?? initialName);
  const [domains, setDomains] = useState(customer?.domains.join(', ') ?? '');
  const { statuses, tiers } = useCustomerFields(workspaceId);
  const [statusId, setStatusId] = useState<string | null>(
    customer?.status_id ?? null
  );
  const [tierId, setTierId] = useState<string | null>(
    customer?.tier_id ?? null
  );
  const [ownerId, setOwnerId] = useState<string | null>(
    customer?.owner_id ?? null
  );
  const [revenue, setRevenue] = useState(amountText(customer?.revenue));
  const [size, setSize] = useState(amountText(customer?.size));
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const revenueValid = revenue.trim() === '' || parseAmount(revenue) !== null;
  const sizeValid = size.trim() === '' || parseAmount(size) !== null;
  const canSave = name.trim() !== '' && revenueValid && sizeValid;
  const isEditing = customer !== null;

  const submit = (): void => {
    if (!canSave || isSaving) return;
    setIsSaving(true);
    setError(null);
    const body = {
      name: name.trim(),
      domains: parseDomains(domains),
      status_id: statusId,
      tier_id: tierId,
      owner_id: ownerId,
      revenue: parseAmount(revenue),
      size: parseAmount(size),
    };
    const write = isEditing
      ? updateCustomer(workspaceId, customer.customer_id, body)
      : createCustomer(workspaceId, body);
    write.then(
      (saved) => {
        setIsSaving(false);
        onSaved(saved);
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
      title={isEditing ? 'Edit customer' : 'New customer'}
      size="md"
      hideTitle
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
        <p className="truncate text-xs font-medium text-text-muted">
          {isEditing ? 'Edit customer' : 'New customer'}
        </p>
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not save that customer.')}
          />
        )}
        <input
          aria-label="Customer name"
          placeholder="Customer name"
          autoFocus
          value={name}
          maxLength={200}
          onChange={(event) => {
            setName(event.target.value);
          }}
          className="w-full bg-transparent text-xl font-semibold text-text placeholder:text-text-faint focus:outline-none"
        />
        <Field
          id="customer-domains"
          label="Domains"
          placeholder="acme.com, acme.io"
          hint="Separate domains with commas or spaces."
          value={domains}
          onChange={(event) => {
            setDomains(event.target.value);
          }}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            id="customer-revenue"
            label="Annual revenue"
            placeholder="120000"
            inputMode="numeric"
            value={revenue}
            aria-invalid={!revenueValid}
            {...(revenueValid ? {} : { hint: 'Enter a whole number.' })}
            onChange={(event) => {
              setRevenue(event.target.value);
            }}
          />
          <Field
            id="customer-size"
            label="Size"
            placeholder="250"
            inputMode="numeric"
            value={size}
            aria-invalid={!sizeValid}
            {...(sizeValid ? {} : { hint: 'Enter a whole number.' })}
            onChange={(event) => {
              setSize(event.target.value);
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <CustomerStatusPicker
            value={statusId}
            valueName={customer?.status_name ?? null}
            statuses={statuses}
            onChange={setStatusId}
          />
          <CustomerTierPicker
            variant="chip"
            value={tierId}
            valueName={customer?.tier ?? null}
            tiers={tiers}
            onChange={setTierId}
          />
          <LeadPicker
            variant="chip"
            field="Owner"
            value={ownerId}
            people={people}
            onChange={setOwnerId}
          />
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canSave || isSaving}
            onClick={submit}
          >
            {isSaving
              ? 'Saving'
              : isEditing
                ? 'Save changes'
                : 'Create customer'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};

export default CustomerDialog;
