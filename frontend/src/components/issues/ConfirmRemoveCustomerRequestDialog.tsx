/**
 * The question a board asks before a card dragged out of a customer column
 * withdraws that customer's request. Focus lands on Remove, so Enter confirms
 * and Escape keeps the request.
 */

import React, { useState } from 'react';
import Button from '../ui/button';
import Dialog from '../ui/dialog';

/** Props for ConfirmRemoveCustomerRequestDialog. */
export interface ConfirmRemoveCustomerRequestDialogProps {
  /** The issue the request names, by key and title. */
  issue: { key: string; title: string };
  /** The customer whose request would be withdrawn. */
  customerName: string;
  onClose: () => void;
  /** Withdraws the request. The dialog closes once it resolves. */
  onConfirm: () => Promise<void> | void;
}

/** Asks whether to withdraw a customer's request for an issue. */
export const ConfirmRemoveCustomerRequestDialog: React.FC<
  ConfirmRemoveCustomerRequestDialogProps
> = ({ issue, customerName, onClose, onConfirm }) => {
  const [busy, setBusy] = useState(false);

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Remove ${customerName}'s request?`}
      size="sm"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          void Promise.resolve(onConfirm()).finally(() => {
            onClose();
          });
        }}
        className="space-y-4"
      >
        <p className="text-sm break-words text-text-muted">
          {`${issue.key} ${issue.title} will no longer be listed as requested by ${customerName}.`}
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Keep request
          </Button>
          <Button
            type="submit"
            size="sm"
            variant="danger"
            disabled={busy}
            autoFocus
          >
            {busy ? 'Removing' : 'Remove'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

export default ConfirmRemoveCustomerRequestDialog;
