/**
 * How a project activity row reads: an icon and a sentence after the actor's
 * name. Kept apart from the feed component so the wording is tested on its own
 * and the component file exports only components.
 */

import { PRIORITY_LABELS } from './issueDisplay';
import { personLabel, type Assignable } from './issuePeople';
import { PROJECT_STATUS_LABELS } from './planningDisplay';
import { PROJECT_HEALTH_LABELS } from './projectLook';
import { shortDateLabel } from './propertyOptions';
import type {
  IssuePriority,
  ProjectActivityRead,
  ProjectHealth,
  ProjectStatus,
} from '../types/Api';

/** The glyph a row draws beside its sentence. */
export type ProjectActivityIcon =
  | 'created'
  | 'name'
  | 'status'
  | 'health'
  | 'priority'
  | 'lead'
  | 'members'
  | 'date'
  | 'teams'
  | 'initiative'
  | 'labels'
  | 'milestone';

/** One piece of a sentence: plain words, a named thing, or a status or health with its glyph. */
export type ProjectActivityPart =
  | { kind: 'text'; text: string }
  | { kind: 'name'; text: string }
  | { kind: 'status'; status: ProjectStatus; text: string }
  | { kind: 'health'; health: ProjectHealth; text: string };

/** How one row reads. */
export interface ProjectActivityDescription {
  icon: ProjectActivityIcon;
  parts: ProjectActivityPart[];
}

/** The names a row's ids resolve against. */
export interface ProjectActivityLookups {
  people: Assignable[];
  teams: { id: string; name: string }[];
  initiatives: { initiative_id: string; name: string }[];
  milestones: { milestone_id: string; name: string }[];
  /** The workspace's project labels, for label changes; a missing one reads "a label". */
  projectLabels?: { id: string; name: string }[];
}

const text = (value: string): ProjectActivityPart => ({
  kind: 'text',
  text: value,
});

const name = (value: string): ProjectActivityPart => ({
  kind: 'name',
  text: value,
});

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

const asList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

const isStatus = (value: string | null): value is ProjectStatus =>
  value !== null && value in PROJECT_STATUS_LABELS;

const isHealth = (value: string | null): value is ProjectHealth =>
  value !== null && value in PROJECT_HEALTH_LABELS;

const isPriority = (value: string | null): value is IssuePriority =>
  value !== null && value in PRIORITY_LABELS;

const personName = (userId: string, lookups: ProjectActivityLookups): string =>
  personLabel(lookups.people.find((person) => person.user_id === userId));

const teamName = (teamId: string, lookups: ProjectActivityLookups): string =>
  lookups.teams.find((team) => team.id === teamId)?.name ?? 'a team';

const labelName = (labelId: string, lookups: ProjectActivityLookups): string =>
  lookups.projectLabels?.find((label) => label.id === labelId)?.name ??
  'a label';

/** Joins named things as "A", "A and B" or "A, B and C". */
const joinNames = (names: string[]): ProjectActivityPart[] =>
  names.flatMap((item, index) => {
    const parts = [name(item)];
    if (index === 0) return parts;
    return [text(index === names.length - 1 ? ' and ' : ', '), ...parts];
  });

/** A list change as "added A and removed B". */
const listChange = (
  before: string[],
  after: string[],
  label: (id: string) => string,
  noun: string
): ProjectActivityPart[] => {
  const added = after.filter((id) => !before.includes(id)).map(label);
  const removed = before.filter((id) => !after.includes(id)).map(label);
  const parts: ProjectActivityPart[] = [];
  if (added.length > 0) {
    parts.push(text('added '), ...joinNames(added), text(` ${noun}`));
  }
  if (removed.length > 0) {
    if (parts.length > 0) parts.push(text(' and '));
    parts.push(text('removed '), ...joinNames(removed), text(` ${noun}`));
  }
  if (parts.length === 0) parts.push(text(`changed the ${noun}`));
  return parts;
};

const statusPart = (status: ProjectStatus): ProjectActivityPart => ({
  kind: 'status',
  status,
  text: PROJECT_STATUS_LABELS[status],
});

const describeStatus = (
  from: string | null,
  to: string | null
): ProjectActivityPart[] => {
  if (!isStatus(to)) return [text('changed the status')];
  if (!isStatus(from)) return [text('set the status to '), statusPart(to)];
  return [
    text('changed the status from '),
    statusPart(from),
    text(' to '),
    statusPart(to),
  ];
};

