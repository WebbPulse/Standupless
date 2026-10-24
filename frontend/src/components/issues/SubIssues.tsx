/**
 * The direct children of one issue as a compact list section. The count in
 * the header reads `progress` on the parent, which the rollup consumer
 * maintains, until every child is loaded; from then it counts the rows, so a
 * status picked or a child added here shows at once rather than when the
 * rollup lands. A row opens its issue on click, Space on a focused row peeks
 * it, and its status, priority and assignee chips open the shared pickers,
 * writing through the optimistic layer so each change can be undone.
 *
 * Rows drag into a manual order, or move a step with Alt+Up and Alt+Down; j
 * and k move focus between rows, and s, p and a open the focused row's
 * pickers rather than the parent's. The Display button sets the ordering and
 * whether completed sub-issues show, remembered for the viewer; hidden ones
 * fold into an "N completed" row that expands them. The add button opens an
 * inline row that files a child per Enter and stays open for the next one.
 */

import React, { useMemo, useRef, useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { LuSlidersHorizontal } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { createIssue, type OrderedIssueRead } from '../../api/issues';
import { isTypingTarget } from '../../hooks/useCommandPalette';
import { useOptimisticIssues } from '../../hooks/useOptimisticIssues';
import { usePeekIssue } from '../../hooks/usePeekIssue';
import { useTriageOn } from '../../hooks/useTriageTeams';
import { cn } from '../../lib/cn';
import { slotIndex } from '../../lib/dropSlot';
import { errorMessage } from '../../lib/errors';
import { manualMoveKeys } from '../../lib/issueView';
import type { Assignable } from '../../lib/issuePeople';
import { issuePath } from '../../lib/paths';
import { activityKey, childrenKey } from '../../lib/queryKeys';
import {
  SUB_ISSUE_ORDERINGS,
  SUB_ISSUE_ORDERING_LABELS,
  isDoneRow,
  readSubIssueDisplay,
  sortSubIssues,
  subIssueDropKeys,
  writeSubIssueDisplay,
  type SubIssueDisplay,
} from '../../lib/subIssues';
import { showErrorToast, showToast } from '../../lib/toast';
import { shownStatusId } from '../../lib/triageStatus';
import { TITLE_MAX } from '../../lib/validation';
import type { IssueProgress, IssueRead, StatusRead } from '../../types/Api';
import { openPropertyChip } from '../planning/ProjectPropertyKeys';
import { ErrorAlert } from '../ui/alert';
import { Popover } from '../ui/popover';
import { Select } from '../ui/select';
import { StatusIcon } from '../ui/StatusIcon';
import Skeleton from '../ui/skeleton';
import { IconButton } from '../ui/button';
import {
  AssigneePicker,
  PriorityPicker,
  StatusPicker,
} from './PropertyPickers';
import RailSection from './RailSection';

/** Props for SubIssues. */
export interface SubIssuesProps {
  workspaceId: string;
  slug: string;
  /** The issue the rows hang off, whose team a new child is filed in. */
  parent: Pick<IssueRead, 'id' | 'team_id'>;
  rows: IssueRead[];
  isLoading: boolean;
  error: unknown;
  progress: IssueProgress;
  statuses: StatusRead[];
  people: Assignable[];
  /** Offers the pickers, dragging and the inline add row. */
  canEdit?: boolean;
  /** The signed in person, listed first in the assignee picker. */
  currentUserId?: string;
}

/** The categories the rollup counts as done. */
const DONE_CATEGORIES: ReadonlySet<string> = new Set([
  'completed',
  'cancelled',
]);

/**
 * The count the header shows: the rows once every child is loaded, counted as
 * the rollup counts them, else the rollup itself.
 */
const shownProgress = (
  progress: IssueProgress,
  rows: readonly IssueRead[],
  statuses: readonly StatusRead[],
  complete: boolean
): IssueProgress => {
  if (!complete || rows.length < progress.total) return progress;
  const categories = new Map(
    statuses.map((status) => [status.id, status.category])
  );
  const completed = rows.filter((row) =>
    DONE_CATEGORIES.has(categories.get(row.status_id) ?? '')
  ).length;
  return { total: rows.length, completed };
};

/** The inline row a child is typed into, Enter filing it and Escape leaving. */
const AddSubIssueRow: React.FC<{
  onCreate: (title: string) => Promise<boolean>;
  onDone: () => void;
}> = ({ onCreate, onDone }) => {
  const [title, setTitle] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const submit = (): void => {
    const trimmed = title.trim();
    if (trimmed === '') return;
    setTitle('');
    void onCreate(trimmed.slice(0, TITLE_MAX)).then((created) => {
      if (created) return;
      setTitle((held) => (held === '' ? trimmed : held));
    });
    inputRef.current?.focus();
  };
  return (
    <form
      className="-mx-1 flex h-7 items-center gap-1.5 px-1"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <span aria-hidden="true" className="flex h-6 w-6 justify-center">
        <StatusIcon />
      </span>
      <input
        ref={inputRef}
        aria-label="New sub-issue title"
        placeholder="Sub-issue title, then Enter"
        autoFocus
        maxLength={TITLE_MAX}
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
        }}
        onBlur={() => {
          if (title.trim() === '') onDone();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onDone();
          }
        }}
        className="min-w-0 flex-1 bg-transparent text-xs text-text placeholder:text-text-faint focus:outline-none"
      />
    </form>
  );
};

