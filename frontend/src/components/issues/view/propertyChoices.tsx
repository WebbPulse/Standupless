/**
 * What each property's picker lists for the focused or selected issues, and
 * the write picking a value makes on every target at once. Values are offered
 * by name across the targets' teams, and each issue gets its own team's value
 * of that name, so "Done" on a selection spanning two teams lands in each
 * team's "Done". The picker dialog and the command palette both read it, so a
 * value written from either goes through the same update and undo.
 */

import React from 'react';
import { LuBox, LuCalendar, LuIterationCw, LuX } from 'react-icons/lu';
import type { OrderedIssueRead } from '../../../api/issues';
import { NONE } from '../../../api/issues';
import { PRIORITIES, PRIORITY_LABELS } from '../../../lib/issueDisplay';
import { personAvatar, personLabel } from '../../../lib/issuePeople';
import { isAway, statusSummary } from '../../../lib/userStatus';
import { CYCLE_STATUS_LABELS } from '../../../lib/planningDisplay';
import {
  DEFAULT_PROJECT_STATUSES,
  projectStatusOf,
} from '../../../lib/projectStatuses';
import {
  labelGroupKey,
  milestoneOf,
  statusForKey,
  statusGroupKey,
  type IssueChange,
} from '../../../lib/issueView';
import {
  STATUS_CATEGORY_LABELS,
  dateInRange,
  datePresets,
  shortDateLabel,
  sortStatuses,
  statusDetail,
  typedDateOption,
} from '../../../lib/propertyOptions';
import { pickableLabels, replacedSiblings } from '../../../lib/labelGroups';
import {
  TRIAGE_GROUP_KEY,
  TRIAGE_STATUS,
  TRIAGE_STATUS_ID,
  TRIAGE_STATUS_NAME,
} from '../../../lib/triageStatus';
import { estimateChoices, type EstimateOptions } from '../../../lib/validation';
import Avatar from '../../ui/avatar';
import type { ComboboxOption } from '../../ui/combobox';
import type { ProjectStatusRead } from '../../../types/Api';
import { PriorityGlyph } from '../../ui/glyphs';
import { StatusIcon } from '../../ui/StatusIcon';
import MilestoneGlyph from '../../planning/MilestoneGlyph';
import { CustomDate } from '../PropertyPickers';
import type { IssueViewEnv } from './IssueViewContext';
import type { CommandProperty } from './propertyKeys';
import { STATUS_POSITION_COUNT } from '../../../lib/statusPosition';

/** A dashed ring standing for "none" in a list of values. */
const NoneMark: React.FC = () => (
  <span
    aria-hidden="true"
    className="h-3.5 w-3.5 rounded-full border border-dashed border-text-faint"
  />
);

/** The value meaning "clear it". */
const CLEAR = NONE;

/** What one property's picker lists and what picking a value does. */
export interface PropertyChoices {
  options: ComboboxOption[];
  /** The values every target already has, drawn with a check. */
  selected: string[];
  multiple: boolean;
  empty: string;
  /** Writes the value to every target through the view's update. */
  pick: (value: string) => void;
  footer?: React.ReactNode;
  leadOption?: (query: string) => ComboboxOption | null;
}

/** What {@link propertyChoices} builds from. */
export interface PropertyChoicesInput {
  property: CommandProperty;
  issues: readonly OrderedIssueRead[];
  env: IssueViewEnv;
  /** The teams with triage on, whose status lists offer Triage. */
  triageTeams: ReadonlySet<string>;
  today: Date;
  /** Called once a single-valued pick has written. */
  onDone: () => void;
  /** The workspace's project statuses, the seeded defaults when left out. */
  projectStatuses?: readonly ProjectStatusRead[];
}

/** The values every target shares, the ones the list marks as chosen. */
const shared = (values: string[][]): string[] => {
  const [first, ...rest] = values;
  if (first === undefined) return [];
  return first.filter((value) => rest.every((other) => other.includes(value)));
};

/**
 * One property's values for a set of targets and the write each one makes,
 * shared by the picker dialog and the command palette so both write alike.
 */
