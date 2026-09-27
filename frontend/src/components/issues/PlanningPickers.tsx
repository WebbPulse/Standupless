/**
 * The project, milestone and cycle an issue is attached to, as their own
 * sections of the rail. Kept apart from the other issue fields because these two need
 * their own reads of the planning domain, and the field block has no business
 * holding a second domain's lists.
 *
 * Both lists are the team's own, so a person cannot pick a cycle from
 * another team; the server refuses that anyway, and offering it would be a
 * control whose only outcome is a refusal. The milestone list is the issue's
 * own project's, so it is shown only once the issue is in a project.
 */

import React, { useMemo } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { listCycles, listMilestones, listProjects } from '../../api/planning';
import { byMilestoneOrder, projectPatch } from '../../lib/milestones';
import { cyclesKey, milestonesKey, projectsKey } from '../../lib/queryKeys';
import type {
  CycleRead,
  IssueRead,
  IssueUpdate,
  ProjectRead,
} from '../../types/Api';
import { PropertySection } from './IssueFields';
import {
  CyclePicker,
  MilestonePicker,
  ProjectPicker,
  type PickerVariant,
} from './PropertyPickers';

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

/** Props for IssueMilestonePicker. */
export interface IssueMilestonePickerProps {
  workspaceId: string;
  /** The issue's project, whose milestones are offered. */
  projectId: string;
  value: string | null;
  disabled: boolean;
  variant?: PickerVariant;
  onChange: (milestoneId: string | null) => void;
}

/**
 * A milestone picker that reads its project's milestones itself, on the same
 * key the project page polls, so both surfaces share one read.
 */
export const IssueMilestonePicker: React.FC<IssueMilestonePickerProps> = ({
  workspaceId,
  projectId,
  value,
  disabled,
  variant,
  onChange,
}) => {
  const auth = useQueryAuth();
  const { data } = usePolledQuery(
    ({ signal }) => listMilestones(workspaceId, projectId, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '' && projectId !== '',
      queryKey: milestonesKey(workspaceId, projectId),
      auth,
    }
  );
  const milestones = useMemo(
    () => [...(data ?? [])].sort(byMilestoneOrder),
    [data]
  );
  return (
    <MilestonePicker
      disabled={disabled}
      {...(variant === undefined ? {} : { variant })}
      milestones={milestones}
      value={value}
      onChange={onChange}
    />
  );
};

/** The project, milestone and cycle pickers for one issue. */
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
            onUpdate(projectPatch(issue, projectId));
          }}
        />
      </PropertySection>

      {issue.project_id !== null && (
        <PropertySection title="Milestone">
          <IssueMilestonePicker
            workspaceId={workspaceId}
            projectId={issue.project_id}
            value={issue.project_milestone_id ?? null}
            disabled={!canEdit}
            onChange={(milestoneId) => {
              onUpdate({ project_milestone_id: milestoneId });
            }}
          />
        </PropertySection>
      )}

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
