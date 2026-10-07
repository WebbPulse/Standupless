/**
 * The pure helpers of the standup page: the section order a person's lines read
 * in, moving a digest date by one digest, and grouping lines by project. They
 * mirror the CLI's rendering so both read the same.
 */

import type { DigestCadence, StandupItem, StandupPerson } from '../types/Api';

/** The issue sections of one person, in reading order. */
export const STANDUP_SECTIONS: readonly {
  field: keyof Pick<
    StandupPerson,
    'completed' | 'started' | 'commented' | 'blocked' | 'overdue' | 'due_soon'
  >;
  title: string;
}[] = [
  { field: 'completed', title: 'Completed' },
  { field: 'started', title: 'Started' },
  { field: 'commented', title: 'Commented on' },
  { field: 'blocked', title: 'Blocked' },
  { field: 'overdue', title: 'Overdue' },
  { field: 'due_soon', title: 'Due soon' },
];

/** A digest date as the address carries it. */
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A YYYY-MM-DD date moved by `days`, skipping weekends for a daily digest. */
export const shiftDigestDate = (
  day: string,
  days: number,
  cadence: DigestCadence
): string => {
  const value = new Date(`${day}T00:00:00Z`);
  const step = cadence === 'weekly' ? days * 7 : days;
  value.setUTCDate(value.getUTCDate() + step);
  if (cadence === 'daily') {
    const direction = days < 0 ? -1 : 1;
    while (value.getUTCDay() === 0 || value.getUTCDay() === 6) {
      value.setUTCDate(value.getUTCDate() + direction);
    }
  }
  return value.toISOString().slice(0, 10);
};

/** Whether a person carries anything worth a block. */
export const hasLines = (person: StandupPerson): boolean =>
  (person.note !== null && person.note !== '') ||
  person.project_updates.length > 0 ||
  STANDUP_SECTIONS.some((section) => person[section.field].length > 0);

/** The lines of one section that share a project. */
export interface ProjectGroup {
  projectId: string | null;
  name: string | null;
  lines: StandupItem[];
}

/** Digest lines grouped by project, issues with no project first. */
export const byProject = (lines: StandupItem[]): ProjectGroup[] => {
  const groups = new Map<string, ProjectGroup>();
  for (const line of lines) {
    const id = line.project_id ?? '';
    const group = groups.get(id) ?? {
      projectId: line.project_id,
      name: line.project_name,
      lines: [],
    };
    group.lines.push(line);
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) =>
    a.projectId === null
      ? -1
      : b.projectId === null
        ? 1
        : (a.name ?? '').localeCompare(b.name ?? '')
  );
};
