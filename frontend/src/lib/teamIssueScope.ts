/**
 * The preset tabs a team's issues open on: every issue, the active ones in an
 * unstarted or started status, and the backlog. The URL's `scope` parameter
 * carries the choice, so a link or a reload lands on the same tab, and the
 * filters and display options in the URL apply on top of the preset.
 *
 * Each preset remembers the display a viewer last left it in, kept in this
 * browser only and per team and page, so Active can stay a board while the
 * backlog stays a list. What is held is only the display parameters that
 * differ from the team's default, so a change to that default still reaches
 * every preset the viewer has not changed.
 */

import type { IssueListFilters } from '../api/issues';
import type { ViewLayout } from '../api/views';
import type { StatusCategory } from '../types/Api';
import { teamPath } from './paths';

/** One of a team's preset issue tabs. */
export type TeamIssueScope = 'all' | 'active' | 'backlog';

/** The presets in tab order, with the label each tab reads. */
export const TEAM_ISSUE_SCOPES: { scope: TeamIssueScope; label: string }[] = [
  { scope: 'all', label: 'All issues' },
  { scope: 'active', label: 'Active' },
  { scope: 'backlog', label: 'Backlog' },
];

/** The URL parameter that carries the preset. */
export const SCOPE_PARAM = 'scope';

/** The URL parameters that hold display options rather than filters. */
export const DISPLAY_PARAMS: readonly string[] = [
  'group',
  'sub',
  'order',
  'rev',
  'props',
  'layout',
  'empty',
  'subs',
  'done',
  'archived',
];

/** The prefix each preset's remembered display is stored under. */
export const SCOPE_DISPLAY_STORAGE_PREFIX = 'standupless-team-scope-display:';

/** The preset the URL names, or every issue when it names none it knows. */
export const parseTeamIssueScope = (
  params: URLSearchParams
): TeamIssueScope => {
  const value = params.get(SCOPE_PARAM);
  return value === 'active' || value === 'backlog' ? value : 'all';
};

/** The list query a preset adds to the team's own scope. */
export const teamScopeFilters = (scope: TeamIssueScope): IssueListFilters => {
  switch (scope) {
    case 'active':
      return { status_category: ['unstarted', 'started'] };
    case 'backlog':
      return { status_category: 'backlog' };
    default:
      return {};
  }
};

/** The status categories each narrowing preset covers. */
const SCOPE_CATEGORIES: Record<
  Exclude<TeamIssueScope, 'all'>,
  readonly StatusCategory[]
> = {
  active: ['unstarted', 'started'],
  backlog: ['backlog'],
};

/** The status categories a preset covers, or undefined when it covers every one. */
export const teamScopeCategories = (
  scope: TeamIssueScope
): readonly StatusCategory[] | undefined =>
  scope === 'all' ? undefined : SCOPE_CATEGORIES[scope];

/** The empty list message for a preset of the named team. */
export const teamScopeEmptyMessage = (
  scope: TeamIssueScope,
  teamName: string
): string => {
  switch (scope) {
    case 'active':
      return `No active issues in ${teamName} match.`;
    case 'backlog':
      return `No backlog issues in ${teamName} match.`;
    default:
      return `No issues in ${teamName} match.`;
  }
};

/** Writes a preset into URL parameters, leaving the parameter out for every issue. */
const setScope = (params: URLSearchParams, scope: TeamIssueScope): void => {
  if (scope === 'all') params.delete(SCOPE_PARAM);
  else params.set(SCOPE_PARAM, scope);
};

/** A team's issues opened on a preset. */
export const teamScopePath = (
  slug: string,
  keyPrefix: string,
  scope: TeamIssueScope
): string => {
  const params = new URLSearchParams();
  setScope(params, scope);
  const query = params.toString();
  return `${teamPath(slug, keyPrefix)}${query === '' ? '' : `?${query}`}`;
};

/**
 * Where a preset tab leads from the page showing now: the same filters and
 * every other parameter kept, the display options dropped so the preset
 * reopens in its own remembered display.
 */
export const teamScopeHref = (
  pathname: string,
  params: URLSearchParams,
  scope: TeamIssueScope
): string => {
  const next = new URLSearchParams();
  for (const [key, value] of params.entries()) {
    if (!DISPLAY_PARAMS.includes(key)) next.append(key, value);
  }
  setScope(next, scope);
  const query = next.toString();
  return `${pathname}${query === '' ? '' : `?${query}`}`;
};

/** The display parameters a set of URL parameters holds, alone. */
export const displayParams = (params: URLSearchParams): URLSearchParams => {
  const held = new URLSearchParams();
  for (const [key, value] of params.entries()) {
    if (DISPLAY_PARAMS.includes(key)) held.append(key, value);
  }
  return held;
};

/** The storage key one preset of one team's page is remembered under. */
export const scopeDisplayKey = (
  teamId: string,
  layout: ViewLayout,
  scope: TeamIssueScope
): string => `${SCOPE_DISPLAY_STORAGE_PREFIX}${teamId}:${layout}:${scope}`;

/** The display parameters remembered under a key, or null when none are held. */
export const readScopeDisplay = (
  storageKey: string
): URLSearchParams | null => {
  try {
    const held = globalThis.localStorage.getItem(storageKey);
    if (held === null) return null;
    const params = displayParams(new URLSearchParams(held));
    return params.toString() === '' ? null : params;
  } catch {
    return null;
  }
};

/** Remembers the display parameters of `params`, dropping the entry when there are none. */
export const writeScopeDisplay = (
  storageKey: string,
  params: URLSearchParams
): void => {
  const held = displayParams(params).toString();
  try {
    if (held === '') globalThis.localStorage.removeItem(storageKey);
    else globalThis.localStorage.setItem(storageKey, held);
  } catch {
    return;
  }
};

/**
 * The URL parameters with a remembered display laid in, or null when there
 * is nothing to restore: none is held, or the URL already sets a display
 * option of its own, which a link someone sent always wins over.
 */
export const withScopeDisplay = (
  params: URLSearchParams,
  stored: URLSearchParams | null
): URLSearchParams | null => {
  if (stored === null || displayParams(params).toString() !== '') return null;
  const next = new URLSearchParams(params);
  for (const [key, value] of stored.entries()) next.append(key, value);
  return next;
};