const describeDate = (
  label: string,
  to: string | null
): ProjectActivityPart[] =>
  to === null
    ? [text(`removed the ${label}`)]
    : [text(`set the ${label} to `), name(shortDateLabel(to))];

const describeField = (
  row: ProjectActivityRead,
  lookups: ProjectActivityLookups
): ProjectActivityDescription => {
  const from = asString(row.from);
  const to = asString(row.to);
  switch (row.field) {
    case 'name':
      return {
        icon: 'name',
        parts: [text('renamed the project to '), name(to ?? 'Untitled')],
      };
    case 'status':
      return { icon: 'status', parts: describeStatus(from, to) };
    case 'health':
      return {
        icon: 'health',
        parts: isHealth(to)
          ? [
              text('set the health to '),
              { kind: 'health', health: to, text: PROJECT_HEALTH_LABELS[to] },
            ]
          : [text('cleared the health')],
      };
    case 'priority':
      return {
        icon: 'priority',
        parts:
          isPriority(to) && to !== 'none'
            ? [text('set the priority to '), name(PRIORITY_LABELS[to])]
            : [text('removed the priority')],
      };
    case 'lead_id':
      if (to !== null) {
        return {
          icon: 'lead',
          parts: [text('set the lead to '), name(personName(to, lookups))],
        };
      }
      return {
        icon: 'lead',
        parts:
          from === null
            ? [text('removed the lead')]
            : [
                text('removed '),
                name(personName(from, lookups)),
                text(' as lead'),
              ],
      };
    case 'member_ids':
      return {
        icon: 'members',
        parts: listChange(
          asList(row.from),
          asList(row.to),
          (id) => personName(id, lookups),
          'as members'
        ),
      };
    case 'label_ids':
      return {
        icon: 'labels',
        parts: listChange(
          asList(row.from),
          asList(row.to),
          (id) => labelName(id, lookups),
          'as labels'
        ),
      };
    case 'start_date':
      return { icon: 'date', parts: describeDate('start date', to) };
    case 'target_date':
      return { icon: 'date', parts: describeDate('target date', to) };
    case 'team_ids':
      return {
        icon: 'teams',
        parts: listChange(
          asList(row.from),
          asList(row.to),
          (id) => teamName(id, lookups),
          'as teams'
        ),
      };
    case 'initiative_id': {
      if (to === null) {
        return { icon: 'initiative', parts: [text('removed the initiative')] };
      }
      const initiative = lookups.initiatives.find(
        (row) => row.initiative_id === to
      );
      return {
        icon: 'initiative',
        parts: [
          text('moved the project to '),
          name(initiative?.name ?? 'an initiative'),
        ],
      };
    }
    default:
      return { icon: 'name', parts: [text('changed the project')] };
  }
};

const describeMilestone = (
  row: ProjectActivityRead,
  lookups: ProjectActivityLookups
): ProjectActivityDescription => {
  const from = asString(row.from);
  const to = asString(row.to);
  if (row.kind === 'milestone_added') {
    return {
      icon: 'milestone',
      parts: [text('added milestone '), name(to ?? 'Untitled')],
    };
  }
  if (row.kind === 'milestone_removed') {
    return {
      icon: 'milestone',
      parts: [text('removed milestone '), name(from ?? 'Untitled')],
    };
  }
  if (row.field === 'name') {
    return {
      icon: 'milestone',
      parts: [
        text('renamed milestone '),
        name(from ?? 'Untitled'),
        text(' to '),
        name(to ?? 'Untitled'),
      ],
    };
  }
  const milestone = lookups.milestones.find(
    (held) => held.milestone_id === row.milestone_id
  );
  const milestoneName = name(milestone?.name ?? 'a milestone');
  return {
    icon: 'milestone',
    parts:
      to === null
        ? [text('removed the target date of milestone '), milestoneName]
        : [
            text('set the target date of milestone '),
            milestoneName,
            text(' to '),
            name(shortDateLabel(to)),
          ],
  };
};

/** How one activity row reads after its actor's name. */
export const describeProjectActivity = (
  row: ProjectActivityRead,
  lookups: ProjectActivityLookups
): ProjectActivityDescription => {
  if (row.kind === 'created') {
    return { icon: 'created', parts: [text('created the project')] };
  }
  if (row.kind === 'field_changed') return describeField(row, lookups);
  return describeMilestone(row, lookups);
};
