/**
 * The workspace's project update cadence: how often a project's lead is
 * reminded to write an update, unless the project sets its own. Off stops the
 * reminders for every project that inherits it.
 */

import React, { useState } from 'react';
import { updateWorkspace } from '../../api/workspaces';
import { useWorkspace } from '../../hooks/useWorkspace';
import {
  PROJECT_UPDATE_INTERVALS,
  PROJECT_UPDATE_INTERVAL_LABELS,
} from '../../lib/planningDisplay';
import type { ProjectUpdateInterval, WorkspaceRead } from '../../types/Api';
import { SelectField } from '../ui/select';

/** Props for ProjectUpdatesSection. */
export interface ProjectUpdatesSectionProps {
  workspace: WorkspaceRead;
}

/** Picks the default update cadence, saves it, then re-reads the workspace. */
export const ProjectUpdatesSection: React.FC<ProjectUpdatesSectionProps> = ({
  workspace,
}) => {
  const { refresh } = useWorkspace();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = workspace.project_update_interval_days ?? 7;

  const save = async (interval: ProjectUpdateInterval): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await updateWorkspace(workspace.id, {
        project_update_interval_days: interval,
      });
      await refresh();
    } catch {
      setError('Could not save the update cadence. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Project updates</h3>
        <p className="text-sm text-text-muted">
          How often a project lead is reminded to post an update. A project can
          set its own cadence. Completed, canceled and paused projects are never
          due.
        </p>
      </div>
      <SelectField
        id="workspace-project-update-cadence"
        label="Default cadence"
        className="max-w-xs"
        value={String(value)}
        disabled={saving}
        onChange={(event) => {
          void save(Number(event.target.value) as ProjectUpdateInterval);
        }}
      >
        {PROJECT_UPDATE_INTERVALS.map((interval) => (
          <option key={interval} value={String(interval)}>
            {PROJECT_UPDATE_INTERVAL_LABELS[interval]}
          </option>
        ))}
      </SelectField>
      {error !== null && <p className="text-sm text-danger">{error}</p>}
    </section>
  );
};

export default ProjectUpdatesSection;
