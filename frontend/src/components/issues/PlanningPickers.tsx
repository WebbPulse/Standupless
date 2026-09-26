/**
 * The cycle and project an issue is attached to. Kept apart from the other
 * issue fields because these two need their own reads of the planning domain,
 * and the field block has no business holding a second domain's lists.
 *
 * Both lists are the team's own, so a person cannot pick a cycle from
 * another team; the server refuses that anyway, and offering it would be a
 * control whose only outcome is a refusal.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { updateIssue } from '../../api/issues';
import { listCycles, listProjects } from '../../api/planning';
import { errorMessage } from '../../lib/errors';
import {
  CYCLE_STATUS_LABELS,
  PROJECT_STATUS_LABELS,
} from '../../lib/planningDisplay';
import { cyclesKey, projectsKey } from '../../lib/queryKeys';
import type { IssueRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Select from '../ui/select';
import { PropertyRow } from './IssueFields';

/** Props for PlanningPickers: the issue and where its planning rows live. */
export interface PlanningPickersProps {
  workspaceId: string;
  teamId: string;
  issue: IssueRead;
  canEdit: boolean;
  onSaved: (issue: IssueRead) => void;
}

/** How often the pickers re-read their lists. */
const POLL_MS = 60000;

/** The cycle and project pickers for one issue. */
export const PlanningPickers: React.FC<PlanningPickersProps> = ({
  workspaceId,
  teamId,
  issue,
  canEdit,
  onSaved,
}) => {
  const auth = useQueryAuth();
  const [error, setError] = useState<unknown>(null);
  const enabled = workspaceId !== '' && teamId !== '';

  const { data: cycles } = usePolledQuery(
    ({ signal }) => listCycles(workspaceId, { team_id: teamId }, signal),
    {
      intervalMs: POLL_MS,
      enabled,
      queryKey: cyclesKey(workspaceId, teamId, ''),
      auth,
    }
  );

  const { data: projects } = usePolledQuery(
    ({ signal }) => listProjects(workspaceId, { team_id: teamId }, signal),
    {
      intervalMs: POLL_MS,
      enabled,
      queryKey: projectsKey(workspaceId, teamId, ''),
      auth,
    }
  );

  const save = (field: 'cycle_id' | 'project_id', value: string): void => {
    setError(null);
    updateIssue(workspaceId, issue.id, {
      [field]: value === '' ? null : value,
    })
      .then(onSaved)
      .catch((failure: unknown) => {
        setError(failure);
      });
  };

  return (
    <section className="space-y-2">
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not save that change.')}
        />
      )}

      <PropertyRow id="issue-cycle" label="Cycle">
        <Select
          id="issue-cycle"
          disabled={!canEdit}
          value={issue.cycle_id ?? ''}
          onChange={(event) => {
            save('cycle_id', event.target.value);
          }}
        >
          <option value="">No cycle</option>
          {(cycles?.cycles ?? []).map((cycle) => (
            <option key={cycle.cycle_id} value={cycle.cycle_id}>
              {cycle.name} ({CYCLE_STATUS_LABELS[cycle.status]})
            </option>
          ))}
        </Select>
      </PropertyRow>

      <PropertyRow id="issue-project" label="Project">
        <Select
          id="issue-project"
          disabled={!canEdit}
          value={issue.project_id ?? ''}
          onChange={(event) => {
            save('project_id', event.target.value);
          }}
        >
          <option value="">No project</option>
          {(projects?.projects ?? []).map((project) => (
            <option key={project.project_id} value={project.project_id}>
              {project.name} ({PROJECT_STATUS_LABELS[project.status]})
            </option>
          ))}
        </Select>
      </PropertyRow>
    </section>
  );
};

export default PlanningPickers;
