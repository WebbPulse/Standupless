/**
 * The bulk edits the projects page offers for a selection: a searchable list
 * of one property's values that writes the picked one to every selected
 * project, and the question asked before several projects are deleted. A
 * label toggles, added to every project unless all of them carry it already,
 * and a target date skips a project that would end before it starts.
 */

import React, { useState } from 'react';
import { LuCalendar, LuGoal, LuX } from 'react-icons/lu';
import { CustomDate } from '../issues/PropertyPickers';
import Avatar from '../ui/avatar';
import Button from '../ui/button';
import { Combobox, type ComboboxOption } from '../ui/combobox';
import Dialog from '../ui/dialog';
import { PriorityGlyph } from '../ui/glyphs';
import ProjectStatusGlyph from './ProjectStatusGlyph';
import { PRIORITIES, PRIORITY_LABELS } from '../../lib/issueDisplay';
import {
  personAvatar,
  personLabel,
  type Assignable,
} from '../../lib/issuePeople';
import { useProjectStatuses } from '../../hooks/useProjectStatuses';
import type { ProjectMove } from '../../lib/projectList';
import {
  listOrderedProjectStatuses,
  statusPatch,
} from '../../lib/projectStatuses';
import {
  dateInRange,
  datePresets,
  shortDateLabel,
  typedDateOption,
} from '../../lib/propertyOptions';
import type {
  InitiativeRead,
  IssuePriority,
  ProjectLabelRead,
  ProjectRead,
} from '../../types/Api';

/** A property the projects bulk bar sets on every selected project. */
export type ProjectBulkProperty =
  'status' | 'lead' | 'priority' | 'target' | 'labels' | 'initiative';

/** The value that clears a property. */
const CLEAR = '__clear__';

const TITLES: Record<ProjectBulkProperty, string> = {
  status: 'Change status',
  lead: 'Change lead',
  priority: 'Change priority',
  target: 'Set target date',
  labels: 'Change labels',
  initiative: 'Add to initiative',
};

/** One change for each project it applies to; a project left out is skipped. */
export type ProjectBulkWrite = (
  changes: readonly { project: ProjectRead; change: ProjectMove }[]
) => void;

/** Props for ProjectBulkCommand. */
export interface ProjectBulkCommandProps {
  property: ProjectBulkProperty;
  projects: readonly ProjectRead[];
  people: readonly Assignable[];
  projectLabels: readonly ProjectLabelRead[];
  initiatives: readonly InitiativeRead[];
  onWrite: ProjectBulkWrite;
  onClose: () => void;
}

/** The values every project shares, the ones the list marks as chosen. */
const shared = (values: string[][]): string[] => {
  const [first, ...rest] = values;
  if (first === undefined) return [];
  return first.filter((value) => rest.every((other) => other.includes(value)));
};

