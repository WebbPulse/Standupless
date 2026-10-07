/**
 * The workspace's data export: every issue in every team, archived ones
 * included, as one CSV. It sits with the other owner and admin settings
 * because for them the export is the whole workspace.
 */

import React from 'react';
import type { WorkspaceRead } from '../../types/Api';
import ExportCsvButton from '../issues/export/ExportCsvButton';

/** Props for ExportSection: the workspace it exports. */
export interface ExportSectionProps {
  workspace: WorkspaceRead;
}

/** Downloads the workspace's issues as CSV. */
export const ExportSection: React.FC<ExportSectionProps> = ({ workspace }) => (
  <section className="space-y-4">
    <div className="space-y-1">
      <h2 className="text-base font-semibold">Export</h2>
      <p className="text-sm text-text-muted">
        Download every issue in every team, archived ones included, as a CSV
        file that spreadsheets and other trackers can read.
      </p>
    </div>
    <ExportCsvButton
      workspaceId={workspace.id}
      filters={{ include_archived: true }}
      name={`${workspace.slug}-issues`}
      label="Export all issues"
      variant="secondary"
    />
  </section>
);

export default ExportSection;
