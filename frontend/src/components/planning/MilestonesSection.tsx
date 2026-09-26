/**
 * A project's milestones on its overview: the stages of the plan in their
 * manual order, each with its progress and target date. Names edit in place,
 * a new milestone is typed straight into the list, a row drags to a new
 * place, and a click on a milestone's issue count opens the project's issues
 * narrowed to it. Alt with an arrow key moves the focused row too, so the
 * order is not a pointer-only control.
 */

import React, { useState } from 'react';
import {
  LuCalendarCheck,
  LuEllipsis,
  LuGripVertical,
  LuListFilter,
  LuMilestone,
  LuPlus,
  LuTrash2,
} from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { reorderKey } from '../../lib/milestones';
import { completionPercent } from '../../lib/planningDisplay';
import type { MilestoneRead, MilestoneUpdate } from '../../types/Api';
import { DatePicker } from '../issues/PropertyPickers';
import { IconButton } from '../ui/button';
import Menu, { MenuItem, MenuSeparator } from '../ui/menu';
import EditableText from './EditableText';
import ProgressRing from './ProgressRing';

/** The longest name a milestone may carry, as the server holds it. */
const NAME_MAX = 200;

/** Props for MilestonesSection. */
export interface MilestonesSectionProps {
  milestones: MilestoneRead[];
  isLoading: boolean;
  canEdit: boolean;
  onCreate: (name: string) => Promise<unknown>;
  onUpdate: (milestoneId: string, patch: MilestoneUpdate) => void;
  onDelete: (milestone: MilestoneRead) => void;
  /** Opens the project's issues narrowed to one milestone. */
  onOpenIssues: (milestoneId: string) => void;
}

/** Props for MilestoneRow. */
interface MilestoneRowProps {
  milestone: MilestoneRead;
  index: number;
  count: number;
  canEdit: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onUpdate: (patch: MilestoneUpdate) => void;
  onDelete: () => void;
  onOpenIssues: () => void;
  onMove: (to: number) => void;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
}

/** One milestone: its handle, progress, name, date and actions. */
const MilestoneRow: React.FC<MilestoneRowProps> = ({
  milestone,
  index,
  count,
  canEdit,
  dragging,
  dropTarget,
  onUpdate,
  onDelete,
  onOpenIssues,
  onMove,
  onDragStart,
  onDragEnter,
  onDragEnd,
  onDrop,
}) => {
  const percent = completionPercent(milestone.counts);
  const live = milestone.counts.total - milestone.counts.cancelled;
  return (
    <li
      aria-label={milestone.name}
      draggable={canEdit}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', milestone.milestone_id);
        onDragStart();
      }}
      onDragEnter={onDragEnter}
      onDragOver={(event) => {
        if (canEdit) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
      onKeyDown={(event) => {
        if (!canEdit || !event.altKey) return;
        if (event.key === 'ArrowUp' && index > 0) {
          event.preventDefault();
          onMove(index - 1);
        }
        if (event.key === 'ArrowDown' && index < count - 1) {
          event.preventDefault();
          onMove(index + 1);
        }
      }}
      className={cn(
        'group/milestone relative grid grid-cols-[1rem_1rem_minmax(0,1fr)_auto_auto_auto] items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-surface',
        dragging && 'opacity-50',
        dropTarget && 'ring-1 ring-accent'
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'text-text-faint opacity-0',
          canEdit && 'cursor-grab group-hover/milestone:opacity-100'
        )}
      >
        <LuGripVertical className="h-3.5 w-3.5" />
      </span>
      <ProgressRing percent={percent} />
      <div className="min-w-0">
        <EditableText
          label={`Milestone name, ${milestone.name}`}
          placeholder="Milestone name"
          value={milestone.name}
          disabled={!canEdit}
          className="text-sm"
          onSave={(name) => {
            if (name !== '') onUpdate({ name: name.slice(0, NAME_MAX) });
          }}
        />
        {(canEdit || (milestone.description ?? '') !== '') && (
          <EditableText
            label={`Milestone description, ${milestone.name}`}
            placeholder="Add a description..."
            value={milestone.description ?? ''}
            disabled={!canEdit}
            className="text-xs text-text-muted"
            onSave={(description) => {
              onUpdate({
                description: description === '' ? null : description,
              });
            }}
          />
        )}
      </div>
      <button
        type="button"
        onClick={onOpenIssues}
        aria-label={`${milestone.name} issues, ${String(percent)}% of ${String(live)} complete`}
        className="rounded-sm px-1 text-xs text-text-muted tabular-nums hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
      >
        {`${String(percent)}% of ${String(live)}`}
      </button>
      <DatePicker
        field="Target date"
        variant="chip"
        align="end"
        value={milestone.target_date}
        disabled={!canEdit}
        icon={<LuCalendarCheck className="h-3.5 w-3.5" />}
        onChange={(value) => {
          onUpdate({ target_date: value });
        }}
      />
      <Menu
        label={`${milestone.name} actions`}
        align="end"
        trigger={(trigger) => (
          <IconButton
            label={`${milestone.name} actions`}
            size="sm"
            className="opacity-0 group-hover/milestone:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
            {...trigger}
          >
            <LuEllipsis className="h-3.5 w-3.5" />
          </IconButton>
        )}
      >
        <MenuItem onSelect={onOpenIssues}>
          <LuListFilter aria-hidden="true" className="h-3.5 w-3.5" />
          View issues
        </MenuItem>
        {canEdit && (
          <>
            <MenuItem
              disabled={index === 0}
              onSelect={() => {
                onMove(index - 1);
              }}
            >
              Move up
            </MenuItem>
            <MenuItem
              disabled={index === count - 1}
              onSelect={() => {
                onMove(index + 1);
              }}
            >
              Move down
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger onSelect={onDelete}>
              <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
              Delete milestone
            </MenuItem>
          </>
        )}
      </Menu>
    </li>
  );
};

