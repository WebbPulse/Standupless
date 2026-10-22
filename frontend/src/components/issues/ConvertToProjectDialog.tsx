/**
 * The confirmation Convert to project asks before it runs, since a
 * conversion closes the issue and moves its sub-issues. Focus lands on the
 * Convert button, so Enter confirms and Escape cancels.
 */

import React, { useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { convertIssueToProject } from '../../api/issues';
import { errorMessage } from '../../lib/errors';
import {
  CONVERT_TO_PROJECT_LABEL,
  conversionSummary,
  type ConvertibleIssue,
} from '../../lib/issueConversion';
import { activityKey, childrenKey, issueKey } from '../../lib/queryKeys';
import { showErrorToast, showToast } from '../../lib/toast';
import type { IssueConversionRead } from '../../types/Api';
import Button from '../ui/button';
import Dialog from '../ui/dialog';

/** Props for ConvertToProjectDialog. */
export interface ConvertToProjectDialogProps {
  workspaceId: string;
  issue: ConvertibleIssue;
  onClose: () => void;
  /** Called with what the conversion answered, after the dialog closes. */
  onConverted: (result: IssueConversionRead) => void;
}

/** Asks before converting, then converts. Enter confirms and Escape cancels. */
export const ConvertToProjectDialog: React.FC<ConvertToProjectDialogProps> = ({
  workspaceId,
  issue,
  onClose,
  onConverted,
}) => {
  const [busy, setBusy] = useState(false);

  const convert = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await convertIssueToProject(workspaceId, issue.id);
      invalidateQueries([
        issueKey(workspaceId, issue.key),
        issueKey(workspaceId, issue.id),
        childrenKey(issue.id),
        activityKey(issue.id),
      ]);
      showToast(`Converted ${issue.key} into ${result.project.name}`);
      onClose();
      onConverted(result);
    } catch (cause) {
      showErrorToast(
        errorMessage(cause, 'Could not convert that issue into a project.')
      );
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${CONVERT_TO_PROJECT_LABEL}?`}
      size="sm"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          void convert();
        }}
        className="space-y-4"
      >
        <p className="text-sm break-words text-text-muted">
          {conversionSummary(issue)}
        </p>
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
            {busy ? 'Converting' : 'Convert'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

export default ConvertToProjectDialog;
