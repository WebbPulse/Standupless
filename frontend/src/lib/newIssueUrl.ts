/**
 * Prefilled new issue links. `/w/:slug/new` and `/w/:slug/team/:keyPrefix/new`
 * open the workspace with the create dialog already showing, its fields set
 * from the query: `title`, `description`, `team`, `status`, `priority`,
 * `assignee`, `estimate`, `cycle`, `label` or `labels`, `project`,
 * `projectMilestone`, `template` and `links`.
 *
 * Parsing reads the query into raw values; resolution matches each one against
 * the team's statuses, labels, people, cycles, projects, milestones and
 * templates by id or by name, case insensitively. A value that matches nothing
 * is dropped and the rest still apply, so a stale link opens a dialog with
 * what it can still set. Nothing here creates an issue.
 */

import type {
  CycleRead,
  IssuePriority,
  IssueRead,
  LabelRead,
  MilestoneRead,
  ProjectRead,
  StatusRead,
  TeamMemberRead,
  TeamRead,
  TemplateRead,
} from '../types/Api';
import type { CreateIssueOptions } from '../hooks/useCreateIssue';
import { teamPath, workspacePath } from './paths';

/** One link a prefilled issue starts with, attached once it is created. */
export interface NewIssueLink {
  url: string;
  title?: string;
}

/** The raw values a `/new` query carries, each still to be resolved. */
export interface NewIssueParams {
  title?: string;
  description?: string;
  team?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  estimate?: string;
  cycle?: string;
  labels: string[];
  project?: string;
  projectMilestone?: string;
  template?: string;
  links: NewIssueLink[];
}

/** What resolution matches the raw values against, each list optional. */
export interface NewIssueLookups {
  /** The signed in person, whom `assignee=me` names. */
  viewerId?: string;
  statuses?: StatusRead[];
  labels?: LabelRead[];
  people?: TeamMemberRead[];
  cycles?: CycleRead[];
  projects?: ProjectRead[];
  milestones?: MilestoneRead[];
  templates?: TemplateRead[];
  /** The estimates the team's scale offers; absent accepts none. */
  estimates?: string[];
}

/** The fields a prefilled link is built from, in the query's own terms. */
export interface NewIssueUrlFields {
  title?: string;
  description?: string;
  team?: string;
  status?: string;
  priority?: IssuePriority;
  assignee?: string;
  estimate?: string;
  cycle?: string;
  labels?: string[];
  project?: string;
  projectMilestone?: string;
  template?: string;
  links?: NewIssueLink[];
}

/** The priorities a link may name. */
const PRIORITIES: readonly IssuePriority[] = [
  'urgent',
  'high',
  'medium',
  'low',
  'none',
];

/** The path segment both create routes end in. */
const NEW_SEGMENT = 'new';

/** Whether a path is one of the two prefilled create routes. */
export const isNewIssuePath = (pathname: string): boolean =>
  /^\/w\/[^/]+(\/team\/[^/]+)?\/new\/?$/.test(pathname);

/** The create route of a workspace, or of one team in it. */
export const newIssueBasePath = (slug: string, keyPrefix?: string): string =>
  `${keyPrefix === undefined ? workspacePath(slug) : teamPath(slug, keyPrefix)}/${NEW_SEGMENT}`;

/** The query value trimmed, or undefined when absent or blank. */
const single = (query: URLSearchParams, name: string): string | undefined => {
  const value = query.get(name)?.trim() ?? '';
  return value === '' ? undefined : value;
};

/** Every comma separated value across the named keys, trimmed, blanks dropped. */
const listOf = (query: URLSearchParams, names: string[]): string[] =>
  names
    .flatMap((name) => query.getAll(name))
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value !== '');

/** A `url|title` entry as a link, or null when the URL is not http or https. */
const linkOf = (entry: string): NewIssueLink | null => {
  const bar = entry.indexOf('|');
  const raw = (bar === -1 ? entry : entry.slice(0, bar)).trim();
  const title = bar === -1 ? '' : entry.slice(bar + 1).trim();
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
  } catch {
    return null;
  }
  return title === '' ? { url: raw } : { url: raw, title };
};

/**
 * Reads a `/new` query into raw values. `+` reads as a space, as a form
 * encoded query has it, and blank values are left out.
 */
