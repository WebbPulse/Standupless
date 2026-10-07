/**
 * A button that exports the issues a filter selects as a CSV download. The
 * export is read a page at a time and joined in the browser, so the button
 * stays busy until the last page lands and a failure says so in a toast.
 */

import React, { useState } from 'react';
import { LuDownload } from 'react-icons/lu';
import { exportIssuesCsv, type IssueListFilters } from '../../../api/issues';
import { downloadText, fileSlug, todayStamp } from '../../../lib/download';
import { errorMessage } from '../../../lib/errors';
import { showErrorToast, showToast } from '../../../lib/toast';
import Button from '../../ui/button';

/** Props for ExportCsvButton. */
export interface ExportCsvButtonProps {
  workspaceId: string;
  /** The list query to export, such as a team list's or a saved view's. */
  filters: IssueListFilters;
  /** Names the file, before the date. */
  name: string;
  label?: string;
  variant?: 'ghost' | 'secondary';
}

/** Exports `filters` as `<name>-<date>.csv`. */
export const ExportCsvButton: React.FC<ExportCsvButtonProps> = ({
  workspaceId,
  filters,
  name,
  label = 'Export CSV',
  variant = 'ghost',
}) => {
  const [busy, setBusy] = useState(false);

  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      const text = await exportIssuesCsv(workspaceId, filters);
      downloadText(text, `${fileSlug(name)}-${todayStamp()}.csv`);
      showToast('Export downloaded.');
    } catch (error) {
      showErrorToast(errorMessage(error, 'Could not export the issues.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      size="sm"
      variant={variant}
      className="gap-1.5"
      disabled={busy || workspaceId === ''}
      aria-busy={busy}
      onClick={() => void run()}
    >
      <LuDownload aria-hidden="true" className="h-3.5 w-3.5" />
      {busy ? 'Exporting...' : label}
    </Button>
  );
};

export default ExportCsvButton;