/** The picker dialog for one property across the selection. */
export const ProjectBulkCommand: React.FC<ProjectBulkCommandProps> = ({
  property,
  projects,
  people,
  projectLabels,
  initiatives,
  onWrite,
  onClose,
}) => {
  const [today] = useState(() => new Date());
  const { statuses, statusOf } = useProjectStatuses();
  const every = (change: ProjectMove): void => {
    onWrite(projects.map((project) => ({ project, change })));
    onClose();
  };

  let options: ComboboxOption[] = [];
  let selected: string[] = [];
  let multiple = false;
  let pick: (value: string) => void = () => undefined;
  let footer: React.ReactNode = undefined;
  let leadOption: ((query: string) => ComboboxOption | null) | undefined;

  switch (property) {
    case 'status': {
      const ordered = listOrderedProjectStatuses(statuses);
      options = ordered.map((status) => ({
        value: status.id,
        label: status.name,
        icon: (
          <ProjectStatusGlyph status={status.category} color={status.color} />
        ),
      }));
      selected = shared(projects.map((project) => [statusOf(project).id]));
      pick = (value) => {
        const status = ordered.find((row) => row.id === value);
        if (status !== undefined) every(statusPatch(status));
      };
      break;
    }
    case 'lead': {
      options = [
        { value: CLEAR, label: 'No lead' },
        ...people.map((person) => ({
          value: person.user_id,
          label: personLabel(person),
          icon: (
            <Avatar
              name={personLabel(person)}
              src={personAvatar(person)}
              size="xs"
            />
          ),
          keywords: [person.email],
        })),
      ];
      selected = shared(projects.map((project) => [project.lead_id ?? CLEAR]));
      pick = (value) => {
        every({ lead_id: value === CLEAR ? null : value });
      };
      break;
    }
    case 'priority': {
      options = PRIORITIES.map((priority) => ({
        value: priority,
        label: PRIORITY_LABELS[priority],
        icon: <PriorityGlyph priority={priority} />,
      }));
      selected = shared(projects.map((project) => [project.priority]));
      pick = (value) => {
        every({ priority: value as IssuePriority });
      };
      break;
    }
    case 'labels': {
      multiple = true;
      options = projectLabels.map((label) => ({
        value: label.id,
        label: label.name,
        icon: (
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: label.color }}
          />
        ),
      }));
      selected = shared(projects.map((project) => project.label_ids ?? []));
      pick = (labelId) => {
        const removing = selected.includes(labelId);
        onWrite(
          projects.flatMap((project) => {
            const own = project.label_ids ?? [];
            if (removing)
              return [
                {
                  project,
                  change: { label_ids: own.filter((id) => id !== labelId) },
                },
              ];
            return own.includes(labelId)
              ? []
              : [{ project, change: { label_ids: [...own, labelId] } }];
          })
        );
      };
      break;
    }
    case 'initiative': {
      options = [
        { value: CLEAR, label: 'No initiative', icon: <LuX /> },
        ...initiatives.map((initiative) => ({
          value: initiative.initiative_id,
          label: initiative.name,
          icon: <LuGoal className="h-3.5 w-3.5 text-text-muted" />,
        })),
      ];
      selected = shared(
        projects.map((project) => [project.initiative_id ?? CLEAR])
      );
      pick = (value) => {
        every({ initiative_id: value === CLEAR ? null : value });
      };
      break;
    }
    case 'target': {
      const starts = projects
        .map((project) => project.start_date)
        .filter((start): start is string => start !== null)
        .sort();
      const min = starts[starts.length - 1];
      const setTarget = (value: string | null): void => {
        onWrite(
          projects.flatMap((project) =>
            value !== null &&
            project.start_date !== null &&
            project.start_date > value
              ? []
              : [{ project, change: { target_date: value } }]
          )
        );
        onClose();
      };
      options = [
        ...datePresets(today).map((preset) => ({
          value: preset.value,
          label: preset.label,
          icon: <LuCalendar className="h-3.5 w-3.5 text-text-muted" />,
          detail: shortDateLabel(preset.value, today),
          disabled: !dateInRange(preset.value, min, undefined),
        })),
        { value: CLEAR, label: 'No target date', icon: <LuX /> },
      ];
      selected = shared(
        projects.map((project) => [project.target_date ?? CLEAR])
      );
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
        setTarget(value === CLEAR ? null : value);
      };
      footer = (
        <CustomDate
          value={null}
          {...(min === undefined ? {} : { min })}
          onPick={setTarget}
        />
      );
      break;
    }
  }

  const subject =
    projects.length === 1
      ? (projects[0]?.name ?? '')
      : `${String(projects.length)} projects`;

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
          emptyMessage={
            property === 'labels'
              ? 'No project labels yet.'
              : property === 'initiative'
                ? 'No initiatives yet.'
                : 'Nothing matches.'
          }
          onSelect={pick}
          {...(footer === undefined ? {} : { footer })}
          {...(leadOption === undefined ? {} : { leadOption })}
        />
      </div>
    </Dialog>
  );
};

/** Props for ConfirmDeleteProjectsDialog. */
export interface ConfirmDeleteProjectsDialogProps {
  projects: readonly ProjectRead[];
  onClose: () => void;
  /** Deletes the projects. The dialog closes once it resolves. */
  onConfirm: () => Promise<void>;
}

/** Asks whether to delete the selected projects, Delete in focus. */
export const ConfirmDeleteProjectsDialog: React.FC<
  ConfirmDeleteProjectsDialogProps
> = ({ projects, onClose, onConfirm }) => {
  const [busy, setBusy] = useState(false);
  const [first] = projects;
  const single = projects.length === 1 && first !== undefined;
  return (
    <Dialog
      open
      onClose={onClose}
      title={
        single
          ? 'Delete project?'
          : `Delete ${String(projects.length)} projects?`
      }
      size="sm"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          void onConfirm().finally(onClose);
        }}
        className="space-y-4"
      >
        <p className="text-sm break-words text-text-muted">
          {single
            ? `${first.name} will be deleted. Its issues stay where they are and stop being attached to a project.`
            : `${projects.map((project) => project.name).join(', ')} will be deleted. Their issues stay where they are and stop being attached to a project.`}
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            variant="danger"
            disabled={busy}
            autoFocus
          >
            {busy ? 'Deleting' : 'Delete'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

export default ProjectBulkCommand;
