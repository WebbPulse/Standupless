/**
 * The member list of one workspace: active, suspended and invited people, a
 * role and status filter, a name and email search, sortable columns and a CSV
 * export of the rows shown. Each row's overflow menu changes the role,
 * suspends or reactivates, and removes. A workspace admin can also tick rows,
 * with a Shift click for a run, the header box for every row the filter
 * shows, or x and Shift with j, k or an arrow, and act on all of them at once
 * from the bulk bar, and Enter opens the member in focus. The filter, search
 * and sort live in the URL query so a reload keeps them. Controls are hidden
 * by the caller's role for clarity only; the API authorizes every call.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  LuArrowDown,
  LuArrowUp,
  LuCheck,
  LuDownload,
  LuEllipsis,
  LuSearch,
} from 'react-icons/lu';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import { listTeamMembers, listTeams } from '../../api/teams';
import {
  listMemberDirectory,
  reactivateMember,
  removeMember,
  revokeInvite,
  suspendMember,
  updateMember,
} from '../../api/workspaces';
import { useAuth } from '../../hooks/useAuth';
import { useListKeyboardNav } from '../../hooks/useListKeyboardNav';
import { useProjectSelection } from '../../hooks/useProjectSelection';
import {
  assignableRoles,
  canGrantOwner,
  canManageMembers,
  roleLabel,
} from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import { toCsv } from '../../lib/csv';
import { downloadText, fileSlug, todayStamp } from '../../lib/download';
import { memberPath } from '../../lib/paths';
import { errorMessage } from '../../lib/errors';
import {
  MEMBER_ROLES,
  MEMBER_STATUSES,
  applyDirectoryState,
  memberCsvRows,
  memberName,
  memberStatus,
  readDirectoryState,
  statusLabel,
  toggleSort,
  toggleValue,
  writeDirectoryState,
  type MemberDirectoryState,
  type MemberSortKey,
} from '../../lib/memberDirectory';
import {
  invitesKey,
  memberDirectoryKey,
  membersKey,
} from '../../lib/queryKeys';
import { showErrorToast, showToast } from '../../lib/toast';
import type {
  MemberRead,
  MemberStatus,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Avatar from '../ui/avatar';
import { awayNote, isAway, statusSummary } from '../../lib/userStatus';
import Badge from '../ui/badge';
import Button, { IconButton } from '../ui/button';
import Dialog from '../ui/dialog';
import FilterButton from '../ui/filter-button';
import Input from '../ui/input';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../ui/menu';
import Spinner from '../ui/spinner';
import MemberLink from '../members/MemberLink';
import MemberBulkBar from './MemberBulkBar';

/** Props for MembersSection: the workspace whose members are shown. */
export interface MembersSectionProps {
  workspace: WorkspaceRead;
}

/** How often the member list is re-read while the settings page is open. */
const POLL_MS = 30000;

/** The column layout the header and every row share. */
const COLUMNS =
  'grid grid-cols-[minmax(0,1fr)_5rem_1.75rem] items-center gap-3 px-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_5rem_6rem_1.75rem]';

/** The same layout with a leading checkbox column, for a caller who can select rows. */
const SELECT_COLUMNS =
  'grid grid-cols-[1rem_minmax(0,1fr)_5rem_1.75rem] items-center gap-3 px-3 sm:grid-cols-[1rem_minmax(0,1.2fr)_minmax(0,1fr)_5rem_6rem_1.75rem]';

/** The header checkbox: ticked when every selectable row is, mixed when some are. */
const SelectAllBox: React.FC<{
  count: number;
  total: number;
  onChange: () => void;
}> = ({ count, total, onChange }) => {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current !== null)
      ref.current.indeterminate = count > 0 && count < total;
  }, [count, total]);
  return (
    <span role="columnheader" className="flex items-center justify-center">
      <input
        ref={ref}
        type="checkbox"
        aria-label="Select all members shown"
        disabled={total === 0}
        checked={total > 0 && count === total}
        onChange={onChange}
        className="h-3.5 w-3.5 cursor-pointer accent-accent"
      />
    </span>
  );
};

