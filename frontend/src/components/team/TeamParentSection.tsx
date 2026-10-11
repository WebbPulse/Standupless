/**
 * The team's place in the team hierarchy: the parent team it sits under, or
 * none for a top-level team.
 *
 * A sub-team inherits its parent's statuses and labels, and the parent's issue
 * views can roll its issues up. Teams nest one level, so only top-level teams
 * are offered as a parent, and a team that has sub-teams of its own cannot take
 * one. Leaving a parent gives the team its own statuses again and moves its
 * issues off the parent's ones, so the change saves on pick and the server's
 * refusal is shown as sent.
 */

import React, { useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { updateTeam } from '../../api/teams';
import { useTeamsFor } from '../../hooks/useTeams';
import { errorMessage } from '../../lib/errors';
import {
  allLabelsKey,
  allStatusesKey,
  labelsKey,
  statusesKey,
  teamsKey,
} from '../../lib/queryKeys';
import type { TeamRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import { SelectField } from '../ui/select';

/** Props for TeamParentSection. */
export interface TeamParentSectionProps {
  workspaceId: string;
  team: TeamRead;
  /** Whether the caller administers the team. */
  canEdit: boolean;
}

/** The option value that stands for no parent team. */
const NONE = '';

/** Shows the team's parent team and lets a team admin set or clear it. */
export const TeamParentSection: React.FC<TeamParentSectionProps> = ({
  workspaceId,
  team,
  canEdit,
}) => {
  const { data: teams } = useTeamsFor(workspaceId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const current = team.parent_team_id ?? NONE;
  const all = teams ?? [];
  const subTeams = all.filter((other) => other.parent_team_id === team.id);
  const parent = all.find((other) => other.id === current);
  const candidates = all.filter(
    (other) =>
      other.id !== team.id &&
      (other.parent_team_id === null || other.parent_team_id === undefined)
  );

  const save = async (next: string): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await updateTeam(workspaceId, team.id, {
        parent_team_id: next === NONE ? null : next,
      });
      invalidateQueries([
        teamsKey(workspaceId),
        statusesKey(team.id),
        allStatusesKey(team.id),
        labelsKey(team.id),
        allLabelsKey(team.id),
      ]);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  const summary = (): string => {
    if (subTeams.length > 0) {
      const names = subTeams.map((other) => other.name).join(', ');
      return `Sub-teams: ${names}. Their issues can roll up into this team's views, and they inherit its statuses and labels.`;
    }
    if (parent !== undefined) {
      return `This team sits under ${parent.name} and inherits its statuses and labels.`;
    }
    return "This team is top-level. Put it under another team to inherit that team's statuses and labels.";
  };

  return (
    <section className="space-y-4" data-testid="team-parent-section">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Parent team</h3>
        <p className="text-sm text-text-muted">{summary()}</p>
      </div>
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not change the parent team.')}
        />
      )}
      {canEdit && (
        <SelectField
          id="team-parent"
          label="Parent team"
          hideLabel
          className="max-w-xs"
          value={current}
          disabled={saving || subTeams.length > 0}
          onChange={(event) => {
            void save(event.target.value);
          }}
        >
          <option value={NONE}>No parent team</option>
          {parent === undefined && current !== NONE && (
            <option value={current}>A team you cannot see</option>
          )}
          {candidates.map((other) => (
            <option key={other.id} value={other.id}>
              {other.name}
            </option>
          ))}
        </SelectField>
      )}
      {canEdit && subTeams.length > 0 && (
        <p className="text-xs text-text-faint">
          Teams nest one level, so a team with sub-teams stays top-level.
        </p>
      )}
    </section>
  );
};

export default TeamParentSection;
