/**
 * The cycle and milestone an issue is attached to. Kept apart from the other
 * issue fields because these two need their own reads of the planning domain,
 * and the field block has no business holding a second domain's lists.
 *
 * Both lists are the project's own, so a person cannot pick a cycle from
 * another project; the server refuses that anyway, and offering it would be a
 * control whose only outcome is a refusal.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { updateIssue } from '../../api/issues';
import { listCycles, listMilestones } from '../../api/planning';
import { errorMessage } from '../../lib/errors';
import {
  CYCLE_STATUS_LABELS,
  MILESTONE_STATUS_LABELS,
} from '../../lib/planningDisplay';
import { cyclesKey, milestonesKey } from '../../lib/queryKeys';
import type { IssueRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import { SelectField } from '../ui/select';

/** Props for PlanningPickers: the issue and where its planning rows live. */
export interface PlanningPickersProps {
  workspaceId: string;
  projectId: string;
  issue: IssueRead;
  canEdit: boolean;
  onSaved: (issue: IssueRead) => void;
}

/** How often the pickers re-read their lists. */
const POLL_MS = 60000;

/** The cycle and milestone pickers for one issue. */
export const PlanningPickers: React.FC<PlanningPickersProps> = ({
  workspaceId,
  projectId,
  issue,
  canEdit,
  onSaved,
}) => {
  const auth = useQueryAuth();
  const [error, setError] = useState<unknown>(null);
  const enabled = workspaceId !== '' && projectId !== '';

  const { data: cycles } = usePolledQuery(
    ({ signal }) => listCycles(workspaceId, { project_id: projectId }, signal),
    {
      intervalMs: POLL_MS,
      enabled,
      queryKey: cyclesKey(workspaceId, projectId, ''),
      auth,
    }
  );

  const { data: milestones } = usePolledQuery(
    ({ signal }) =>
      listMilestones(workspaceId, { project_id: projectId }, signal),
    {
      intervalMs: POLL_MS,
      enabled,
      queryKey: milestonesKey(workspaceId, projectId, ''),
      auth,
    }
  );

  const save = (field: 'cycle_id' | 'milestone_id', value: string): void => {
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
    <section className="space-y-3">
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not save that change.')}
        />
      )}

      <div className="flex flex-wrap gap-3">
        <SelectField
          id="issue-cycle"
          label="Cycle"
          className="w-56"
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
        </SelectField>

        <SelectField
          id="issue-milestone"
          label="Milestone"
          className="w-56"
          disabled={!canEdit}
          value={issue.milestone_id ?? ''}
          onChange={(event) => {
            save('milestone_id', event.target.value);
          }}
        >
          <option value="">No milestone</option>
          {(milestones?.milestones ?? []).map((milestone) => (
            <option key={milestone.milestone_id} value={milestone.milestone_id}>
              {milestone.name} ({MILESTONE_STATUS_LABELS[milestone.status]})
            </option>
          ))}
        </SelectField>
      </div>
    </section>
  );
};

export default PlanningPickers;