export const propertyChoices = ({
  property,
  issues,
  env,
  triageTeams,
  today,
  onDone,
  projectStatuses = DEFAULT_PROJECT_STATUSES,
}: PropertyChoicesInput): PropertyChoices => {
  const { context } = env;
  const ids = issues.map((issue) => issue.id);
  const teamIds = [...new Set(issues.map((issue) => issue.team_id))];
  const scale = env.scaleFor(teamIds[0] ?? '');
  const optionsFor = (teamId: string): EstimateOptions =>
    env.estimateOptionsFor?.(teamId) ?? {};
  const statuses = sortStatuses(
    context.statuses.filter(
      (status) =>
        status.team_id === undefined || teamIds.includes(status.team_id)
    )
  );
  const labels = context.labels
    .filter(
      (label) => label.team_id === undefined || teamIds.includes(label.team_id)
    )
    .sort((left, right) => left.name.localeCompare(right.name));

  let options: ComboboxOption[] = [];
  let selected: string[] = [];
  let multiple = false;
  let empty = 'Nothing matches.';
  let pick: (value: string) => void = () => undefined;
  let footer: React.ReactNode = undefined;
  let leadOption: ((query: string) => ComboboxOption | null) | undefined;

  const write = (
    change: IssueChange | ((issue: OrderedIssueRead) => IssueChange | null)
  ): void => {
    env.update(ids, change);
  };

  switch (property) {
    case 'status': {
      const seen = new Set<string>();
      const triageOption: ComboboxOption[] = teamIds.some((teamId) =>
        triageTeams.has(teamId)
      )
        ? [
            {
              value: TRIAGE_GROUP_KEY,
              label: TRIAGE_STATUS_NAME,
              icon: <StatusIcon status={TRIAGE_STATUS} />,
              group: TRIAGE_STATUS_NAME,
            },
          ]
        : [];
      const real = statuses.flatMap((status) => {
        const key = statusGroupKey(status);
        if (seen.has(key)) return [];
        seen.add(key);
        const position = seen.size;
        return [
          {
            value: key,
            label: status.name,
            icon: <StatusIcon status={status} statuses={statuses} />,
            group: STATUS_CATEGORY_LABELS[status.category],
            ...statusDetail(status),
            ...(teamIds.length === 1 && position <= STATUS_POSITION_COUNT
              ? { shortcut: String(position) }
              : {}),
          },
        ];
      });
      options = [...triageOption, ...real];
      selected = shared(
        issues.map((issue) => {
          if (issue.in_triage === true) return [TRIAGE_GROUP_KEY];
          const own = context.statuses.find(
            (status) => status.id === issue.status_id
          );
          return own === undefined ? [] : [statusGroupKey(own)];
        })
      );
      pick = (key) => {
        write((issue) => {
          if (key === TRIAGE_GROUP_KEY) {
            return triageTeams.has(issue.team_id)
              ? { status_id: TRIAGE_STATUS_ID }
              : null;
          }
          const status = statusForKey(issue, key, context);
          return status === undefined ? null : { status_id: status.id };
        });
        onDone();
      };
      break;
    }
    case 'priority':
      options = PRIORITIES.map((priority, index) => ({
        value: priority,
        label: PRIORITY_LABELS[priority],
        icon: <PriorityGlyph priority={priority} />,
        shortcut: String(index),
      }));
      selected = shared(issues.map((issue) => [issue.priority]));
      pick = (value) => {
        const priority = PRIORITIES.find((item) => item === value);
        if (priority !== undefined) write({ priority });
        onDone();
      };
      break;
    case 'assignee': {
      const me = context.people.find(
        (person) => person.user_id === context.currentUserId
      );
      const people = [
        ...(me === undefined ? [] : [me]),
        ...context.people
          .filter((person) => person !== me)
          .sort((left, right) =>
            personLabel(left).localeCompare(personLabel(right))
          ),
      ];
      options = [
        {
          value: CLEAR,
          label: 'No assignee',
          icon: (
            <span
              aria-hidden="true"
              className="h-4 w-4 rounded-full border border-dashed border-text-faint"
            />
          ),
        },
        ...people.map((person) => ({
          value: person.user_id,
          label:
            person === me
              ? `${personLabel(person)} (you)`
              : personLabel(person),
          icon: (
            <Avatar
              name={personLabel(person)}
              src={personAvatar(person)}
              size="xs"
              away={isAway(person.user_status)}
            />
          ),
          keywords: [person.email],
          ...(statusSummary(person.user_status) === ''
            ? {}
            : { detail: statusSummary(person.user_status) }),
        })),
      ];
      selected = shared(issues.map((issue) => [issue.assignee_id ?? CLEAR]));
      pick = (value) => {
        write({ assignee_id: value === CLEAR ? null : value });
        onDone();
      };
      break;
    }
    case 'labels': {
      multiple = true;
      empty = 'No labels in this team yet.';
      const seen = new Set<string>();
      const grouped = pickableLabels(labels).sort(
        (left, right) =>
          (left.group_name === undefined ? 0 : 1) -
            (right.group_name === undefined ? 0 : 1) ||
          (left.group_name ?? '').localeCompare(right.group_name ?? '')
      );
      options = grouped.flatMap((label) => {
        const key = labelGroupKey(label);
        if (seen.has(key)) return [];
        seen.add(key);
        return [
          {
            value: key,
            label: label.name,
            ...(label.group_name === undefined
              ? {}
              : { group: label.group_name }),
            icon: (
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: label.color }}
              />
            ),
          },
        ];
      });
      const keysOf = (issue: OrderedIssueRead): string[] =>
        labels
          .filter((label) => issue.label_ids.includes(label.id))
          .map(labelGroupKey);
      selected = shared(issues.map(keysOf));
      pick = (key) => {
        const removing = selected.includes(key);
        write((issue) => {
          const own = labels
            .filter(
              (label) =>
                labelGroupKey(label) === key &&
                (label.team_id === undefined || label.team_id === issue.team_id)
            )
            .map((label) => label.id);
          if (own.length === 0) return null;
          if (removing) return { remove_label_ids: own };
          const replaced = replacedSiblings(labels, issue.label_ids, own);
          return replaced.length === 0
            ? { add_label_ids: own }
            : { add_label_ids: own, remove_label_ids: replaced };
        });
      };
      break;
    }
    case 'estimate': {
      const choices =
        scale === 'off'
          ? []
          : estimateChoices(scale, optionsFor(teamIds[0] ?? ''));
      empty = 'Estimates are off for this team.';
      options =
        choices.length === 0
          ? []
          : [
              { value: CLEAR, label: 'No estimate' },
              ...choices.map((choice) => ({ value: choice, label: choice })),
            ];
      selected = shared(issues.map((issue) => [issue.estimate ?? CLEAR]));
      pick = (value) => {
        write((issue) => {
          if (value === CLEAR) return { estimate: null };
          const own = env.scaleFor(issue.team_id);
          return own !== 'off' &&
            estimateChoices(own, optionsFor(issue.team_id)).includes(value)
            ? { estimate: value }
            : null;
        });
        onDone();
      };
      break;
    }
    case 'milestone': {
      const milestones = context.milestones ?? [];
      empty = 'No milestones in this project yet.';
      options = [
        {
          value: CLEAR,
          label: 'No milestone',
          icon: (
            <span
              aria-hidden="true"
              className="h-3.5 w-3.5 rounded-full border border-dashed border-text-faint"
            />
          ),
        },
        ...milestones.map((milestone) => ({
          value: milestone.milestone_id,
          label: milestone.name,
          icon: <MilestoneGlyph milestone={milestone} decorative />,
        })),
      ];
      selected = shared(
        issues.map((issue) => [
          milestoneOf(issue, context)?.milestone_id ?? CLEAR,
        ])
      );
      pick = (value) => {
        write((issue) => {
          if (value === CLEAR) return { project_milestone_id: null };
          const milestone = milestones.find(
            (entry) => entry.milestone_id === value
          );
          return milestone === undefined ||
            milestone.project_id !== issue.project_id
            ? null
            : { project_milestone_id: value };
        });
        onDone();
      };
      break;
    }
    case 'cycle': {
      const cycles = context.cycles
        .filter(
          (cycle) =>
            teamIds.includes(cycle.team_id) &&
            (issues.some((issue) => issue.cycle_id === cycle.cycle_id) ||
              (cycle.status !== 'completed' && cycle.status !== 'cancelled'))
        )
        .sort((left, right) => left.start_date.localeCompare(right.start_date));
      empty = 'No cycles in this team yet.';
      options = [
        { value: CLEAR, label: 'No cycle', icon: <NoneMark /> },
        ...cycles.map((cycle) => ({
          value: cycle.cycle_id,
          label: cycle.name,
          icon: <LuIterationCw className="h-3.5 w-3.5 text-text-muted" />,
          detail: CYCLE_STATUS_LABELS[cycle.status],
        })),
      ];
      selected = shared(issues.map((issue) => [issue.cycle_id ?? CLEAR]));
      pick = (value) => {
        write((issue) => {
          if (value === CLEAR) return { cycle_id: null };
          const cycle = cycles.find((entry) => entry.cycle_id === value);
          return cycle === undefined || cycle.team_id !== issue.team_id
            ? null
            : { cycle_id: value };
        });
        onDone();
      };
      break;
    }
    case 'project': {
      const linked = (
        project: (typeof context.projects)[number],
        teamId: string
      ): boolean =>
        project.team_id === teamId || project.team_ids.includes(teamId);
      const projects = context.projects
        .filter((project) => teamIds.some((team) => linked(project, team)))
        .sort((left, right) => left.name.localeCompare(right.name));
      empty = 'No projects in this team yet.';
      options = [
        { value: CLEAR, label: 'No project', icon: <NoneMark /> },
        ...projects.map((project) => ({
          value: project.project_id,
          label: project.name,
          icon: <LuBox className="h-3.5 w-3.5 text-text-muted" />,
          detail: projectStatusOf(project, projectStatuses).name,
        })),
      ];
      selected = shared(issues.map((issue) => [issue.project_id ?? CLEAR]));
      pick = (value) => {
        write((issue) => {
          if (value === CLEAR) return { project_id: null };
          const project = projects.find((entry) => entry.project_id === value);
          return project === undefined || !linked(project, issue.team_id)
            ? null
            : { project_id: value };
        });
        onDone();
      };
      break;
    }
    case 'dueDate': {
      const starts = issues
        .map((issue) => issue.start_date)
        .filter((start): start is string => start !== null)
        .sort();
      const min = starts[starts.length - 1];
      const setDue = (value: string | null): void => {
        write((issue) =>
          value !== null &&
          issue.start_date !== null &&
          issue.start_date > value
            ? null
            : { due_date: value }
        );
        onDone();
      };
      options = [
        ...datePresets(today).map((preset) => ({
          value: preset.value,
          label: preset.label,
          icon: <LuCalendar className="h-3.5 w-3.5 text-text-muted" />,
          detail: shortDateLabel(preset.value, today),
          disabled: !dateInRange(preset.value, min, undefined),
        })),
        {
          value: CLEAR,
          label: 'No due date',
          icon: <LuX className="h-3.5 w-3.5 text-text-muted" />,
        },
      ];
      selected = shared(issues.map((issue) => [issue.due_date ?? CLEAR]));
      leadOption = (query) => {
        const typed = typedDateOption(query, today, min);
        return typed === null
          ? null
          : {
              ...typed,
              icon: <LuCalendar className="h-3.5 w-3.5 text-text-muted" />,
            };
      };
      pick = (value) => {
        setDue(value === CLEAR ? null : value);
      };
      footer = (
        <CustomDate
          value={issues.length === 1 ? (issues[0]?.due_date ?? null) : null}
          {...(min === undefined ? {} : { min })}
          onPick={setDue}
        />
      );
      break;
    }
  }

  return {
    options,
    selected,
    multiple,
    empty,
    pick,
    ...(footer === undefined ? {} : { footer }),
    ...(leadOption === undefined ? {} : { leadOption }),
  };
};
