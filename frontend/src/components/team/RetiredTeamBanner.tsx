/**
 * The notice a retired team's pages open with. The team's work stays readable,
 * so the banner says why nothing can be changed and, for someone who
 * administers the team, offers to bring it back.
 */

import React, { useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { LuArchive } from 'react-icons/lu';
import { unretireTeam } from '../../api/teams';
import { errorMessage } from '../../lib/errors';
import { teamsKey } from '../../lib/queryKeys';
import { isRetired } from '../../lib/teamRetirement';
import type { TeamRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';

/** Props for RetiredTeamBanner. */
export interface RetiredTeamBannerProps {
  workspaceId: string;
  team: TeamRead;
  /** Whether the caller may un-retire the team, which is team admin work. */
  canUnretire: boolean;
}

/** A read-only notice for a retired team, or nothing for an active one. */
export const RetiredTeamBanner: React.FC<RetiredTeamBannerProps> = ({
  workspaceId,
  team,
  canUnretire,
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!isRetired(team)) return null;

  const restore = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await unretireTeam(workspaceId, team.id);
      invalidateQueries(teamsKey(workspaceId));
    } catch (caught) {
      setError(errorMessage(caught, 'Could not un-retire the team.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2" role="status">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-raised px-3 py-2">
        <p className="flex items-center gap-2 text-sm text-text-muted">
          <LuArchive aria-hidden="true" className="h-4 w-4 shrink-0" />
          {team.name} is retired. Its issues, projects and cycles are read-only.
        </p>
        {canUnretire && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              void restore();
            }}
          >
            {busy ? 'Un-retiring' : 'Un-retire'}
          </Button>
        )}
      </div>
      {error !== null && <ErrorAlert message={error} />}
    </div>
  );
};

export default RetiredTeamBanner;
