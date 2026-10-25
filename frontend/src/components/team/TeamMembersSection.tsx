/**
 * The members of one team, with the role grant and removal controls. The
 * grant route is a PUT on a user id, so new members are added by picking any
 * number of the workspace's members who do not yet hold a team role, and each
 * pick is granted on its own, a few at a time. Rows can be checked to change
 * the role of, or remove, several members at once.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  invalidateQueries,
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  listTeamMembers,
  removeTeamMember,
  setTeamMember,
} from '../../api/teams';
import { listMembers } from '../../api/workspaces';
import { roleLabel } from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { membersKey, teamMembersKey } from '../../lib/queryKeys';
import { showToast } from '../../lib/toast';
import {
  BATCH_CONCURRENCY,
  LAST_OWNER_REASON,
  batchSummary,
  maskEmail,
  removesLastOwner,
  runBounded,
} from '../../lib/teamMemberBatch';
import type { TeamRole } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Avatar from '../ui/avatar';
import Button from '../ui/button';
import Combobox, { type ComboboxOption } from '../ui/combobox';
import Label from '../ui/label';
import Popover from '../ui/popover';
import { Select, SelectField } from '../ui/select';
import Spinner from '../ui/spinner';

/**
 * Props for TeamMembersSection: which team, whether the caller may edit,
 * and whether the caller may read the workspace roster to add from.
 */
export interface TeamMembersSectionProps {
  workspaceId: string;
  teamId: string;
  canEdit: boolean;
  canReadWorkspaceMembers: boolean;
}

/** How often the team member list is re-read while the tab is open. */
const POLL_MS = 30000;

/** The roles a team member may hold. */
const TEAM_ROLES: TeamRole[] = ['admin', 'member'];

/** One bulk action on the checked rows. */
type BulkAction = 'admin' | 'member' | 'remove';

