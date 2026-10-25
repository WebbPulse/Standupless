/**
 * The danger zone at the bottom of a team's settings: retiring and deleting
 * the team.
 *
 * It sits last, after every section a team admin edits, so a destructive
 * action is never the next thing below a routine one. Retiring is offered to
 * team admins and keeps the team's work readable, so it asks once and can be
 * undone. Deleting is offered only to workspace owners and admins, which is
 * what the delete route checks, and asks for the team's key before it goes
 * ahead.
 */

import React, { useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { Link, useNavigate } from 'react-router-dom';
import { deleteTeam, retireTeam, unretireTeam } from '../../api/teams';
import { errorMessage } from '../../lib/errors';
import { settingsTeamsPath, teamPath } from '../../lib/paths';
import { teamsKey } from '../../lib/queryKeys';
import { isRetired, openIssueCount } from '../../lib/teamRetirement';
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
  /** Whether the caller may retire or un-retire the team, which is team admin work. */
  canRetire: boolean;
  /** Whether the caller may delete the team, which is workspace admin work. */
  canDelete: boolean;
}

/** Props for the retire confirmation. */
interface RetireTeamDialogProps {
  workspaceId: string;
  slug: string;
  team: TeamRead;
  onClose: () => void;
}

/**
 * Confirms retiring a team, saying what changes: the team leaves the sidebar
 * and the pickers, and its work turns read-only until someone un-retires it.
 * A team with open issues is refused, and the dialog then links to them.
 */
const RetireTeamDialog: React.FC<RetireTeamDialogProps> = ({
  workspaceId,
  slug,
  team,
  onClose,
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openCount, setOpenCount] = useState<number | null>(null);

  const onConfirm = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setOpenCount(null);
    try {
      await retireTeam(workspaceId, team.id);
      invalidateQueries(teamsKey(workspaceId));
      onClose();
    } catch (caught) {
      setError(errorMessage(caught, 'Could not retire the team.'));
      setOpenCount(openIssueCount(caught));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Retire ${team.name}`}
      description="The team leaves the sidebar and the team pickers. Its issues, projects and cycles stay readable and searchable but can no longer be changed. You can un-retire it from workspace settings."
      size="sm"
    >
      <div className="space-y-4">
        {error !== null && <ErrorAlert message={error} />}
        {openCount !== null && (
          <p className="text-sm text-text-muted">
            <Link
              to={`${teamPath(slug, team.key_prefix)}?done=0`}
              className="font-medium text-accent hover:underline"
            >
              View {openCount} open {openCount === 1 ? 'issue' : 'issues'}
            </Link>
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={busy}
            onClick={() => {
              void onConfirm();
            }}
          >
            {busy ? 'Retiring' : 'Retire team'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};

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

/** The danger zone section of a team's settings, holding Retire team and Delete team. */
export const TeamDangerZoneSection: React.FC<TeamDangerZoneSectionProps> = ({
  workspaceId,
  slug,
  team,
  canRetire,
  canDelete,
}) => {
  const [deleting, setDeleting] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const retired = isRetired(team);

  const restore = async (): Promise<void> => {
    setRestoring(true);
    setRestoreError(null);
    try {
      await unretireTeam(workspaceId, team.id);
      invalidateQueries(teamsKey(workspaceId));
    } catch (caught) {
      setRestoreError(errorMessage(caught, 'Could not un-retire the team.'));
    } finally {
      setRestoring(false);
    }
  };

  return (
    <section className="space-y-4">
      <h3 className="text-base font-semibold">Danger zone</h3>
      {canRetire && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger/40 px-4 py-3">
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium text-text">
                {retired ? 'Un-retire team' : 'Retire team'}
              </p>
              <p className="text-xs text-text-muted">
                {retired
                  ? 'Brings the team back to the sidebar and lets its work change again.'
                  : 'Hides the team and makes its work read-only. You can undo this.'}
              </p>
            </div>
            {retired ? (
              <Button
                type="button"
                variant="secondary"
                disabled={restoring}
                onClick={() => {
                  void restore();
                }}
              >
                {restoring ? 'Un-retiring' : 'Un-retire team'}
              </Button>
            ) : (
              <Button
                type="button"
                variant="danger"
                onClick={() => {
                  setRetiring(true);
                }}
              >
                Retire team
              </Button>
            )}
          </div>
          {restoreError !== null && <ErrorAlert message={restoreError} />}
        </div>
      )}
      {canDelete && (
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
      )}

      {retiring && (
        <RetireTeamDialog
          workspaceId={workspaceId}
          slug={slug}
          team={team}
          onClose={() => {
            setRetiring(false);
          }}
        />
      )}

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
