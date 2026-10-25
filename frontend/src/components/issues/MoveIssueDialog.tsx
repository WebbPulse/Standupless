/**
 * Move to team: a searchable list of the teams the caller may write issues
 * in, opened from the rail, the issue menu, the palette, the bulk bar or
 * Cmd+Shift+M. Picking one moves every issue given, each taking the next key
 * in that team while its old key keeps resolving, so the issue page follows
 * its issue to the new address. A move maps what the target team cannot hold
 * on its own, so one pick covers the whole selection. The moves are recorded
 * as one undo, which moves the issues back.
 */

import React, { useState } from 'react';
import { LuUsers } from 'react-icons/lu';
import { issueCount, moveIssues } from '../../lib/bulkIssueActions';
import { useTeamsFor } from '../../hooks/useTeams';
import { canWriteIssues } from '../../lib/capabilities';
import { activeTeams } from '../../lib/teamRetirement';
import type { IssueRead, TeamRead, WorkspaceRole } from '../../types/Api';
import { Combobox, type ComboboxOption } from '../ui/combobox';
import Dialog from '../ui/dialog';
import { teamTree } from '../../lib/teamOrder';

/** The command's name, in the dialog, the menu and the palette. */
export const MOVE_ISSUE_LABEL = 'Move to team';

/** The keys that open the dialog, after Linear's. */
export const MOVE_ISSUE_KEYS = 'mod+shift+m';

/** Props for MoveIssueDialog. */
export interface MoveIssueDialogProps {
  open: boolean;
  workspaceId: string;
  workspaceRole: WorkspaceRole | undefined;
  /** The issues to move, one or a selection. */
  issues: readonly IssueRead[];
  teams: TeamRead[];
  onClose: () => void;
  /** Called with the issues as the moves answered them, under their new keys. */
  onMoved: (moved: IssueRead[]) => void;
}

/** The teams an issue may move to: the active ones the caller writes in. */
const moveTargets = (
  teams: TeamRead[],
  workspaceRole: WorkspaceRole | undefined
): TeamRead[] =>
  activeTeams(teams)
    .filter((team) => canWriteIssues(workspaceRole, team.role))
    .sort((left, right) => left.name.localeCompare(right.name));

/** The dialog. */
export const MoveIssueDialog: React.FC<MoveIssueDialogProps> = ({
  open,
  workspaceId,
  workspaceRole,
  issues,
  teams,
  onClose,
  onMoved,
}) => {
  const [busy, setBusy] = useState(false);
  if (!open || issues.length === 0) return null;
  const teamIds = [...new Set(issues.map((issue) => issue.team_id))];

  const targets = teamTree(moveTargets(teams, workspaceRole));
  const options: ComboboxOption[] = targets.map(
    ({ team, nested, parentName }) => ({
      value: team.id,
      label: team.name,
      detail: team.key_prefix,
      keywords: [
        team.key_prefix,
        ...(parentName === undefined ? [] : [parentName]),
      ],
      icon: <LuUsers className="h-3.5 w-3.5" />,
      disabled: busy,
      indent: nested,
    })
  );

  const pick = async (teamId: string): Promise<void> => {
    const target = teams.find((team) => team.id === teamId);
    if (
      target === undefined ||
      issues.every((issue) => issue.team_id === teamId)
    ) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      const moved = await moveIssues(workspaceId, issues, target);
      if (moved.length > 0) onMoved(moved);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  const subject = issueCount(issues);

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${MOVE_ISSUE_LABEL}, ${subject}`}
      hideTitle
      size="sm"
    >
      <div className="-mx-4 -mt-8 -mb-4">
        <p className="border-b border-line px-3 pt-2.5 pb-2 text-xs text-text-muted">
          <span className="rounded-sm bg-raised px-1.5 py-0.5 font-mono text-2xs text-text">
            {subject}
          </span>
        </p>
        <Combobox
          label={MOVE_ISSUE_LABEL}
          placeholder={`${MOVE_ISSUE_LABEL}...`}
          options={options}
          selected={teamIds.length === 1 ? teamIds : []}
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

/**
 * The dialog over the workspace's teams, read only once it mounts, for a
 * caller such as a list that does not hold them already.
 */
export const SelectionMoveDialog: React.FC<
  Omit<MoveIssueDialogProps, 'teams'>
> = (props) => {
  const { data: teams } = useTeamsFor(props.workspaceId, props.open);
  return <MoveIssueDialog {...props} teams={teams ?? []} />;
};

export default MoveIssueDialog;