/** Lists and edits a team's members. */
export const TeamMembersSection: React.FC<TeamMembersSectionProps> = ({
  workspaceId,
  teamId,
  canEdit,
  canReadWorkspaceMembers,
}) => {
  const auth = useQueryAuth();
  const queryKey = teamMembersKey(teamId);
  const [picked, setPicked] = useState<string[]>([]);
  const [role, setRole] = useState<TeamRole>('member');
  const [adding, setAdding] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const { data, error, isLoading } = usePolledQuery(
    (context) => listTeamMembers(workspaceId, teamId, context),
    {
      intervalMs: POLL_MS,
      queryKey,
      auth,
    }
  );

  const { data: workspaceMembers } = usePolledQuery(
    (context) => listMembers(workspaceId, context),
    {
      intervalMs: POLL_MS,
      enabled: canEdit && canReadWorkspaceMembers,
      queryKey: membersKey(workspaceId),
      auth,
    }
  );

  const { mutate: grant, error: grantError } = useMutationWithRefetch(
    (targetId: string, targetRole: TeamRole) =>
      setTeamMember(workspaceId, teamId, targetId, { role: targetRole }),
    queryKey
  );

  const { mutate: remove, error: removeError } = useMutationWithRefetch(
    (targetId: string) => removeTeamMember(workspaceId, teamId, targetId),
    queryKey
  );

  const members = data ?? [];
  const existing = new Set(members.map((member) => member.user_id));
  const addable = (workspaceMembers ?? []).filter(
    (member) => !existing.has(member.user_id)
  );
  const addableIds = new Set(addable.map((member) => member.user_id));
  const chosen = picked.filter((id) => addableIds.has(id));
  const canSubmit = chosen.length > 0 && !adding;

  const options: ComboboxOption[] = addable.map((member) => {
    const name = member.display_name ?? member.email;
    return {
      value: member.user_id,
      label: name,
      detail: maskEmail(member.email),
      keywords: [member.email, member.full_name ?? ''],
      icon: <Avatar name={name} src={member.avatar_url} size="xs" />,
    };
  });

  const togglePick = (id: string): void => {
    setPicked((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id]
    );
  };

  const pickedNames = chosen.map((id) => {
    const member = addable.find((item) => item.user_id === id);
    return member?.display_name ?? member?.email ?? id;
  });
  const triggerText =
    pickedNames.length === 0
      ? 'Choose people'
      : pickedNames.length <= 2
        ? pickedNames.join(', ')
        : `${pickedNames.slice(0, 2).join(', ')} +${String(pickedNames.length - 2)}`;

  const onSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!canSubmit) return;
    const batch = [...chosen];
    setAdding(true);
    void runBounded(batch, BATCH_CONCURRENCY, (id) =>
      setTeamMember(workspaceId, teamId, id, { role })
    )
      .then((failed) => {
        invalidateQueries(queryKey);
        showToast(
          batchSummary('Added', batch.length, failed.length),
          failed.length === 0 ? 'info' : 'error'
        );
        setPicked(failed);
        if (failed.length === 0) setRole('member');
      })
      .finally(() => {
        setAdding(false);
      });
  };

  const visibleChecked = new Set([...checked].filter((id) => existing.has(id)));
  const allChecked =
    members.length > 0 && visibleChecked.size === members.length;
  const lastOwnerBlocked = removesLastOwner(members, visibleChecked);

  const toggleRow = (id: string): void => {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = (): void => {
    setChecked(
      allChecked ? new Set() : new Set(members.map((member) => member.user_id))
    );
  };

  const runBulk = (action: BulkAction): void => {
    if (bulkBusy || visibleChecked.size === 0) return;
    if (action !== 'admin' && lastOwnerBlocked) return;
    const batch = members
      .filter((member) => visibleChecked.has(member.user_id))
      .filter((member) => action === 'remove' || member.role !== action)
      .map((member) => member.user_id);
    if (batch.length === 0) {
      setChecked(new Set());
      return;
    }
    setBulkBusy(true);
    void runBounded(batch, BATCH_CONCURRENCY, (id) =>
      action === 'remove'
        ? removeTeamMember(workspaceId, teamId, id)
        : setTeamMember(workspaceId, teamId, id, { role: action })
    )
      .then((failed) => {
        invalidateQueries(queryKey);
        showToast(
          batchSummary(
            action === 'remove' ? 'Removed' : 'Updated',
            batch.length,
            failed.length
          ),
          failed.length === 0 ? 'info' : 'error'
        );
        setChecked(new Set(failed));
      })
      .finally(() => {
        setBulkBusy(false);
      });
  };

  const columns = cn(
    'grid items-center gap-3 px-3',
    canEdit
      ? 'grid-cols-[auto_minmax(0,1fr)_auto]'
      : 'grid-cols-[minmax(0,1fr)_auto]'
  );

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Team members</h3>
        <p className="text-sm text-text-muted">
          People who hold a role on this team directly, on top of what the
          workspace gives them.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the team members.')}
        />
      )}
      {grantError !== null && (
        <ErrorAlert
          message={errorMessage(grantError, 'Could not set that role.')}
        />
      )}
      {removeError !== null && (
        <ErrorAlert
          message={errorMessage(removeError, 'Could not remove that member.')}
        />
      )}

      {canEdit && visibleChecked.size > 0 && (
        <div
          role="toolbar"
          aria-label="Selected team members"
          className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-2"
        >
          <span className="text-sm text-text">
            {visibleChecked.size} selected
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={bulkBusy}
              onClick={() => {
                runBulk('admin');
              }}
            >
              Make team owner
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={bulkBusy || lastOwnerBlocked}
              title={lastOwnerBlocked ? LAST_OWNER_REASON : undefined}
              onClick={() => {
                runBulk('member');
              }}
            >
              Make member
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={bulkBusy || lastOwnerBlocked}
              title={lastOwnerBlocked ? LAST_OWNER_REASON : undefined}
              onClick={() => {
                runBulk('remove');
              }}
            >
              Remove from team
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={bulkBusy}
              onClick={() => {
                setChecked(new Set());
              }}
            >
              Clear
            </Button>
          </div>
          {lastOwnerBlocked && (
            <p className="w-full text-xs text-text-muted">
              {LAST_OWNER_REASON}
            </p>
          )}
        </div>
      )}

      {isLoading || data === null ? (
        <Spinner label="Loading team members" />
      ) : data.length === 0 ? (
        <p className="text-sm text-text-muted">
          No one holds a role on this team directly.
        </p>
      ) : (
        <div className="rounded-md border border-line">
          <div
            className={`${columns} h-8 border-b border-line bg-surface text-xs font-medium text-text-muted`}
          >
            {canEdit && (
              <input
                type="checkbox"
                aria-label="Select all team members"
                checked={allChecked}
                onChange={toggleAll}
              />
            )}
            <span>Member</span>
            <span>Role</span>
          </div>
          <ul>
            {data.map((member) => (
              <li
                key={member.user_id}
                className={`${columns} min-h-row border-b border-line py-1 transition-colors duration-100 last:border-b-0 hover:bg-surface`}
              >
                {canEdit && (
                  <input
                    type="checkbox"
                    aria-label={`Select ${member.display_name ?? member.email}`}
                    checked={visibleChecked.has(member.user_id)}
                    onChange={() => {
                      toggleRow(member.user_id);
                    }}
                  />
                )}
                <div className="flex min-w-0 items-center gap-2">
                  <Avatar
                    name={member.display_name ?? member.email}
                    src={member.avatar_url}
                    size="sm"
                  />
                  <div className="min-w-0">
                    <p className="truncate font-medium text-text">
                      {member.display_name ?? member.email}
                    </p>
                    <p className="hidden truncate text-xs text-text-muted sm:block">
                      {member.email}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {canEdit ? (
                    <Select
                      aria-label={`Team role for ${member.email}`}
                      className="w-28"
                      value={member.role}
                      onChange={(event) => {
                        void grant(
                          member.user_id,
                          event.target.value as TeamRole
                        ).catch(() => undefined);
                      }}
                    >
                      {TEAM_ROLES.map((item) => (
                        <option key={item} value={item}>
                          {roleLabel(item)}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <span className="text-xs text-text-muted">
                      {roleLabel(member.role)}
                    </span>
                  )}
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void remove(member.user_id).catch(() => undefined);
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {canEdit && canReadWorkspaceMembers && addable.length > 0 && (
        <form
          className="space-y-4 rounded-md border border-line p-4"
          onSubmit={onSubmit}
        >
          <div className="grid max-w-md gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
            <div className="space-y-1">
              <Label htmlFor="team-member-user">Add members</Label>
              <Popover
                label="Add members"
                block
                contentClassName="w-72"
                trigger={(trigger) => (
                  <button
                    type="button"
                    id="team-member-user"
                    aria-label={`Add members: ${triggerText}`}
                    {...trigger}
                    className={cn(
                      'flex h-9 w-full items-center truncate rounded-md border border-line px-3 text-left text-sm',
                      'hover:border-line-strong hover:bg-raised',
                      chosen.length === 0 ? 'text-text-muted' : 'text-text'
                    )}
                  >
                    <span className="truncate">{triggerText}</span>
                  </button>
                )}
              >
                <Combobox
                  label="Add members"
                  placeholder="Search people"
                  emptyMessage="No one matches"
                  options={options}
                  selected={chosen}
                  multiple
                  onSelect={togglePick}
                />
              </Popover>
            </div>

            <SelectField
              id="team-member-role"
              label="Role"
              value={role}
              onChange={(event) => {
                setRole(event.target.value as TeamRole);
              }}
            >
              {TEAM_ROLES.map((item) => (
                <option key={item} value={item}>
                  {roleLabel(item)}
                </option>
              ))}
            </SelectField>
          </div>

          <Button type="submit" variant="primary" disabled={!canSubmit}>
            {adding
              ? 'Adding'
              : chosen.length === 0
                ? 'Add to team'
                : `Add ${String(chosen.length)} to team`}
          </Button>
        </form>
      )}
    </section>
  );
};

export default TeamMembersSection;
