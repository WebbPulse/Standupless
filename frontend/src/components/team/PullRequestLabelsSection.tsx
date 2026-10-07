/**
 * The team switch for carrying issue labels onto linked pull requests.
 *
 * On by default. A pull request that names one of this team's issues gets that
 * issue's labels, and the App only ever removes a label it added itself, so the
 * switch saves as it changes like the sync controls beside it. The team row is
 * re-read through the teams list key, which is where the page reads it from.
 */

import React, { useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { updateTeam } from '../../api/teams';
import { errorMessage } from '../../lib/errors';
import { teamsKey } from '../../lib/queryKeys';
import type { TeamRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Checkbox from '../ui/checkbox';

/** Props for PullRequestLabelsSection. */
export interface PullRequestLabelsSectionProps {
  workspaceId: string;
  team: TeamRead;
  /** Whether the caller administers the team. */
  canEdit: boolean;
}

/** Shows and edits whether linked pull requests carry this team's issue labels. */
export const PullRequestLabelsSection: React.FC<
  PullRequestLabelsSectionProps
> = ({ workspaceId, team, canEdit }) => {
  const stored = team.sync_pr_labels ?? true;
  const [optimistic, setOptimistic] = useState<{
    value: boolean;
    over: boolean;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const checked =
    optimistic !== null && optimistic.over === stored
      ? optimistic.value
      : stored;

  const save = async (next: boolean): Promise<void> => {
    setOptimistic({ value: next, over: stored });
    setSaving(true);
    setError(null);
    try {
      await updateTeam(workspaceId, team.id, { sync_pr_labels: next });
      invalidateQueries(teamsKey(workspaceId));
    } catch (caught) {
      setOptimistic(null);
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Pull request labels</h3>
        <p className="text-sm text-text-muted">
          Add the labels of linked issues to the pull requests that name them,
          creating any label the repository is missing. Labels someone added on
          GitHub are never removed.
        </p>
      </div>
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not save the label setting.')}
        />
      )}
      <div className="rounded-md border border-line px-3 py-3">
        <Checkbox
          label="Sync issue labels to linked pull requests"
          checked={checked}
          disabled={!canEdit || saving}
          onChange={(event) => {
            void save(event.target.checked);
          }}
        />
      </div>
    </section>
  );
};

export default PullRequestLabelsSection;