export const parseNewIssueParams = (search: string): NewIssueParams => {
  const query = new URLSearchParams(search);
  const fields: Omit<NewIssueParams, 'labels' | 'links'> = {};
  const names = [
    'title',
    'description',
    'team',
    'status',
    'priority',
    'assignee',
    'estimate',
    'cycle',
    'project',
    'projectMilestone',
    'template',
  ] as const;
  for (const name of names) {
    const value = single(query, name);
    if (value !== undefined) fields[name] = value;
  }
  const description = query.get('description');
  if (description !== null && description.trim() !== '') {
    fields.description = description;
  }
  return {
    ...fields,
    labels: listOf(query, ['label', 'labels']),
    links: listOf(query, ['links', 'link']).flatMap((entry) => {
      const link = linkOf(entry);
      return link === null ? [] : [link];
    }),
  };
};

/** Whether two names match, ignoring case and surrounding space. */
const sameName = (left: string, right: string): boolean =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

/**
 * The row whose id is the value, or else the first whose any name matches it,
 * so an id always wins over a row named like another's id.
 */
const byIdOrName = <T>(
  value: string,
  rows: readonly T[],
  idOf: (row: T) => string,
  namesOf: (row: T) => (string | null | undefined)[]
): T | undefined =>
  rows.find((row) => idOf(row) === value) ??
  rows.find((row) =>
    namesOf(row).some((name) => name != null && sameName(name, value))
  );

/** The team a link names by id, key prefix or name, among the teams given. */
export const resolveTeam = (
  value: string,
  teams: readonly TeamRead[]
): TeamRead | undefined =>
  byIdOrName(
    value,
    teams,
    (team) => team.id,
    (team) => [team.key_prefix, team.name]
  );

/** The priority a link names, or undefined for a word that is not one. */
const priorityOf = (value: string): IssuePriority | undefined =>
  PRIORITIES.find((priority) => sameName(priority, value));

/** The person a link names by id, `me`, name or email. */
const personOf = (
  value: string,
  lookups: NewIssueLookups
): string | undefined => {
  if (sameName(value, 'me')) return lookups.viewerId;
  return byIdOrName(
    value,
    lookups.people ?? [],
    (person) => person.user_id,
    (person) => [person.display_name, person.full_name, person.email]
  )?.user_id;
};

/**
 * The cycle a link names: by id, by number, as `current` (the active one) or
 * `next` (the earliest upcoming one), or by name. Cancelled cycles never
 * match.
 */
const cycleOf = (
  value: string,
  cycles: readonly CycleRead[]
): CycleRead | undefined => {
  const open = cycles.filter(
    (cycle) => !cycle.cancelled && cycle.status !== 'cancelled'
  );
  const byStart = [...open].sort((a, b) =>
    a.start_date.localeCompare(b.start_date)
  );
  if (sameName(value, 'current')) {
    return byStart.find((cycle) => cycle.status === 'active');
  }
  if (sameName(value, 'next')) {
    return byStart.find((cycle) => cycle.status === 'upcoming');
  }
  const id = open.find((cycle) => cycle.cycle_id === value);
  if (id !== undefined) return id;
  if (/^\d+$/.test(value)) {
    const numbered = open.find((cycle) => cycle.number === Number(value));
    if (numbered !== undefined) return numbered;
  }
  return open.find((cycle) => sameName(cycle.name, value));
};

/** Whether a template fills a new issue, rather than a project or document. */
const isIssueTemplate = (template: TemplateRead): boolean =>
  template.kind === undefined || template.kind === 'issue';

/**
 * Resolves raw values into the create dialog's options, leaving out every
 * value that matches nothing. The team is resolved apart, by the caller, since
 * the lookups here are that team's own.
 */