/** The pickers the property keys open on a focused row, by key. */
const ROW_PROPERTY_KEYS: Record<string, string> = {
  s: 'Status',
  p: 'Priority',
  a: 'Assignee',
};

/** The attribute each row carries its issue id in. */
const ROW_ATTRIBUTE = 'data-sub-issue-id';

/** The Display button: the ordering and whether completed sub-issues show. */
const SubIssuesDisplayMenu: React.FC<{
  display: SubIssueDisplay;
  onChange: (patch: Partial<SubIssueDisplay>) => void;
}> = ({ display, onChange }) => (
  <Popover
    label="Sub-issue display options"
    align="end"
    contentClassName="w-64 p-3"
    trigger={(props) => (
      <IconButton
        {...props}
        label="Sub-issue display options"
        size="sm"
        className="h-5 w-5 shrink-0"
      >
        <LuSlidersHorizontal className="h-3.5 w-3.5" />
      </IconButton>
    )}
  >
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor="sub-issues-order" className="text-xs text-text-muted">
          Ordering
        </label>
        <Select
          id="sub-issues-order"
          className="h-7 w-32 py-0 text-xs"
          value={display.ordering}
          onChange={(event) => {
            const next = SUB_ISSUE_ORDERINGS.find(
              (choice) => choice === event.target.value
            );
            if (next !== undefined) onChange({ ordering: next });
          }}
        >
          {SUB_ISSUE_ORDERINGS.map((choice) => (
            <option key={choice} value={choice}>
              {SUB_ISSUE_ORDERING_LABELS[choice]}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex items-center justify-between gap-4">
        <label
          htmlFor="sub-issues-completed"
          className="text-xs text-text-muted"
        >
          Show completed
        </label>
        <input
          id="sub-issues-completed"
          type="checkbox"
          role="switch"
          checked={display.showCompleted}
          onChange={(event) => {
            onChange({ showCompleted: event.target.checked });
          }}
          className="h-4 w-7 cursor-pointer accent-accent"
        />
      </div>
    </div>
  </Popover>
);

/** The sub-issues section of an issue. */
export const SubIssues: React.FC<SubIssuesProps> = ({
  workspaceId,
  slug,
  parent,
  rows,
  isLoading,
  error,
  progress,
  statuses,
  people,
  canEdit = false,
  currentUserId,
}) => {
  const { peekIssue } = usePeekIssue();
  const triageOn = useTriageOn(parent.team_id);
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<IssueRead[]>([]);
  const [display, setDisplay] = useState<SubIssueDisplay>(readSubIssueDisplay);
  const [completedOpen, setCompletedOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const heldIds = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  if (created.some((row) => heldIds.has(row.id))) {
    setCreated((pending) => pending.filter((row) => !heldIds.has(row.id)));
  }

  const read = useMemo<OrderedIssueRead[]>(
    () => [...rows, ...created.filter((row) => !heldIds.has(row.id))],
    [rows, created, heldIds]
  );

  const { issues: shown, update } = useOptimisticIssues(
    workspaceId,
    read,
    childrenKey(parent.id)
  );

  const count = shownProgress(
    progress,
    shown,
    statuses,
    !isLoading && (error === null || error === undefined)
  );

  const ordered = useMemo(
    () => sortSubIssues(shown, display.ordering, statuses),
    [shown, display.ordering, statuses]
  );
  const doneCount = useMemo(
    () => ordered.filter((row) => isDoneRow(row, statuses)).length,
    [ordered, statuses]
  );
  const hidingDone = !display.showCompleted && !completedOpen;
  const visible = useMemo(
    () =>
      hidingDone ? ordered.filter((row) => !isDoneRow(row, statuses)) : ordered,
    [ordered, hidingDone, statuses]
  );

  const changeDisplay = (patch: Partial<SubIssueDisplay>): void => {
    const next = { ...display, ...patch };
    setDisplay(next);
    writeSubIssueDisplay(next);
    if (patch.showCompleted !== undefined) setCompletedOpen(false);
  };

  const place = (
    placements: readonly { id: string; sort_order: string }[]
  ): void => {
    for (const { id, sort_order } of placements) update([id], { sort_order });
  };

  const reorder = (id: string, step: 1 | -1): void => {
    if (display.ordering !== 'manual') {
      showToast('Switch ordering to Manual to move sub-issues', 'info');
      return;
    }
    const placements = manualMoveKeys(visible, id, step);
    if (placements !== null) place(placements);
  };

  const endDrag = (): void => {
    setDragId(null);
    setSlot(null);
  };

  const drop = (index: number): void => {
    const moving = dragId;
    endDrag();
    if (moving === null) return;
    const placements = subIssueDropKeys(visible, moving, index);
    if (placements === null || placements.length === 0) return;
    place(placements);
    if (display.ordering !== 'manual') changeDisplay({ ordering: 'manual' });
  };

  const focusRow = (from: HTMLElement, step: 1 | -1): void => {
    const all = [
      ...(listRef.current?.querySelectorAll<HTMLElement>(
        `li[${ROW_ATTRIBUTE}]`
      ) ?? []),
    ];
    const next = all[all.indexOf(from) + step];
    next?.querySelector<HTMLElement>('a')?.focus();
  };

  const onListKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    if (isTypingTarget(target) || target.closest('[role="dialog"]') !== null)
      return;
    const row = target.closest<HTMLElement>(`li[${ROW_ATTRIBUTE}]`);
    const id = row?.getAttribute(ROW_ATTRIBUTE);
    if (row === null || id === null || id === undefined) return;
    const arrow =
      event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : null;
    if (event.altKey && arrow !== null) {
      event.preventDefault();
      if (canEdit) reorder(id, arrow);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    const key = event.key.toLowerCase();
    const step =
      key === 'j' || arrow === 1 ? 1 : key === 'k' || arrow === -1 ? -1 : null;
    if (step !== null) {
      event.preventDefault();
      focusRow(row, step);
      return;
    }
    const field = ROW_PROPERTY_KEYS[key];
    if (field !== undefined && canEdit) {
      event.preventDefault();
      openPropertyChip(row, field);
    }
  };

  const addChild = async (title: string): Promise<boolean> => {
    try {
      const child = await createIssue(workspaceId, {
        team_id: parent.team_id,
        title,
        parent_id: parent.id,
      });
      setCreated((pending) => [...pending, child]);
    } catch (cause) {
      showErrorToast(errorMessage(cause, 'Could not create that sub-issue.'));
      return false;
    }
    invalidateQueries([childrenKey(parent.id), activityKey(parent.id)]);
    return true;
  };

  if (!isLoading && shown.length === 0 && !canEdit) return null;

  const others =
    dragId === null ? visible : visible.filter((row) => row.id !== dragId);
  const marker =
    dragId === null || slot === null ? undefined : (others[slot]?.id ?? null);
  const placeholder = (
    <li
      key="drop-placeholder"
      aria-hidden="true"
      className="-mx-1 h-7 rounded-sm border border-dashed border-accent bg-accent-soft/40"
    />
  );
  const hiddenCount = hidingDone ? doneCount : 0;

  return (
    <RailSection
      title="Sub-issues"
      {...(count.total > 0
        ? { count: `${String(count.completed)}/${String(count.total)}` }
        : {})}
      actions={
        shown.length > 0 ? (
          <SubIssuesDisplayMenu display={display} onChange={changeDisplay} />
        ) : undefined
      }
      {...(canEdit
        ? {
            add: {
              label: 'Add sub-issue',
              onClick: () => {
                setAdding(true);
              },
            },
          }
        : {})}
    >
      {error !== null && error !== undefined && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the sub-issues.')}
        />
      )}
      {isLoading ? (
        <div role="status" aria-label="Loading sub-issues" className="py-1">
          <Skeleton className="h-4 w-full" />
        </div>
      ) : shown.length === 0 ? (
        !adding && <p className="py-1 text-xs text-text-faint">No sub-issues</p>
      ) : (
        <>
          <ul
            ref={listRef}
            aria-label="Sub-issues"
            onKeyDown={onListKeyDown}
            onDragOver={(event) => {
              if (dragId === null) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              const next = slotIndex(
                event.currentTarget,
                dragId,
                event.clientY,
                ROW_ATTRIBUTE
              );
              if (next !== slot) setSlot(next);
            }}
            onDragLeave={(event) => {
              if (
                dragId !== null &&
                !event.currentTarget.contains(event.relatedTarget as Node)
              )
                setSlot(null);
            }}
            onDrop={(event) => {
              if (dragId === null) return;
              event.preventDefault();
              drop(
                slot ??
                  slotIndex(
                    event.currentTarget,
                    dragId,
                    event.clientY,
                    ROW_ATTRIBUTE
                  )
              );
            }}
          >
            {visible.map((child) => {
              const noPriority = child.priority === 'none';
              const noAssignee = child.assignee_id === null;
              const faded =
                'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100';
              return (
                <React.Fragment key={child.id}>
                  {marker === child.id && placeholder}
                  <li
                    data-sub-issue-id={child.id}
                    draggable={canEdit}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', child.key);
                      setDragId(child.id);
                    }}
                    onDragEnd={endDrag}
                    className={cn(
                      'group/row -mx-1 flex h-7 items-center gap-0.5 rounded-sm px-0.5 transition-colors duration-100 hover:bg-raised focus-within:bg-raised',
                      dragId === child.id && 'opacity-40'
                    )}
                  >
                    <StatusPicker
                      variant="icon"
                      statuses={statuses}
                      triage={triageOn}
                      value={shownStatusId(child)}
                      disabled={!canEdit}
                      onChange={(statusId) => {
                        update([child.id], { status_id: statusId });
                      }}
                      className="shrink-0"
                    />
                    <Link
                      to={issuePath(slug, child.key)}
                      title={child.title}
                      draggable={false}
                      data-hover="parent"
                      className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-sm pr-1 text-xs focus-visible:outline-none"
                      onKeyDown={(event) => {
                        if (event.key !== ' ') return;
                        event.preventDefault();
                        peekIssue({ id: child.id, key: child.key });
                      }}
                    >
                      <span className="shrink-0 font-mono text-text-faint">
                        {child.key}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-text">
                        {child.title}
                      </span>
                    </Link>
                    {(canEdit || !noPriority) && (
                      <PriorityPicker
                        variant="icon"
                        align="end"
                        value={child.priority}
                        disabled={!canEdit}
                        onChange={(priority) => {
                          update([child.id], { priority });
                        }}
                        className={cn('shrink-0', noPriority && faded)}
                      />
                    )}
                    {(canEdit || !noAssignee) && (
                      <AssigneePicker
                        variant="icon"
                        align="end"
                        people={people}
                        value={child.assignee_id ?? null}
                        disabled={!canEdit}
                        onChange={(assigneeId) => {
                          update([child.id], { assignee_id: assigneeId });
                        }}
                        {...(currentUserId === undefined
                          ? {}
                          : { currentUserId })}
                        className={cn('shrink-0', noAssignee && faded)}
                      />
                    )}
                  </li>
                </React.Fragment>
              );
            })}
            {marker === null && placeholder}
          </ul>
          {!display.showCompleted && doneCount > 0 && (
            <button
              type="button"
              aria-expanded={completedOpen}
              onClick={() => {
                setCompletedOpen((open) => !open);
              }}
              className="-mx-1 mt-0.5 flex h-6 items-center rounded-sm px-1 text-xs text-text-faint transition-colors duration-100 hover:bg-raised hover:text-text"
            >
              {completedOpen
                ? 'Hide completed'
                : `${String(hiddenCount)} completed`}
            </button>
          )}
        </>
      )}
      {canEdit && adding && (
        <AddSubIssueRow
          onCreate={addChild}
          onDone={() => {
            setAdding(false);
          }}
        />
      )}
    </RailSection>
  );
};

export default SubIssues;
