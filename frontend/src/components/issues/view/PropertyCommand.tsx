/**
 * The keyboard path to a property: s, p, a, l or e on the focused or selected
 * issues opens a searchable list of that property's values, and picking one
 * writes it to every target at once. Values are offered by name across the
 * targets' teams, and each issue gets its own team's value of that name, so
 * "Done" on a selection spanning two teams lands in each team's "Done".
 */

import React, { useMemo } from 'react';
import type { OrderedIssueRead } from '../../../api/issues';
import { NONE } from '../../../api/issues';
import { PRIORITIES, PRIORITY_LABELS } from '../../../lib/issueDisplay';
import { personLabel } from '../../../lib/issuePeople';
import {
  labelGroupKey,
  statusForKey,
  statusGroupKey,
  type IssueChange,
} from '../../../lib/issueView';
import {
  STATUS_CATEGORY_LABELS,
  sortStatuses,
} from '../../../lib/propertyOptions';
import { estimateChoices } from '../../../lib/validation';
import Avatar from '../../ui/avatar';
import { Combobox, type ComboboxOption } from '../../ui/combobox';
import Dialog from '../../ui/dialog';
import { PriorityGlyph, StatusGlyph } from '../../ui/glyphs';
import { useIssueViewEnv } from './IssueViewContext';
import type { CommandProperty } from './propertyKeys';

const TITLES: Record<CommandProperty, string> = {
  status: 'Change status',
  priority: 'Change priority',
  assignee: 'Assign to',
  labels: 'Change labels',
  estimate: 'Set estimate',
};

/** The value meaning "clear it". */
const CLEAR = NONE;

/** Props for PropertyCommand. */
export interface PropertyCommandProps {
  property: CommandProperty | null;
  issues: OrderedIssueRead[];
  onClose: () => void;
}

/** The values every target shares, the ones the list marks as chosen. */
const shared = (values: string[][]): string[] => {
  const [first, ...rest] = values;
  if (first === undefined) return [];
  return first.filter((value) => rest.every((other) => other.includes(value)));
};

/** The dialog. */
export const PropertyCommand: React.FC<PropertyCommandProps> = ({
  property,
  issues,
  onClose,
}) => {
  const env = useIssueViewEnv();
  const { context } = env;
  const ids = useMemo(() => issues.map((issue) => issue.id), [issues]);
  const teamIds = useMemo(
    () => [...new Set(issues.map((issue) => issue.team_id))],
    [issues]
  );
  const scale = env.scaleFor(teamIds[0] ?? '');

  const statuses = useMemo(
    () =>
      sortStatuses(
        context.statuses.filter(
          (status) =>
            status.team_id === undefined || teamIds.includes(status.team_id)
        )
      ),
    [context.statuses, teamIds]
  );
  const labels = useMemo(
    () =>
      context.labels
        .filter(
          (label) =>
            label.team_id === undefined || teamIds.includes(label.team_id)
        )
        .sort((left, right) => left.name.localeCompare(right.name)),
    [context.labels, teamIds]
  );

  if (property === null || issues.length === 0) return null;

  let options: ComboboxOption[] = [];
  let selected: string[] = [];
  let multiple = false;
  let empty = 'Nothing matches.';
  let pick: (value: string) => void = () => undefined;

  const write = (
    change: IssueChange | ((issue: OrderedIssueRead) => IssueChange | null)
  ): void => {
    env.update(ids, change);
  };

  switch (property) {
    case 'status': {
      const seen = new Set<string>();
      options = statuses.flatMap((status) => {
        const key = statusGroupKey(status);
        if (seen.has(key)) return [];
        seen.add(key);
        return [
          {
            value: key,
            label: status.name,
            icon: <StatusGlyph category={status.category} />,
            group: STATUS_CATEGORY_LABELS[status.category],
          },
        ];
      });
      selected = shared(
        issues.map((issue) => {
          const own = context.statuses.find(
            (status) => status.id === issue.status_id
          );
          return own === undefined ? [] : [statusGroupKey(own)];
        })
      );
      pick = (key) => {
        write((issue) => {
          const status = statusForKey(issue, key, context);
          return status === undefined ? null : { status_id: status.id };
        });
        onClose();
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
        onClose();
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
          icon: <Avatar name={personLabel(person)} size="xs" />,
          keywords: [person.email],
        })),
      ];
      selected = shared(issues.map((issue) => [issue.assignee_id ?? CLEAR]));
      pick = (value) => {
        write({ assignee_id: value === CLEAR ? null : value });
        onClose();
      };
      break;
    }
    case 'labels': {
      multiple = true;
      empty = 'No labels in this team yet.';
      const seen = new Set<string>();
      options = labels.flatMap((label) => {
        const key = labelGroupKey(label);
        if (seen.has(key)) return [];
        seen.add(key);
        return [
          {
            value: key,
            label: label.name,
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
          return removing ? { remove_label_ids: own } : { add_label_ids: own };
        });
      };
      break;
    }
    case 'estimate': {
      const choices = scale === 'off' ? [] : estimateChoices(scale);
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
          return own !== 'off' && estimateChoices(own).includes(value)
            ? { estimate: value }
            : null;
        });
        onClose();
      };
      break;
    }
  }

  const subject =
    issues.length === 1
      ? (issues[0]?.key ?? '')
      : `${String(issues.length)} issues`;

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${TITLES[property]}, ${subject}`}
      hideTitle
      size="sm"
    >
      <div className="-mx-4 -mt-8 -mb-4">
        <p className="border-b border-line px-3 pt-2.5 pb-2 text-xs text-text-muted">
          <span className="rounded-sm bg-raised px-1.5 py-0.5 font-mono text-2xs text-text">
            {subject}
          </span>
        </p>
        <Combobox
          label={TITLES[property]}
          placeholder={`${TITLES[property]}...`}
          options={options}
          selected={selected}
          multiple={multiple}
          emptyMessage={empty}
          onSelect={pick}
        />
      </div>
    </Dialog>
  );
};

export default PropertyCommand;