export const resolveNewIssueOptions = (
  params: NewIssueParams,
  lookups: NewIssueLookups
): Omit<CreateIssueOptions, 'teamId'> => {
  const options: Omit<CreateIssueOptions, 'teamId'> = {};
  if (params.title !== undefined) options.title = params.title;
  if (params.description !== undefined) {
    options.description = params.description;
  }
  if (params.priority !== undefined) {
    const priority = priorityOf(params.priority);
    if (priority !== undefined) options.priority = priority;
  }
  if (params.status !== undefined) {
    const status = byIdOrName(
      params.status,
      lookups.statuses ?? [],
      (row) => row.id,
      (row) => [row.name]
    );
    if (status !== undefined) options.statusId = status.id;
  }
  if (params.assignee !== undefined) {
    const assignee = personOf(params.assignee, lookups);
    if (assignee !== undefined) options.assigneeId = assignee;
  }
  if (params.estimate !== undefined) {
    const estimate = (lookups.estimates ?? []).find((choice) =>
      sameName(choice, params.estimate ?? '')
    );
    if (estimate !== undefined) options.estimate = estimate;
  }
  if (params.cycle !== undefined) {
    const cycle = cycleOf(params.cycle, lookups.cycles ?? []);
    if (cycle !== undefined) options.cycleId = cycle.cycle_id;
  }
  const labelIds = params.labels.flatMap((value) => {
    const label = byIdOrName(
      value,
      (lookups.labels ?? []).filter((row) => row.hidden !== true),
      (row) => row.id,
      (row) => [row.name]
    );
    return label === undefined ? [] : [label.id];
  });
  if (labelIds.length > 0) options.labelIds = [...new Set(labelIds)];
  if (params.project !== undefined) {
    const project = byIdOrName(
      params.project,
      lookups.projects ?? [],
      (row) => row.project_id,
      (row) => [row.name]
    );
    if (project !== undefined) {
      options.projectId = project.project_id;
      if (params.projectMilestone !== undefined) {
        const milestone = byIdOrName(
          params.projectMilestone,
          (lookups.milestones ?? []).filter(
            (row) => row.project_id === project.project_id
          ),
          (row) => row.milestone_id,
          (row) => [row.name]
        );
        if (milestone !== undefined) {
          options.projectMilestoneId = milestone.milestone_id;
        }
      }
    }
  }
  if (params.template !== undefined) {
    const template = byIdOrName(
      params.template,
      (lookups.templates ?? []).filter(isIssueTemplate),
      (row) => row.id,
      (row) => [row.name]
    );
    if (template !== undefined) options.templateId = template.id;
  }
  if (params.links.length > 0) options.links = params.links;
  return options;
};

/**
 * A prefilled create link's path and query. Spaces are written as `+`, and
 * fields left unset or blank are left out of the query.
 */
export const newIssuePath = (
  slug: string,
  fields: NewIssueUrlFields,
  keyPrefix?: string
): string => {
  const query = new URLSearchParams();
  const put = (name: string, value: string | undefined): void => {
    if (value !== undefined && value.trim() !== '') query.set(name, value);
  };
  put('title', fields.title);
  put('description', fields.description);
  put('team', fields.team);
  put('status', fields.status);
  put(
    'priority',
    fields.priority === 'none' ? undefined : (fields.priority ?? undefined)
  );
  put('assignee', fields.assignee);
  put('estimate', fields.estimate);
  put('cycle', fields.cycle);
  put('labels', (fields.labels ?? []).join(','));
  put('project', fields.project);
  if (fields.project !== undefined) {
    put('projectMilestone', fields.projectMilestone);
  }
  put('template', fields.template);
  put(
    'links',
    (fields.links ?? [])
      .map((link) =>
        link.title === undefined ? link.url : `${link.url}|${link.title}`
      )
      .join(',')
  );
  const search = query.toString();
  const base = newIssueBasePath(slug, keyPrefix);
  return search === '' ? base : `${base}?${search}`;
};

/**
 * The prefilled link that starts a new issue like this one: its team, status,
 * priority, labels, project and assignee, each by id so a rename does not
 * break it.
 */
export const prefilledFieldsOf = (issue: IssueRead): NewIssueUrlFields => ({
  team: issue.team_id,
  status: issue.status_id,
  priority: issue.priority,
  labels: issue.label_ids,
  ...(issue.project_id === null ? {} : { project: issue.project_id }),
  ...(issue.assignee_id === null ? {} : { assignee: issue.assignee_id }),
});

/** A path and query as a full URL on this origin. */
export const absoluteUrl = (path: string): string =>
  `${globalThis.location.origin}${path}`;
