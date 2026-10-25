/**
 * The Members settings list's filter, search and sort, kept in the URL query
 * so a reload or a shared link shows the same rows. The keys carry a `member_`
 * prefix because the settings page holds other sections that read the query.
 */

import type { MemberRead, MemberStatus, WorkspaceRole } from '../types/Api';
import { roleLabel } from './capabilities';

/** A column the list sorts by. */
export type MemberSortKey = 'name' | 'email' | 'role' | 'joined';

/** Which way a sort runs. */
export type SortDirection = 'asc' | 'desc';

/** What the list shows and in which order. */
export interface MemberDirectoryState {
  query: string;
  roles: WorkspaceRole[];
  statuses: MemberStatus[];
  /** The chosen column, or null for the default order. */
  sort: MemberSortKey | null;
  direction: SortDirection;
}

/** Every role, highest first, which is also the role sort order. */
export const MEMBER_ROLES: readonly WorkspaceRole[] = [
  'owner',
  'admin',
  'member',
  'guest',
];

/** Every status, in the order the default sort groups them. */
export const MEMBER_STATUSES: readonly MemberStatus[] = [
  'active',
  'invited',
  'suspended',
];

const SORT_KEYS: readonly MemberSortKey[] = ['name', 'email', 'role', 'joined'];

/** The URL query keys the state is kept under. */
export const MEMBER_PARAMS = {
  query: 'member_q',
  role: 'member_role',
  status: 'member_status',
  sort: 'member_sort',
  direction: 'member_dir',
} as const;

/** How a status reads in the interface. */
export const statusLabel = (status: MemberStatus): string =>
  status === 'invited'
    ? 'Invited'
    : status === 'suspended'
      ? 'Suspended'
      : 'Active';

/** A member's status, with a row from before statuses read as active. */
export const memberStatus = (member: MemberRead): MemberStatus =>
  member.status ?? 'active';

/** The name a row shows and sorts by. */
export const memberName = (member: MemberRead): string =>
  member.full_name !== undefined && member.full_name !== ''
    ? member.full_name
    : (member.display_name ?? member.email);

const pick = <T extends string>(values: string[], allowed: readonly T[]): T[] =>
  allowed.filter((value) => values.includes(value));

/** Reads the list state from the URL query, dropping anything unknown. */
export const readDirectoryState = (
  params: URLSearchParams
): MemberDirectoryState => {
  const sort = params.get(MEMBER_PARAMS.sort);
  return {
    query: params.get(MEMBER_PARAMS.query) ?? '',
    roles: pick(params.getAll(MEMBER_PARAMS.role), MEMBER_ROLES),
    statuses: pick(params.getAll(MEMBER_PARAMS.status), MEMBER_STATUSES),
    sort: SORT_KEYS.find((key) => key === sort) ?? null,
    direction: params.get(MEMBER_PARAMS.direction) === 'desc' ? 'desc' : 'asc',
  };
};

/** Writes the list state into a copy of `params`, leaving other keys alone. */
export const writeDirectoryState = (
  params: URLSearchParams,
  state: MemberDirectoryState
): URLSearchParams => {
  const next = new URLSearchParams(params);
  Object.values(MEMBER_PARAMS).forEach((key) => next.delete(key));
  if (state.query !== '') next.set(MEMBER_PARAMS.query, state.query);
  state.roles.forEach((role) => next.append(MEMBER_PARAMS.role, role));
  state.statuses.forEach((status) => next.append(MEMBER_PARAMS.status, status));
  if (state.sort !== null) {
    next.set(MEMBER_PARAMS.sort, state.sort);
    if (state.direction === 'desc') next.set(MEMBER_PARAMS.direction, 'desc');
  }
  return next;
};

/** The state after a click on a column header: a new column sorts ascending, the same one flips. */
export const toggleSort = (
  state: MemberDirectoryState,
  key: MemberSortKey
): MemberDirectoryState =>
  state.sort === key
    ? { ...state, direction: state.direction === 'asc' ? 'desc' : 'asc' }
    : { ...state, sort: key, direction: 'asc' };

/** Adds `value` to a filter list, or takes it out when it is there. */
export const toggleValue = <T extends string>(values: T[], value: T): T[] =>
  values.includes(value)
    ? values.filter((current) => current !== value)
    : [...values, value];

const collator = new Intl.Collator(undefined, { sensitivity: 'base' });

const compareBy = (
  key: MemberSortKey,
  left: MemberRead,
  right: MemberRead
): number => {
  switch (key) {
    case 'email':
      return collator.compare(left.email, right.email);
    case 'role':
      return MEMBER_ROLES.indexOf(left.role) - MEMBER_ROLES.indexOf(right.role);
    case 'joined':
      return Date.parse(left.joined_at) - Date.parse(right.joined_at);
    default:
      return collator.compare(memberName(left), memberName(right));
  }
};

/**
 * The rows the state selects, in its order. A search matches the name, handle
 * and email by substring. The default order groups active, invited and then
 * suspended members, each by name; a chosen column sorts every row by it.
 */
export const applyDirectoryState = (
  members: readonly MemberRead[],
  state: MemberDirectoryState
): MemberRead[] => {
  const needle = state.query.trim().toLowerCase();
  const rows = members.filter((member) => {
    if (state.roles.length > 0 && !state.roles.includes(member.role)) {
      return false;
    }
    if (
      state.statuses.length > 0 &&
      !state.statuses.includes(memberStatus(member))
    ) {
      return false;
    }
    if (needle === '') return true;
    return [memberName(member), member.display_name ?? '', member.email].some(
      (text) => text.toLowerCase().includes(needle)
    );
  });
  const sign = state.direction === 'desc' ? -1 : 1;
  return rows.sort((left, right) => {
    if (state.sort === null) {
      const group =
        MEMBER_STATUSES.indexOf(memberStatus(left)) -
        MEMBER_STATUSES.indexOf(memberStatus(right));
      return group !== 0 ? group : compareBy('name', left, right);
    }
    const order = compareBy(state.sort, left, right);
    return order !== 0
      ? sign * order
      : collator.compare(memberName(left), memberName(right));
  });
};

/** The CSV rows for `members`, header first, with each member's team names from `teams`. */
export const memberCsvRows = (
  members: readonly MemberRead[],
  teams: ReadonlyMap<string, readonly string[]>
): string[][] => [
  ['Name', 'Email', 'Role', 'Status', 'Joined', 'Teams'],
  ...members.map((member) => [
    memberName(member),
    member.email,
    roleLabel(member.role),
    statusLabel(memberStatus(member)),
    member.joined_at.slice(0, 10),
    [...(teams.get(member.user_id) ?? [])].sort(collator.compare).join('; '),
  ]),
];
