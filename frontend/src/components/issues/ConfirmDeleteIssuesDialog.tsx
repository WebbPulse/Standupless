/**
 * The question Cmd or Ctrl+Delete asks before it deletes. Focus lands on the
 * Delete button, so Enter confirms and Escape cancels without reaching for
 * the mouse.
 */

import React, { useState } from 'react';
import Button from '../ui/button';
import Dialog from '../ui/dialog';

/** Props for ConfirmDeleteIssuesDialog. */
export interface ConfirmDeleteIssuesDialogProps {
  /** The issues to delete, named by key and title. */
  issues: readonly { key: string; title: string }[];
  onClose: () => void;
  /** Deletes the issues. The dialog closes once it resolves. */
  onConfirm: () => Promise<void> | void;
}

/** Asks whether to delete one issue or several. */
export const ConfirmDeleteIssuesDialog: React.FC<
  ConfirmDeleteIssuesDialogProps
> = ({ issues, onClose, onConfirm }) => {
  const [busy, setBusy] = useState(false);
  const [first] = issues;
  const single = issues.length === 1 && first !== undefined;
  const title = single
    ? 'Delete issue?'
    : `Delete ${String(issues.length)} issues?`;
  const description = single
    ? `${first.key} ${first.title} moves to the team's recently deleted list, where it can be restored for 30 days.`
    : `${issues.map((issue) => issue.key).join(', ')} move to their team's recently deleted list, where they can be restored for 30 days.`;

  return (
    <Dialog open onClose={onClose} title={title} size="sm">
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
        <p className="text-sm break-words text-text-muted">{description}</p>
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            variant="danger"
            disabled={busy}
            autoFocus
          >
            {busy ? 'Deleting' : 'Delete'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

export default ConfirmDeleteIssuesDialog;
