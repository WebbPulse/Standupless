/**
 * The projects page's property filters: health, priority, members, start and
 * target date bounds, and how long ago the last project update was posted.
 * They mirror the projects list route's `health`, `priority`, `member_id`,
 * `*_date_before` and `*_date_after`, `updated_within_days` and
 * `not_updated_within_days` parameters, with the same reading: a date bound is
 * exclusive and a project with no date meets none, `none` stands for no health
 * or no members, and a project never updated counts as not updated. This is
 * the one place that maps them between the URL, a saved view's filter and a
 * project row, so the page, a view and the server agree on what a filter keeps.
 */

import type { ProjectViewFilter } from '../api/views';
import { isDayBound, resolveDayBound, utcToday } from './filterDays';
import type { ProjectRead } from '../types/Api';

/** The property filters as the page holds them, each empty when unset. */
export interface ProjectPropertyFilters {
  /** Healths kept, `none` for projects nobody has judged. */
  health: string[];
  /** Priorities kept, `none` among them. */
  priority: string[];
  /** Member user ids kept, `none` for projects with no members. */
  member: string[];
  /** Exclusive `YYYY-MM-DD` bounds on the start date. */
  startBefore: string;
  startAfter: string;
  /** Exclusive `YYYY-MM-DD` bounds on the target date. */
  targetBefore: string;
  targetAfter: string;
  /** Whole days: keep projects updated within them. */
  updatedWithin: string;
  /** Whole days: keep projects not updated within them, never updated included. */
  notUpdatedWithin: string;
}

/** One property filter's name. */
export type PropertyFilterKey = keyof ProjectPropertyFilters;

/** The filters that hold several values. */
export type PropertyListKey = 'health' | 'priority' | 'member';

/** The filters that hold one value. */
export type PropertyScalarKey = Exclude<PropertyFilterKey, PropertyListKey>;

/** The value standing for no health, or no members. */
export const NO_VALUE = 'none';

/** No property filter set. */
export const EMPTY_PROPERTY_FILTERS: ProjectPropertyFilters = {
  health: [],
  priority: [],
  member: [],
  startBefore: '',
  startAfter: '',
  targetBefore: '',
  targetAfter: '',
  updatedWithin: '',
  notUpdatedWithin: '',
};

/** Every property filter in the order the menu offers them. */
export const PROPERTY_FILTER_KEYS: readonly PropertyFilterKey[] = [
  'health',
  'priority',
  'member',
  'startBefore',
  'startAfter',
  'targetBefore',
  'targetAfter',
  'updatedWithin',
  'notUpdatedWithin',
];

const LIST_KEYS: ReadonlySet<PropertyFilterKey> = new Set([
  'health',
  'priority',
  'member',
]);

/** Whether a filter holds several values. */
export const isListKey = (key: PropertyFilterKey): key is PropertyListKey =>
  LIST_KEYS.has(key);

/** The URL parameter each filter rides in. */
export const PROPERTY_PARAMS: Record<PropertyFilterKey, string> = {
  health: 'health',
  priority: 'priority',
  member: 'member',
  startBefore: 'start_before',
  startAfter: 'start_after',
  targetBefore: 'target_before',
  targetAfter: 'target_after',
  updatedWithin: 'updated_within',
  notUpdatedWithin: 'not_updated_within',
};

/** The saved view filter key each filter is stored under, the route's own parameter name. */
export const PROPERTY_VIEW_KEYS: Record<
  PropertyFilterKey,
  keyof ProjectViewFilter
> = {
  health: 'health',
  priority: 'priority',
  member: 'member_id',
  startBefore: 'start_date_before',
  startAfter: 'start_date_after',
  targetBefore: 'target_date_before',
  targetAfter: 'target_date_after',
  updatedWithin: 'updated_within_days',
  notUpdatedWithin: 'not_updated_within_days',
};

const HEALTHS = new Set(['on_track', 'at_risk', 'off_track', NO_VALUE]);

const PRIORITIES = new Set(['none', 'urgent', 'high', 'medium', 'low']);

const WHOLE_DAYS = /^[1-9]\d{0,3}$/;

/** The widest update age a filter takes, the route's own ceiling. */
export const MAX_UPDATE_AGE_DAYS = 3650;

/** A stored value that may be one text or a list of them, as a list. */
const asList = (value: string | readonly string[] | undefined): string[] =>
  value === undefined ? [] : typeof value === 'string' ? [value] : [...value];

/** A list filter's values with the ones it cannot take dropped, each once. */
const cleanList = (
  key: PropertyListKey,
  values: readonly string[]
): string[] => {
  const kept = values.filter((value) =>
    key === 'health'
      ? HEALTHS.has(value)
      : key === 'priority'
        ? PRIORITIES.has(value)
        : value !== ''
  );
  return [...new Set(kept)];
};

/** A scalar filter's value, empty when it is not one the route takes. */
const cleanScalar = (key: PropertyScalarKey, value: string): string => {
  if (key === 'updatedWithin' || key === 'notUpdatedWithin') {
    return WHOLE_DAYS.test(value) && Number(value) <= MAX_UPDATE_AGE_DAYS
      ? value
      : '';
  }
  return isDayBound(value) ? value : '';
};

/** One filter's value as URL text, a list joined by commas. */
export const propertyParamText = (
  filters: ProjectPropertyFilters,
  key: PropertyFilterKey
): string => (isListKey(key) ? filters[key].join(',') : filters[key]);

