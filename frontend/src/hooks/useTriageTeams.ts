/**
 * Which teams have triage on, for the status pickers that offer Triage. Read
 * from the sidebar's shared triage summary, so a page with many rows asks
 * nothing of its own; outside the workspace layout no team has it. The set
 * comes through its own context, so a list row's status cell does not render
 * again each time the sidebar re-reads its counts.
 */

import { useContext } from 'react';
import { TriageTeamsContext } from '../contexts/SidebarDataContextDefinition';

/** The ids of every visible team with triage on, empty before the first read. */
export const useTriageTeamIds = (): ReadonlySet<string> =>
  useContext(TriageTeamsContext);

/** Whether one team has triage on, so its status pickers offer Triage. */
export const useTriageOn = (teamId: string | null | undefined): boolean => {
  const teams = useTriageTeamIds();
  return teamId !== null && teamId !== undefined && teams.has(teamId);
};