const ADMIN_STATUSES: readonly MemberStatus[] = MEMBER_STATUSES;
const MEMBER_ONLY_STATUSES: readonly MemberStatus[] = ['active', 'suspended'];

const joinedFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** A sortable column heading that shows its direction once chosen. */
const SortHeader: React.FC<{
  label: string;
  column: MemberSortKey;
  state: MemberDirectoryState;
  onSort: (column: MemberSortKey) => void;
  className?: string;
}> = ({ label, column, state, onSort, className }) => {
  const active = state.sort === column;
  const Arrow = state.direction === 'desc' ? LuArrowDown : LuArrowUp;
  return (
    <span
      role="columnheader"
      aria-sort={
        active
          ? state.direction === 'desc'
            ? 'descending'
            : 'ascending'
          : 'none'
      }
      className={className}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          'inline-flex items-center gap-1 rounded-sm hover:text-text focus-visible:text-text',
          active ? 'text-text' : ''
        )}
      >
        {label}
        {active && <Arrow aria-hidden="true" className="h-3 w-3" />}
      </button>
    </span>
  );
};

/** Lists the workspace's members, filters, sorts and exports them, and changes, suspends or removes them. */
export const MembersSection: React.FC<MembersSectionProps> = ({
  workspace,
}) => {
  const auth = useQueryAuth();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const stored = useMemo(() => readDirectoryState(params), [params]);
  const [query, setQuery] = useState(stored.query);
  const state = useMemo(() => ({ ...stored, query }), [stored, query]);
  const manages = canManageMembers(workspace.role);
  const statuses = manages ? ADMIN_STATUSES : MEMBER_ONLY_STATUSES;
  const queryKey = memberDirectoryKey(workspace.id);
  const refetchKeys = [
    queryKey,
    membersKey(workspace.id),
    invitesKey(workspace.id),
  ];
  const [suspending, setSuspending] = useState<MemberRead | null>(null);
  const [exporting, setExporting] = useState(false);
  const [bulkDialog, setBulkDialog] = useState(false);
  const onBulkDialog = useCallback((open: boolean) => {
    setBulkDialog(open);
  }, []);

  const { data, error, isLoading } = usePolledQuery(
    (context) => listMemberDirectory(workspace.id, statuses, context),
    {
      intervalMs: POLL_MS,
      queryKey,
      auth,
    }
  );

  const { mutate: changeRole, error: roleError } = useMutationWithRefetch(
    (userId: string, role: WorkspaceRole) =>
      updateMember(workspace.id, userId, { role }),
    refetchKeys
  );

  const { mutate: remove, error: removeError } = useMutationWithRefetch(
    (member: MemberRead) =>
      member.invite_id !== undefined && member.invite_id !== null
        ? revokeInvite(workspace.id, member.invite_id)
        : removeMember(workspace.id, member.user_id),
    refetchKeys
  );

  const {
    mutate: suspend,
    isMutating: suspendBusy,
    error: suspendError,
  } = useMutationWithRefetch(
    (userId: string) => suspendMember(workspace.id, userId),
    refetchKeys
  );

  const { mutate: reactivate, error: reactivateError } = useMutationWithRefetch(
    (userId: string) => reactivateMember(workspace.id, userId),
    refetchKeys
  );

  const roles = assignableRoles(workspace.role);
  const rows = useMemo(
    () => (data === null ? [] : applyDirectoryState(data, state)),
    [data, state]
  );
  const filtered =
    state.query !== '' || state.roles.length > 0 || state.statuses.length > 0;

  const selectable = useCallback(
    (member: MemberRead): boolean =>
      manages &&
      memberStatus(member) !== 'invited' &&
      member.user_id !== user?.id,
    [manages, user?.id]
  );
  const order = useMemo(
    () => rows.filter(selectable).map((member) => member.user_id),
    [rows, selectable]
  );
  const idle = manages && suspending === null && !bulkDialog;
  const { activeIndex, setActiveIndex, registerItem } = useListKeyboardNav({
    count: rows.length,
    onActivate: (index) => {
      const member = rows[index];
      if (member !== undefined && memberStatus(member) !== 'invited')
        void navigate(memberPath(workspace.slug, member.user_id));
    },
    resetKey: rows.map((member) => member.user_id).join(','),
    enabled: idle,
  });
  const focused = rows[activeIndex];
  const {
    selected,
    toggle: toggleSelected,
    selectAll,
    clear: clearSelection,
  } = useProjectSelection({
    order,
    focusedId:
      focused !== undefined && selectable(focused) ? focused.user_id : null,
    onFocus: (userId) => {
      setActiveIndex(rows.findIndex((member) => member.user_id === userId));
    },
    enabled: idle,
    label: 'Select member',
  });
  const selectedMembers = rows.filter((member) => selected.has(member.user_id));
  const columns = manages ? SELECT_COLUMNS : COLUMNS;

  const update = (next: MemberDirectoryState): void => {
    setParams((current) => writeDirectoryState(current, next), {
      replace: true,
    });
  };

  const exportCsv = async (): Promise<void> => {
    setExporting(true);
    try {
      const teams = await listTeams(workspace.id);
      const rosters = await Promise.all(
        teams.map((team) => listTeamMembers(workspace.id, team.id))
      );
      const byMember = new Map<string, string[]>();
      teams.forEach((team, index) => {
        (rosters[index] ?? []).forEach((member) => {
          byMember.set(member.user_id, [
            ...(byMember.get(member.user_id) ?? []),
            team.name,
          ]);
        });
      });
      downloadText(
        toCsv(memberCsvRows(rows, byMember)),
        `${fileSlug(`${workspace.name} members`)}-${todayStamp()}.csv`
      );
      showToast('Export downloaded.');
    } catch (exportError) {
      showErrorToast(
        errorMessage(exportError, 'Could not export the members.')
      );
    } finally {
      setExporting(false);
    }
  };

  const confirmSuspend = (): void => {
    if (suspending === null) return;
    void suspend(suspending.user_id)
      .then(() => setSuspending(null))
      .catch(() => undefined);
  };

  const failures: [unknown, string][] = [
    [error, 'Could not load the members.'],
    [roleError, 'Could not change that role.'],
    [removeError, 'Could not remove that member.'],
    [reactivateError, 'Could not reactivate that member.'],
  ];

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Members</h2>
        <p className="text-sm text-text-muted">
          Everyone in this workspace, with the role they hold across it.
        </p>
      </div>

      {failures.map(([failure, fallback]) =>
        failure === null ? null : (
          <ErrorAlert
            key={fallback}
            message={errorMessage(failure, fallback)}
          />
        )
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-56">
          <LuSearch
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-text-faint"
          />
          <Input
            type="search"
            aria-label="Search members"
            placeholder="Search by name or email"
            className="pl-7"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              update({ ...state, query: event.target.value });
            }}
          />
        </div>
        <FilterButton
          field="Role"
          multiple
          options={MEMBER_ROLES.map((role) => ({
            value: role,
            label: roleLabel(role),
          }))}
          selected={state.roles}
          onSelect={(value) =>
            update({
              ...state,
              roles: toggleValue(state.roles, value as WorkspaceRole),
            })
          }
        />
        <FilterButton
          field="Status"
          multiple
          options={statuses.map((status) => ({
            value: status,
            label: statusLabel(status),
          }))}
          selected={state.statuses}
          onSelect={(value) =>
            update({
              ...state,
              statuses: toggleValue(state.statuses, value as MemberStatus),
            })
          }
        />
        {filtered && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setQuery('');
              update({ ...state, query: '', roles: [], statuses: [] });
            }}
          >
            Clear
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto gap-1.5"
          disabled={exporting || rows.length === 0}
          aria-busy={exporting}
          onClick={() => void exportCsv()}
        >
          <LuDownload aria-hidden="true" className="h-3.5 w-3.5" />
          {exporting ? 'Exporting...' : 'Export CSV'}
        </Button>
      </div>

      {isLoading || data === null ? (
        <Spinner label="Loading members" />
      ) : data.length === 0 ? (
        <p className="text-sm text-text-muted">
          This workspace has no members.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-text-muted">No members match.</p>
      ) : (
        <div
          role="table"
          aria-label="Members"
          className="rounded-md border border-line"
        >
          <div
            role="row"
            className={`${columns} h-8 border-b border-line bg-surface text-xs font-medium text-text-muted`}
          >
            {manages && (
              <SelectAllBox
                count={selected.size}
                total={order.length}
                onChange={() => {
                  if (order.length > 0 && selected.size === order.length)
                    clearSelection();
                  else selectAll();
                }}
              />
            )}
            <SortHeader
              label="Name"
              column="name"
              state={state}
              onSort={(column) => update(toggleSort(state, column))}
            />
            <SortHeader
              label="Email"
              column="email"
              state={state}
              className="hidden sm:block"
              onSort={(column) => update(toggleSort(state, column))}
            />
            <SortHeader
              label="Role"
              column="role"
              state={state}
              onSort={(column) => update(toggleSort(state, column))}
            />
            <SortHeader
              label="Joined"
              column="joined"
              state={state}
              className="hidden sm:block"
              onSort={(column) => update(toggleSort(state, column))}
            />
            <span role="columnheader" className="sr-only">
              Actions
            </span>
          </div>
          {rows.map((member, index) => {
            const status = memberStatus(member);
            const canSelect = selectable(member);
            const isSelected = selected.has(member.user_id);
            const name = memberName(member);
            const isSelf = user?.id === member.user_id;
            const ownerLocked =
              member.role === 'owner' && !canGrantOwner(workspace.role);
            const roleChoices = roles.includes(member.role)
              ? roles
              : [member.role, ...roles];
            return (
              <div
                role="row"
                key={member.user_id}
                ref={registerItem(index)}
                aria-selected={canSelect ? isSelected : undefined}
                aria-current={
                  manages && index === activeIndex ? 'true' : undefined
                }
                onPointerEnter={
                  manages
                    ? () => {
                        setActiveIndex(index);
                      }
                    : undefined
                }
                className={cn(
                  columns,
                  'min-h-row border-b border-line py-1 transition-colors duration-100 last:border-b-0 hover:bg-surface',
                  manages && index === activeIndex && 'bg-surface',
                  isSelected && 'bg-accent-soft hover:bg-accent-soft'
                )}
              >
                {manages && (
                  <span
                    role="cell"
                    className="flex items-center justify-center"
                  >
                    {canSelect && (
                      <input
                        type="checkbox"
                        aria-label={`Select ${name}`}
                        checked={isSelected}
                        onChange={(event) => {
                          toggleSelected(
                            member.user_id,
                            (event.nativeEvent as MouseEvent).shiftKey
                          );
                        }}
                        className="h-3.5 w-3.5 cursor-pointer accent-accent"
                      />
                    )}
                  </span>
                )}
                <div role="cell" className="flex min-w-0 items-center gap-2">
                  <MemberLink
                    userId={status === 'invited' ? null : member.user_id}
                    className={cn(
                      'flex min-w-0 items-center gap-2',
                      status === 'active' ? '' : 'opacity-60'
                    )}
                  >
                    <Avatar
                      name={name}
                      src={member.avatar_url}
                      away={isAway(member.user_status)}
                    />
                    <span className="truncate text-sm font-medium">{name}</span>
                  </MemberLink>
                  {statusSummary(member.user_status) !== '' && (
                    <span
                      className="min-w-0 truncate text-xs text-text-muted"
                      title={awayNote(member.user_status) ?? undefined}
                      data-testid="member-status"
                    >
                      {statusSummary(member.user_status)}
                    </span>
                  )}
                  {status !== 'active' && (
                    <Badge
                      tone={status === 'suspended' ? 'warning' : 'neutral'}
                    >
                      {statusLabel(status)}
                    </Badge>
                  )}
                </div>
                <span
                  role="cell"
                  className="hidden min-w-0 truncate text-xs text-text-muted sm:block"
                >
                  {member.email}
                </span>
                <span role="cell" className="text-xs text-text-muted">
                  {roleLabel(member.role)}
                </span>
                <span
                  role="cell"
                  className="hidden text-xs text-text-muted sm:block"
                >
                  {joinedFormat.format(new Date(member.joined_at))}
                </span>
                <div role="cell" className="flex justify-end">
                  {manages && (
                    <Menu
                      label={`Actions for ${name}`}
                      align="end"
                      trigger={(trigger) => (
                        <IconButton
                          label={`Actions for ${name}`}
                          size="sm"
                          {...trigger}
                        >
                          <LuEllipsis className="h-3.5 w-3.5" />
                        </IconButton>
                      )}
                    >
                      {status !== 'invited' && (
                        <>
                          <MenuLabel>Change role</MenuLabel>
                          {roleChoices.map((role) => (
                            <MenuItem
                              key={role}
                              disabled={
                                role === member.role ||
                                ownerLocked ||
                                (role === 'owner' &&
                                  !canGrantOwner(workspace.role))
                              }
                              onSelect={() => {
                                void changeRole(member.user_id, role).catch(
                                  () => undefined
                                );
                              }}
                            >
                              <span className="flex-1">{roleLabel(role)}</span>
                              {role === member.role && (
                                <LuCheck
                                  aria-hidden="true"
                                  className="h-3.5 w-3.5"
                                />
                              )}
                            </MenuItem>
                          ))}
                          <MenuSeparator />
                          {status === 'suspended' ? (
                            <MenuItem
                              disabled={ownerLocked}
                              onSelect={() => {
                                void reactivate(member.user_id).catch(
                                  () => undefined
                                );
                              }}
                            >
                              Reactivate user
                            </MenuItem>
                          ) : (
                            <MenuItem
                              disabled={isSelf || ownerLocked}
                              onSelect={() => setSuspending(member)}
                            >
                              Suspend user
                            </MenuItem>
                          )}
                        </>
                      )}
                      <MenuItem
                        danger
                        disabled={ownerLocked}
                        onSelect={() => {
                          void remove(member).catch(() => undefined);
                        }}
                      >
                        {status === 'invited'
                          ? 'Revoke invite'
                          : 'Remove from workspace'}
                      </MenuItem>
                    </Menu>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {manages && (
        <MemberBulkBar
          workspace={workspace}
          members={selectedMembers}
          refetchKeys={refetchKeys}
          onClear={clearSelection}
          onDialogChange={onBulkDialog}
        />
      )}

      <Dialog
        open={suspending !== null}
        onClose={() => {
          if (!suspendBusy) setSuspending(null);
        }}
        title={`Suspend ${suspending === null ? '' : memberName(suspending)}`}
      >
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            They lose access to {workspace.name} at once, and every session, API
            key and connected app they hold stops working here. Their role,
            teams and history stay, and reactivating them restores the same
            access.
          </p>
          {suspendError !== null && (
            <ErrorAlert
              message={errorMessage(
                suspendError,
                'Could not suspend that member.'
              )}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={suspendBusy}
              onClick={() => setSuspending(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={suspendBusy}
              onClick={confirmSuspend}
            >
              Suspend user
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
};

export default MembersSection;