/** The filters with one of them read from its URL text. */
const withParamText = (
  filters: ProjectPropertyFilters,
  key: PropertyFilterKey,
  text: string
): ProjectPropertyFilters =>
  isListKey(key)
    ? { ...filters, [key]: cleanList(key, text.split(',')) }
    : { ...filters, [key]: cleanScalar(key, text) };

/**
 * The filters the page runs: each from the URL when it carries one, else the
 * open view's, so the URL only holds what differs from the view.
 */
export const readPropertyFilters = (
  params: URLSearchParams,
  base: ProjectPropertyFilters = EMPTY_PROPERTY_FILTERS
): ProjectPropertyFilters =>
  PROPERTY_FILTER_KEYS.reduce(
    (filters, key) =>
      withParamText(
        filters,
        key,
        params.get(PROPERTY_PARAMS[key]) ?? propertyParamText(base, key)
      ),
    EMPTY_PROPERTY_FILTERS
  );

/** The property filters a saved view of projects holds. */
export const propertyFiltersFromView = (
  filter: ProjectViewFilter
): ProjectPropertyFilters =>
  PROPERTY_FILTER_KEYS.reduce((filters, key) => {
    const stored = filter[PROPERTY_VIEW_KEYS[key]];
    return isListKey(key)
      ? { ...filters, [key]: cleanList(key, asList(stored)) }
      : { ...filters, [key]: cleanScalar(key, asList(stored)[0] ?? '') };
  }, EMPTY_PROPERTY_FILTERS);

/** The saved view filter keys for the set filters, nothing for the unset ones. */
export const propertyFiltersToView = (
  filters: ProjectPropertyFilters
): Partial<ProjectViewFilter> => {
  const stored: Record<string, string | string[]> = {};
  for (const key of PROPERTY_FILTER_KEYS) {
    const value = filters[key];
    if (Array.isArray(value) ? value.length === 0 : value === '') continue;
    stored[PROPERTY_VIEW_KEYS[key]] = Array.isArray(value) ? [...value] : value;
  }
  return stored;
};

/** Whether two saved filters hold the same property filters, list order aside. */
export const samePropertyFilters = (
  left: ProjectViewFilter,
  right: ProjectViewFilter
): boolean => {
  const a = propertyFiltersFromView(left);
  const b = propertyFiltersFromView(right);
  return PROPERTY_FILTER_KEYS.every((key) => {
    const x = a[key];
    const y = b[key];
    return Array.isArray(x) && Array.isArray(y)
      ? [...x].sort().join(',') === [...y].sort().join(',')
      : x === y;
  });
};

/** Whether any property filter is set. */
export const hasPropertyFilters = (filters: ProjectPropertyFilters): boolean =>
  PROPERTY_FILTER_KEYS.some((key) => {
    const value = filters[key];
    return Array.isArray(value) ? value.length > 0 : value !== '';
  });

/** A stored day against exclusive bounds; a project without the date meets no bound. */
const within = (
  day: string | null | undefined,
  after: string,
  before: string
): boolean => {
  if (after === '' && before === '') return true;
  if (day === null || day === undefined || day === '') return false;
  const value = day.slice(0, 10);
  if (before !== '' && !(value < before)) return false;
  if (after !== '' && !(value > after)) return false;
  return true;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether the newest project update falls inside and outside the asked windows. */
const updateAgeMatches = (
  lastUpdateAt: string | null | undefined,
  now: Date,
  updatedWithin: string,
  notUpdatedWithin: string
): boolean => {
  const last =
    lastUpdateAt === null || lastUpdateAt === undefined
      ? null
      : Date.parse(lastUpdateAt);
  const age = last === null || Number.isNaN(last) ? null : now.getTime() - last;
  if (
    updatedWithin !== '' &&
    (age === null || age > Number(updatedWithin) * DAY_MS)
  ) {
    return false;
  }
  if (
    notUpdatedWithin !== '' &&
    age !== null &&
    age <= Number(notUpdatedWithin) * DAY_MS
  ) {
    return false;
  }
  return true;
};

/** Whether one project passes every set property filter, update age measured back from `now`. */
export const matchesPropertyFilters = (
  project: ProjectRead,
  filters: ProjectPropertyFilters,
  now: Date
): boolean => {
  if (
    filters.health.length > 0 &&
    !filters.health.includes(project.health ?? NO_VALUE)
  ) {
    return false;
  }
  if (
    filters.priority.length > 0 &&
    !filters.priority.includes(project.priority ?? 'none')
  ) {
    return false;
  }
  if (filters.member.length > 0) {
    const held = project.member_ids;
    const kept =
      (filters.member.includes(NO_VALUE) && held.length === 0) ||
      filters.member.some((member) => held.includes(member));
    if (!kept) return false;
  }
  const today = utcToday(now);
  const bound = (value: string): string =>
    value === '' ? '' : resolveDayBound(value, today);
  if (
    !within(
      project.start_date,
      bound(filters.startAfter),
      bound(filters.startBefore)
    )
  ) {
    return false;
  }
  if (
    !within(
      project.target_date,
      bound(filters.targetAfter),
      bound(filters.targetBefore)
    )
  ) {
    return false;
  }
  return updateAgeMatches(
    project.last_update_at,
    now,
    filters.updatedWithin,
    filters.notUpdatedWithin
  );
};
