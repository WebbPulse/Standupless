/**
 * The project and cycle an issue is attached to, as their own sections of
 * the rail. Kept apart from the other issue fields because these two need
 * their own reads of the planning domain, and the field block has no business
 * holding a second domain's lists.
 *
 * Both lists are the team's own, so a person cannot pick a cycle from
 * another team; the server refuses that anyway, and offering it would be a
 * control whose only outcome is a refusal.
 */

import React from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { listCycles, listProjects } from '../../api/planning';
import { cyclesKey, projectsKey } from '../../lib/queryKeys';
import type {
  CycleRead,
  IssueRead,
  IssueUpdate,
  ProjectRead,
} from '../../types/Api';
import { PropertySection } from './IssueFields';
import { CyclePicker, ProjectPicker } from './PropertyPickers';

/** Props for PlanningPickers: the issue and where its planning rows live. */
export interface PlanningPickersProps {
  workspaceId: string;
  teamId: string;
  issue: IssueRead;
  canEdit: boolean;
  /** Called with each change as a one field patch. */
  onUpdate: (patch: IssueUpdate) => void;
  /** The team's projects, when the caller already read them. */
  projects?: ProjectRead[];
  /** The team's cycles, when the caller already read them. */
  cycles?: CycleRead[];
}

/** How often the pickers re-read their lists. */
const POLL_MS = 60000;

/** The project and cycle pickers for one issue. */
export const PlanningPickers: React.FC<PlanningPickersProps> = ({
  workspaceId,
  teamId,
  issue,
  canEdit,
  onUpdate,
  projects: givenProjects,
  cycles: givenCycles,
}) => {
  const auth = useQueryAuth();
  const enabled = workspaceId !== '' && teamId !== '';

  const { data: cycles } = usePolledQuery(
    ({ signal }) => listCycles(workspaceId, { team_id: teamId }, signal),
    {
      intervalMs: POLL_MS,
      enabled: enabled && givenCycles === undefined,
      queryKey: cyclesKey(workspaceId, teamId, ''),
      auth,
    }
  );

  const { data: projects } = usePolledQuery(
    ({ signal }) => listProjects(workspaceId, { team_id: teamId }, signal),
    {
      intervalMs: POLL_MS,
      enabled: enabled && givenProjects === undefined,
      queryKey: projectsKey(workspaceId, teamId, ''),
      auth,
    }
  );

  return (
    <>
      <PropertySection title="Project">
        <ProjectPicker
          disabled={!canEdit}
          projects={givenProjects ?? projects?.projects ?? []}
          value={issue.project_id}
          onChange={(projectId) => {
            onUpdate({ project_id: projectId });
          }}
        />
      </PropertySection>

      <PropertySection title="Cycle">
        <CyclePicker
          disabled={!canEdit}
          cycles={givenCycles ?? cycles?.cycles ?? []}
          value={issue.cycle_id}
          onChange={(cycleId) => {
            onUpdate({ cycle_id: cycleId });
          }}
        />
      </PropertySection>
    </>
  );
};

export default PlanningPickers;
