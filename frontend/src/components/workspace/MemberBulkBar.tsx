/**
 * The bar that rises while workspace members are selected, and the dialogs
 * behind it: change their role, add them to a team, suspend, reactivate or
 * remove them, each in one request. Suspend and remove ask first, naming how
 * many. The answer reports each member, so the summary after says how many
 * changed and how many were skipped and why, grouped by reason, rather than
 * failing the whole selection on one locked row. The API authorizes every
 * member on its own.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  LuBan,
  LuCheck,
  LuTrash2,
  LuUserCog,
  LuUserRoundCheck,
  LuUsers,
} from 'react-icons/lu';
import {
  useMutationWithRefetch,
  type QueryKey,
} from '@webbpulse/api-client/react';
import { listTeams } from '../../api/teams';
import { bulkUpdateMembers } from '../../api/workspaces';
import {
  assignableRoles,
  canGrantOwner,
  roleLabel,
} from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { memberName } from '../../lib/memberDirectory';
import { showToast } from '../../lib/toast';
import type {
  MemberBulkAction,
  MemberBulkRead,
  MemberBulkUpdate,
  MemberRead,
  TeamRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import BulkBar from '../issues/view/BulkBar';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import Spinner from '../ui/spinner';

/** Which dialog the bar has open, if any. */
export type MemberBulkDialog = 'role' | 'team' | 'suspend' | 'remove' | null;

/** Props for MemberBulkBar. */
export interface MemberBulkBarProps {
  workspace: WorkspaceRead;
  /** The selected members, in the order the list shows them. */
  members: readonly MemberRead[];
  /** The query keys a change reloads. */
  refetchKeys: readonly QueryKey[];
  onClear: () => void;
  /** Called as a dialog opens or closes, so the list can hand over the keyboard. */
  onDialogChange?: (open: boolean) => void;
}

/** A count of members in words. */
const plural = (count: number): string =>
  count === 1 ? '1 member' : `${String(count)} members`;

/** The past tense each action reports its changes in. */
const DONE: Record<MemberBulkAction, string> = {
  change_role: 'Changed the role of',
  suspend: 'Suspended',
  reactivate: 'Reactivated',
  remove: 'Removed',
  add_to_team: 'Added',
};

/** One reason members were skipped, with who. */
interface SkipGroup {
  message: string;
  names: string[];
}

/** The skipped results grouped by reason, each naming the members it held back. */
const skipGroups = (
  result: MemberBulkRead,
  members: readonly MemberRead[]
): SkipGroup[] => {
  const byId = new Map(members.map((member) => [member.user_id, member]));
  const groups = new Map<string, string[]>();
  result.results.forEach((entry) => {
    if (entry.outcome !== 'skipped') return;
    const message = entry.message ?? 'Could not change this member';
    const member = byId.get(entry.user_id);
    groups.set(message, [
      ...(groups.get(message) ?? []),
      member === undefined ? entry.user_id : memberName(member),
    ]);
  });
  return [...groups].map(([message, names]) => ({ message, names }));
};

/** The one-line summary of a bulk change: what changed, and how many stayed as they were or were skipped. */
const summarize = (
  action: MemberBulkAction,
  result: MemberBulkRead,
  team?: string
): string => {
  const parts: string[] = [];
  if (result.changed > 0)
    parts.push(
      `${DONE[action]} ${plural(result.changed)}${action === 'add_to_team' && team !== undefined ? ` to ${team}` : ''}.`
    );
  if (result.unchanged > 0)
    parts.push(`${plural(result.unchanged)} already up to date.`);
  if (result.skipped > 0) parts.push(`${plural(result.skipped)} skipped.`);
  return parts.join(' ') || 'Nothing changed.';
};

/** What the last bulk change reported, held until dismissed or replaced. */
interface Outcome {
  summary: string;
  skipped: SkipGroup[];
}