/** The field a new milestone is typed into, kept open for the next one. */
const NewMilestone: React.FC<{
  onCreate: (name: string) => Promise<unknown>;
  onDone: () => void;
}> = ({ onCreate, onDone }) => {
  const [name, setName] = useState('');
  const submit = (): void => {
    const trimmed = name.trim();
    if (trimmed === '') {
      onDone();
      return;
    }
    setName('');
    void onCreate(trimmed.slice(0, NAME_MAX));
  };
  return (
    <form
      className="grid grid-cols-[1rem_1rem_minmax(0,1fr)] items-center gap-2 px-1.5 py-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <span />
      <LuMilestone aria-hidden="true" className="h-3.5 w-3.5 text-text-faint" />
      <input
        aria-label="New milestone name"
        placeholder="Milestone name, then Enter"
        autoFocus
        maxLength={NAME_MAX}
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
        onBlur={() => {
          if (name.trim() === '') onDone();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onDone();
          }
        }}
        className="w-full bg-transparent text-sm text-text placeholder:text-text-faint focus:outline-none"
      />
    </form>
  );
};

/** The section. */
export const MilestonesSection: React.FC<MilestonesSectionProps> = ({
  milestones,
  isLoading,
  canEdit,
  onCreate,
  onUpdate,
  onDelete,
  onOpenIssues,
}) => {
  const [adding, setAdding] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const move = (from: number, to: number): void => {
    const moving = milestones[from];
    const key = reorderKey(milestones, from, to);
    if (moving === undefined || key === null) return;
    onUpdate(moving.milestone_id, { sort_order: key });
  };

  return (
    <section aria-labelledby="project-milestones" className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 id="project-milestones" className="text-sm font-medium text-text">
          Milestones
        </h2>
        {canEdit && (
          <IconButton
            label="Add milestone"
            size="sm"
            onClick={() => {
              setAdding(true);
            }}
          >
            <LuPlus className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
      {milestones.length === 0 && !adding && !isLoading && (
        <p className="text-xs text-text-muted">
          {canEdit
            ? 'Break the project into stages, each with its own target date and progress.'
            : 'This project has no milestones.'}
        </p>
      )}
      {milestones.length > 0 && (
        <ol aria-label="Milestones" className="-mx-1.5">
          {milestones.map((milestone, index) => (
            <MilestoneRow
              key={milestone.milestone_id}
              milestone={milestone}
              index={index}
              count={milestones.length}
              canEdit={canEdit}
              dragging={dragFrom === index}
              dropTarget={
                dragFrom !== null && dragOver === index && dragOver !== dragFrom
              }
              onUpdate={(patch) => {
                onUpdate(milestone.milestone_id, patch);
              }}
              onDelete={() => {
                onDelete(milestone);
              }}
              onOpenIssues={() => {
                onOpenIssues(milestone.milestone_id);
              }}
              onMove={(to) => {
                move(index, to);
              }}
              onDragStart={() => {
                setDragFrom(index);
              }}
              onDragEnter={() => {
                setDragOver(index);
              }}
              onDragEnd={() => {
                setDragFrom(null);
                setDragOver(null);
              }}
              onDrop={() => {
                if (dragFrom !== null) move(dragFrom, index);
                setDragFrom(null);
                setDragOver(null);
              }}
            />
          ))}
        </ol>
      )}
      {adding && (
        <div className="-mx-1.5">
          <NewMilestone
            onCreate={onCreate}
            onDone={() => {
              setAdding(false);
            }}
          />
        </div>
      )}
    </section>
  );
};

export default MilestonesSection;
