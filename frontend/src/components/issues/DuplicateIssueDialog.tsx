/**
 * The small confirmation Duplicate issue asks on an issue with sub-issues,
 * offering the Include sub-issues toggle as Linear does. Focus lands on the
 * Duplicate button, so Enter confirms and Escape cancels.
 */

import React, { useState } from 'react';
import {
  DUPLICATE_ISSUE_LABEL,
  INCLUDE_SUB_ISSUES_LABEL,
  runDuplicate,
  type ConvertibleIssue,
} from '../../lib/issueConversion';
import type { IssueRead } from '../../types/Api';
import Button from '../ui/button';
import Checkbox from '../ui/checkbox';
import Dialog from '../ui/dialog';

/** Props for DuplicateIssueDialog. */
export interface DuplicateIssueDialogProps {
  workspaceId: string;
  issue: ConvertibleIssue;
  onClose: () => void;
  /** Called with the copy, after the dialog closes. */
  onDuplicated: (copy: IssueRead) => void;
}

/** Asks whether to copy the sub-issues too, then duplicates. */
export const DuplicateIssueDialog: React.FC<DuplicateIssueDialogProps> = ({
  workspaceId,
  issue,
  onClose,
  onDuplicated,
}) => {
  const [includeSubIssues, setIncludeSubIssues] = useState(false);
  const [busy, setBusy] = useState(false);
  const count = issue.progress.total;

  const duplicate = async (): Promise<void> => {
    setBusy(true);
    const copy = await runDuplicate(workspaceId, issue, includeSubIssues);
    if (copy === null) {
      setBusy(false);
      return;
    }
    onClose();
    onDuplicated(copy);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${DUPLICATE_ISSUE_LABEL}?`}
      size="sm"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          void duplicate();
        }}
        className="space-y-4"
      >
        <p className="text-sm break-words text-text-muted">
          {`${issue.key} has ${count === 1 ? 'a sub-issue' : `${count} sub-issues`}. Copies start unassigned in the default status.`}
        </p>
        <Checkbox
          label={INCLUDE_SUB_ISSUES_LABEL}
          checked={includeSubIssues}
          onChange={(event) => {
            setIncludeSubIssues(event.target.checked);
          }}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={busy}
            autoFocus
          >
            {busy ? 'Duplicating' : 'Duplicate'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

export default DuplicateIssueDialog;
