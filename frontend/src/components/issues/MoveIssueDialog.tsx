/**
 * Move to team: a searchable list of the teams the caller may write issues
 * in, opened from the rail, the issue menu, the palette or Cmd+Shift+M.
 * Picking one moves the issue, which takes the next key in that team while
 * the old key keeps resolving, so the page follows it to the new address.
 */

import React, { useState } from 'react';
import { LuUsers } from 'react-icons/lu';
import { moveIssue } from '../../api/issues';
import { canWriteIssues } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { showErrorToast, showToast } from '../../lib/toast';
import type { IssueRead, TeamRead, WorkspaceRole } from '../../types/Api';
import { Combobox, type ComboboxOption } from '../ui/combobox';
import Dialog from '../ui/dialog';

/** The command's name, in the dialog, the menu and the palette. */
export const MOVE_ISSUE_LABEL = 'Move to team';

/** The keys that open the dialog, after Linear's. */
export const MOVE_ISSUE_KEYS = 'mod+shift+m';

/** Props for MoveIssueDialog. */
export interface MoveIssueDialogProps {
  open: boolean;
  workspaceId: string;
  workspaceRole: WorkspaceRole | undefined;
  issue: IssueRead;
  teams: TeamRead[];
  onClose: () => void;
  /** Called with the issue as the move answered it, under its new key. */
  onMoved: (moved: IssueRead) => void;
}

/** The teams an issue may move to, which are the ones the caller writes in. */
const moveTargets = (
  teams: TeamRead[],
  workspaceRole: WorkspaceRole | undefined
): TeamRead[] =>
  teams
    .filter((team) => canWriteIssues(workspaceRole, team.role))
    .sort((left, right) => left.name.localeCompare(right.name));

/** The dialog. */
export const MoveIssueDialog: React.FC<MoveIssueDialogProps> = ({
  open,
  workspaceId,
  workspaceRole,
  issue,
  teams,
  onClose,
  onMoved,
}) => {
  const [busy, setBusy] = useState(false);
  if (!open) return null;

  const options: ComboboxOption[] = moveTargets(teams, workspaceRole).map(
    (team) => ({
      value: team.id,
      label: team.name,
      detail: team.key_prefix,
      keywords: [team.key_prefix],
      icon: <LuUsers className="h-3.5 w-3.5" />,
      disabled: busy,
    })
  );

  const pick = async (teamId: string): Promise<void> => {
    if (teamId === issue.team_id) {
      onClose();
      return;
    }
    const target = teams.find((team) => team.id === teamId);
    setBusy(true);
    try {
      const moved = await moveIssue(workspaceId, issue.id, teamId);
      showToast(
        `Moved ${issue.key} to ${target?.name ?? 'the team'} as ${moved.key}`
      );
      onMoved(moved);
      onClose();
    } catch (cause) {
      showErrorToast(errorMessage(cause, 'Could not move that issue.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${MOVE_ISSUE_LABEL}, ${issue.key}`}
      hideTitle
      size="sm"
    >
      <div className="-mx-4 -mt-8 -mb-4">
        <p className="border-b border-line px-3 pt-2.5 pb-2 text-xs text-text-muted">
          <span className="rounded-sm bg-raised px-1.5 py-0.5 font-mono text-2xs text-text">
            {issue.key}
          </span>
        </p>
        <Combobox
          label={MOVE_ISSUE_LABEL}
          placeholder={`${MOVE_ISSUE_LABEL}...`}
          options={options}
          selected={[issue.team_id]}
          emptyMessage="No other team you can write in."
          onSelect={(teamId) => {
            void pick(teamId);
          }}
        />
      </div>
    </Dialog>
  );
};

/** Props for IssueTeamRow. */
export interface IssueTeamRowProps {
  team: TeamRead;
  canMove: boolean;
  onMove: () => void;
}

/** The rail's team value, which opens the move dialog when the caller may move. */
export const IssueTeamRow: React.FC<IssueTeamRowProps> = ({
  team,
  canMove,
  onMove,
}) => (
  <button
    type="button"
    disabled={!canMove}
    aria-label={`Team: ${team.name}`}
    onClick={onMove}
    className="inline-flex min-h-7 w-full min-w-0 shrink-0 items-center justify-start gap-2 rounded-sm px-2 py-1 text-left text-sm text-text transition-colors duration-100 select-none enabled:hover:bg-raised disabled:cursor-default"
  >
    <span
      aria-hidden="true"
      className="flex w-4 shrink-0 items-center justify-center text-text-muted"
    >
      <LuUsers className="h-3.5 w-3.5" />
    </span>
    <span className="min-w-0 truncate">{team.name}</span>
  </button>
);

export default MoveIssueDialog;
