/**
 * The danger zone at the bottom of a team's settings: deleting the team.
 *
 * It sits last, after every section a team admin edits, so a destructive
 * action is never the next thing below a routine one. Deleting is offered
 * only to workspace owners and admins, which is what the delete route checks,
 * and asks for the team's key before it goes ahead.
 */

import React, { useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { useNavigate } from 'react-router-dom';
import { deleteTeam } from '../../api/teams';
import { errorMessage } from '../../lib/errors';
import { settingsTeamsPath } from '../../lib/paths';
import { teamsKey } from '../../lib/queryKeys';
import type { TeamRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import Field from '../ui/field';

/** Props for TeamDangerZoneSection. */
export interface TeamDangerZoneSectionProps {
  workspaceId: string;
  slug: string;
  team: TeamRead;
}

/** Props for the delete confirmation. */
interface DeleteTeamDialogProps {
  workspaceId: string;
  slug: string;
  team: TeamRead;
  onClose: () => void;
}

/**
 * Asks for the team's key before deleting it, because a deleted team takes
 * its workflow with it and cuts its issues off, and a single click is too easy
 * to make by mistake.
 */
const DeleteTeamDialog: React.FC<DeleteTeamDialogProps> = ({
  workspaceId,
  slug,
  team,
  onClose,
}) => {
  const navigate = useNavigate();
  const [typed, setTyped] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim().toUpperCase() === team.key_prefix;

  const onConfirm = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!matches || isDeleting) return;
    setIsDeleting(true);
    setError(null);
    try {
      await deleteTeam(workspaceId, team.id);
      invalidateQueries(teamsKey(workspaceId));
      void navigate(settingsTeamsPath(slug));
    } catch (caught) {
      setError(errorMessage(caught, 'Could not delete the team.'));
      setIsDeleting(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Delete ${team.name}`}
      description="This removes the team, its statuses and its labels. Its issues can no longer be opened from the team. It cannot be undone."
      size="sm"
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          void onConfirm(event);
        }}
      >
        {error !== null && <ErrorAlert message={error} />}
        <Field
          id="delete-team-confirm"
          label={`Type ${team.key_prefix} to confirm`}
          value={typed}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          onChange={(event) => {
            setTyped(event.target.value);
          }}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="danger"
            disabled={!matches || isDeleting}
          >
            {isDeleting ? 'Deleting' : 'Delete team'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

/** The danger zone section of a team's settings, holding Delete team. */
export const TeamDangerZoneSection: React.FC<TeamDangerZoneSectionProps> = ({
  workspaceId,
  slug,
  team,
}) => {
  const [deleting, setDeleting] = useState(false);

  return (
    <section className="space-y-4">
      <h3 className="text-base font-semibold">Danger zone</h3>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger/40 px-4 py-3">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium text-text">Delete team</p>
          <p className="text-xs text-text-muted">
            Removes the team and its workflow. This cannot be undone.
          </p>
        </div>
        <Button
          type="button"
          variant="danger"
          onClick={() => {
            setDeleting(true);
          }}
        >
          Delete team
        </Button>
      </div>

      {deleting && (
        <DeleteTeamDialog
          workspaceId={workspaceId}
          slug={slug}
          team={team}
          onClose={() => {
            setDeleting(false);
          }}
        />
      )}
    </section>
  );
};

export default TeamDangerZoneSection;
