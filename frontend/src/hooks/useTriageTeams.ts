/**
 * Which teams have triage on, for the status pickers that offer Triage. Read
 * from the sidebar's shared triage summary, so a page with many rows asks
 * nothing of its own; outside the workspace layout no team has it.
 */

import { useContext, useMemo } from 'react';
import { SidebarDataContext } from '../contexts/SidebarDataContextDefinition';

/** The ids of every visible team with triage on, empty before the first read. */
export const useTriageTeamIds = (): ReadonlySet<string> => {
  const shared = useContext(SidebarDataContext);
  const teams = shared?.triage?.teams;
  return useMemo(
    () => new Set((teams ?? []).map((row) => row.team_id)),
    [teams]
  );
};

/** Whether one team has triage on, so its status pickers offer Triage. */
export const useTriageOn = (teamId: string | null | undefined): boolean => {
  const teams = useTriageTeamIds();
  return teamId !== null && teamId !== undefined && teams.has(teamId);
};