/** The bulk bar for the members list. Renders nothing with no selection. */
export const MemberBulkBar: React.FC<MemberBulkBarProps> = ({
  workspace,
  members,
  refetchKeys,
  onClear,
  onDialogChange,
}) => {
  const [dialog, setDialog] = useState<MemberBulkDialog>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [teams, setTeams] = useState<TeamRead[] | null>(null);
  const [teamsError, setTeamsError] = useState<unknown>(null);
  const count = members.length;
  const roles = useMemo(
    () =>
      assignableRoles(workspace.role).filter(
        (role) => role !== 'owner' || canGrantOwner(workspace.role)
      ),
    [workspace.role]
  );

  const {
    mutate: run,
    isMutating: busy,
    error,
    reset,
  } = useMutationWithRefetch(
    (payload: MemberBulkUpdate) => bulkUpdateMembers(workspace.id, payload),
    refetchKeys
  );

  useEffect(() => {
    onDialogChange?.(dialog !== null);
  }, [dialog, onDialogChange]);

  useEffect(() => {
    if (dialog !== 'team' || teams !== null) return;
    const controller = new AbortController();
    listTeams(workspace.id, controller.signal).then(
      (list) => {
        setTeams(list.filter((team) => team.retired_at == null));
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setTeamsError(failure);
      }
    );
    return () => {
      controller.abort();
    };
  }, [dialog, teams, workspace.id]);

  const open = (next: MemberBulkDialog): void => {
    reset();
    setDialog(next);
  };

  const close = (): void => {
    if (!busy) setDialog(null);
  };

  /** Sends one action for the whole selection and reports what happened to each member. */
  const apply = (
    action: MemberBulkAction,
    extra: { role?: WorkspaceRole; team?: TeamRead } = {}
  ): void => {
    const snapshot = [...members];
    const payload: MemberBulkUpdate = {
      action,
      user_ids: snapshot.map((member) => member.user_id),
      ...(extra.role === undefined ? {} : { role: extra.role }),
      ...(extra.team === undefined ? {} : { team_id: extra.team.id }),
    };
    void run(payload).then(
      (result) => {
        const summary = summarize(action, result, extra.team?.name);
        const skipped = skipGroups(result, snapshot);
        setDialog(null);
        onClear();
        if (skipped.length > 0) setOutcome({ summary, skipped });
        else {
          setOutcome(null);
          showToast(summary);
        }
      },
      () => undefined
    );
  };

  const failure =
    error === null ? null : (
      <ErrorAlert
        message={errorMessage(error, 'Could not change those members.')}
      />
    );

  return (
    <>
      {outcome !== null && (
        <div
          role="status"
          aria-label="Bulk change result"
          className="space-y-1 rounded-md border border-line bg-surface px-3 py-2 text-sm"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="font-medium">{outcome.summary}</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setOutcome(null);
              }}
            >
              Dismiss
            </Button>
          </div>
          <ul className="space-y-0.5 text-xs text-text-muted">
            {outcome.skipped.map((group) => (
              <li key={group.message}>
                {plural(group.names.length)} skipped: {group.message}.{' '}
                <span className="text-text-faint">
                  {group.names.join(', ')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <BulkBar
        count={count}
        label="Selected members"
        actions={[
          {
            id: 'role',
            label: 'Change role',
            icon: <LuUserCog className="h-3.5 w-3.5" />,
            onSelect: () => {
              open('role');
            },
          },
          {
            id: 'team',
            label: 'Add to team',
            icon: <LuUsers className="h-3.5 w-3.5" />,
            onSelect: () => {
              open('team');
            },
          },
          {
            id: 'suspend',
            label: 'Suspend',
            icon: <LuBan className="h-3.5 w-3.5" />,
            onSelect: () => {
              open('suspend');
            },
          },
          {
            id: 'reactivate',
            label: 'Reactivate',
            icon: <LuUserRoundCheck className="h-3.5 w-3.5" />,
            onSelect: () => {
              reset();
              apply('reactivate');
            },
          },
          {
            id: 'remove',
            label: 'Remove',
            icon: <LuTrash2 className="h-3.5 w-3.5" />,
            onSelect: () => {
              open('remove');
            },
          },
        ]}
        onClear={onClear}
      />

      {dialog === null && failure}

      <Dialog
        open={dialog === 'role'}
        onClose={close}
        title={`Change the role of ${plural(count)}`}
        size="sm"
      >
        <div className="space-y-3">
          {failure}
          <ul className="space-y-1">
            {roles.map((role) => (
              <li key={role}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    apply('change_role', { role });
                  }}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
                >
                  {roleLabel(role)}
                  {members.every((member) => member.role === role) && (
                    <LuCheck aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </Dialog>

      <Dialog
        open={dialog === 'team'}
        onClose={close}
        title={`Add ${plural(count)} to a team`}
        size="sm"
      >
        <div className="space-y-3">
          {failure}
          {teamsError !== null ? (
            <ErrorAlert
              message={errorMessage(teamsError, 'Could not load the teams.')}
            />
          ) : teams === null ? (
            <Spinner label="Loading teams" />
          ) : teams.length === 0 ? (
            <p className="text-sm text-text-muted">
              This workspace has no teams.
            </p>
          ) : (
            <ul className="max-h-72 space-y-1 overflow-y-auto">
              {teams.map((team) => (
                <li key={team.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      apply('add_to_team', { team });
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
                  >
                    <span className="truncate">{team.name}</span>
                    <span className="text-xs text-text-faint">
                      {team.key_prefix}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-text-muted">
            They join as team members. Anyone already on the team keeps their
            team role.
          </p>
        </div>
      </Dialog>

      <Dialog
        open={dialog === 'suspend' || dialog === 'remove'}
        onClose={close}
        title={
          dialog === 'remove'
            ? `Remove ${plural(count)} from ${workspace.name}`
            : `Suspend ${plural(count)}`
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            {dialog === 'remove'
              ? `They lose access to ${workspace.name} and leave every team here. Their issues and comments stay. Inviting them again does not restore their teams.`
              : `They lose access to ${workspace.name} at once, and every session, API key and connected app they hold stops working here. Their role, teams and history stay, and reactivating them restores the same access.`}
          </p>
          {failure}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={close}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={busy}
              onClick={() => {
                apply(dialog === 'remove' ? 'remove' : 'suspend');
              }}
            >
              {dialog === 'remove'
                ? `Remove ${plural(count)}`
                : `Suspend ${plural(count)}`}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
};

export default MemberBulkBar;
