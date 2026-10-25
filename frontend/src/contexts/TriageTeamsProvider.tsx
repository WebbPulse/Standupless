/**
 * Publishes which teams have triage on from the sidebar's triage summary,
 * holding the set steady while only the counts change.
 */

import React, { useMemo } from 'react';
import type { TriageSummaryRead } from '../types/Api';
import {
  NO_TRIAGE_TEAMS,
  TriageTeamsContext,
} from './SidebarDataContextDefinition';

/**
 * Supplies the set of teams with triage on. The set is rebuilt only when the
 * list of team ids changes, never for a new count or a re-read that answers
 * the same teams.
 */
export const TriageTeamsProvider: React.FC<{
  triage: TriageSummaryRead | null;
  children: React.ReactNode;
}> = ({ triage, children }) => {
  const ids = (triage?.teams ?? [])
    .map((row) => row.team_id)
    .sort()
    .join('\n');
  const teams = useMemo(
    () => (ids === '' ? NO_TRIAGE_TEAMS : new Set(ids.split('\n'))),
    [ids]
  );
  return (
    <TriageTeamsContext.Provider value={teams}>
      {children}
    </TriageTeamsContext.Provider>
  );
};

export default TriageTeamsProvider;
