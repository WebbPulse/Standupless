/**
 * The direct children of one issue as a compact list section. The count in
 * the header reads `progress` on the parent, which the rollup consumer
 * maintains, until every child is loaded; from then it counts the rows, so a
 * status picked or a child added here shows at once rather than when the
 * rollup lands. A row opens its issue on click, Space on a focused row peeks
 * it, and its status, priority and assignee chips open the shared pickers,
 * writing through the optimistic layer so each change can be undone. In the
 * peek pane a plain click opens the row in place instead, and Cmd or Ctrl+click
 * still opens its page.
 *
 * Rows drag into a manual order, move a step with Alt+Up and Alt+Down, or go
 * to the top or bottom with Alt+Shift+Up and Alt+Shift+Down; j
 * and k move focus between rows, and s, p and a open the focused row's
 * pickers rather than the parent's. The Display button sets the ordering and
 * whether completed sub-issues show, remembered for the viewer; hidden ones
 * fold into an "N completed" row that expands them. The add button opens an
 * inline row that files a child per Enter and stays open for the next one,
 * with status, priority and assignee pickers; Ctrl or Cmd+Shift+Enter keeps
 * the picked values for the next title, and pasting several lines files one
 * child per line once confirmed. Children inherit the parent's team, priority
 * and project, as in Linear, and the row starts on the parent's assignee when
 * the person holds the parent or every loaded sibling shares it. The server
 * decides the cycle from the status a child starts in.
 *
 * On a phone a row keeps to its status, its title and the properties that are
 * set, as Linear's mobile web does: the key and the empty priority and
 * assignee pickers drop out, and on touch every control grows to a tappable
 * height.
 */

import React, { useMemo, useRef, useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { LuSlidersHorizontal } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { IssueHoverTrigger } from '../ui/IssueHoverCard';
import { createIssue, type OrderedIssueRead } from '../../api/issues';
import { isTypingTarget } from '../../hooks/useCommandPalette';
import { useOptimisticIssues } from '../../hooks/useOptimisticIssues';
import { useTriageOn } from '../../hooks/useTriageTeams';
import { cn } from '../../lib/cn';
import { slotIndex } from '../../lib/dropSlot';
import { errorMessage } from '../../lib/errors';
import { manualEdgeKeys, manualMoveKeys } from '../../lib/issueView';
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
import {
  createSubIssues,
  inheritedAssignee,
  subIssueBody,
  type ResolvedSubIssueParent,
  type SubIssueExtras,
} from '../../lib/subIssueCreation';
import { splitTitles } from '../../lib/subIssueLines';
import { showErrorToast, showToast } from '../../lib/toast';
import { shownStatusId } from '../../lib/triageStatus';
import { TITLE_MAX } from '../../lib/validation';
import type {
  IssuePriority,
  IssueProgress,
  IssueRead,
  StatusRead,
} from '../../types/Api';
import { openPropertyChip } from '../planning/ProjectPropertyKeys';
import { ErrorAlert } from '../ui/alert';
import { Popover } from '../ui/popover';
import { Select } from '../ui/select';
import Skeleton from '../ui/skeleton';
import Button, { IconButton } from '../ui/button';
import Dialog from '../ui/dialog';
import ProgressRing from '../planning/ProgressRing';
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
  /**
   * The issue the rows hang off. A new child is filed in its team and inherits
   * its priority, project and, by Linear's rule, assignee when given.
   */
  parent: Pick<IssueRead, 'id' | 'team_id'> &
    Partial<Pick<IssueRead, 'key' | 'priority' | 'project_id' | 'assignee_id'>>;
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
  /**
   * Opens a row in place, as the peek pane does, on a plain click or Space.
   * A modified click still follows the link to the full page.
   */
  onOpenRow?: (issue: { id: string; key: string }) => void;
  /**
   * Peeks a focused row on Space when no `onOpenRow` is given. Passed in
   * rather than read here, since the peek pane renders this section and
   * reading the peek hook here would import the pane into itself.
   */
  onPeekRow?: (issue: { id: string; key: string }) => void;
  /** Says "No sub-issues" under an empty header. Defaults to true. */
  emptyHint?: boolean;
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

/**
 * The fields the inline row sets on each child it files. An undefined
 * assignee is one the person has not touched, so it follows the inherited one.
 */
interface RowFields {
  statusId: string | null;
  priority: IssuePriority;
  assigneeId: string | null | undefined;
}

/**
 * The fields as create extras, the priority only when it differs. A picked
 * assignee, none included, is always sent; an untouched one sends the
 * inherited assignee when there is one and otherwise leaves it to the server.
 */
const rowExtras = (
  fields: RowFields,
  inherited: IssuePriority,
  inheritedAssigneeId: string | null
): SubIssueExtras => {
  const assigneeId =
    fields.assigneeId === undefined ? inheritedAssigneeId : fields.assigneeId;
  return {
    ...(fields.statusId === null ? {} : { status_id: fields.statusId }),
    ...(fields.priority === inherited ? {} : { priority: fields.priority }),
    ...(fields.assigneeId === undefined && assigneeId === null
      ? {}
      : { assignee_id: assigneeId }),
  };
};

/** Asks before pasted lines become that many sub-issues, listing them. */
const ConfirmPastedTitles: React.FC<{
  titles: readonly string[];
  onClose: () => void;
  onConfirm: () => Promise<void>;
}> = ({ titles, onClose, onConfirm }) => {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Create ${String(titles.length)} sub-issues?`}
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
        <ol
          aria-label="Pasted sub-issues"
          className="max-h-64 list-decimal space-y-1 overflow-y-auto pl-5 text-sm text-text"
        >
          {titles.map((title, index) => (
            <li key={`${String(index)}-${title}`} className="break-words">
              {title}
            </li>
          ))}
        </ol>
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy} autoFocus>
            {busy ? 'Creating' : `Create ${String(titles.length)}`}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

/**
 * The inline row a child is typed into. Enter files it and resets the
 * pickers, Ctrl or Cmd+Shift+Enter files it and keeps them for the next
 * title, and Escape leaves. Pasting two or more lines asks before filing one
 * child per line, in order.
 */
const AddSubIssueRow: React.FC<{
  statuses: StatusRead[];
  triage: boolean;
  people: Assignable[];
  currentUserId?: string;
  inheritedPriority: IssuePriority;
  inheritedAssigneeId: string | null;
  onCreate: (title: string, extras: SubIssueExtras) => Promise<boolean>;
  onCreateMany: (
    titles: readonly string[],
    extras: SubIssueExtras
  ) => Promise<void>;
  onDone: () => void;
}> = ({
  statuses,
  triage,
  people,
  currentUserId,
  inheritedPriority,
  inheritedAssigneeId,
  onCreate,
  onCreateMany,
  onDone,
}) => {
  const fresh: RowFields = {
    statusId: null,
    priority: inheritedPriority,
    assigneeId: undefined,
  };
  const [title, setTitle] = useState('');
  const [fields, setFields] = useState<RowFields>(fresh);
  const [pasted, setPasted] = useState<string[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const dirty =
    fields.statusId !== null ||
    fields.priority !== inheritedPriority ||
    (fields.assigneeId !== undefined &&
      fields.assigneeId !== inheritedAssigneeId);
  const submit = (keep: boolean): void => {
    const trimmed = title.trim();
    if (trimmed === '') return;
    const held = fields;
    setTitle('');
    if (!keep) setFields(fresh);
    void onCreate(
      trimmed.slice(0, TITLE_MAX),
      rowExtras(held, inheritedPriority, inheritedAssigneeId)
    ).then((created) => {
      if (created) return;
      setTitle((typed) => (typed === '' ? trimmed : typed));
      setFields(held);
    });
    inputRef.current?.focus();
  };
  const set = (change: Partial<RowFields>): void => {
    setFields((current) => ({ ...current, ...change }));
    inputRef.current?.focus();
  };
  return (
    <>
      <form
        ref={formRef}
        className="-mx-1 flex h-7 items-center gap-1.5 px-1 pointer-coarse:h-11"
        onSubmit={(event) => {
          event.preventDefault();
          submit(false);
        }}
      >
        <StatusPicker
          variant="icon"
          statuses={statuses}
          triage={triage}
          value={fields.statusId}
          onChange={(statusId) => {
            set({ statusId });
          }}
          className="shrink-0 pointer-coarse:h-11 pointer-coarse:w-9"
        />
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
          onPaste={(event) => {
            const titles = splitTitles(
              event.clipboardData.getData('text/plain')
            );
            if (titles.length < 2) return;
            event.preventDefault();
            setPasted(titles);
          }}
          onBlur={(event) => {
            const next = event.relatedTarget;
            if (next instanceof Node && formRef.current?.contains(next)) {
              return;
            }
            if (title.trim() === '' && !dirty && pasted === null) onDone();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onDone();
              return;
            }
            if (
              event.key === 'Enter' &&
              event.shiftKey &&
              (event.metaKey || event.ctrlKey)
            ) {
              event.preventDefault();
              event.stopPropagation();
              submit(true);
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-xs text-text placeholder:text-text-faint focus:outline-none max-sm:text-sm"
        />
        <PriorityPicker
          variant="icon"
          align="end"
          value={fields.priority}
          onChange={(priority) => {
            set({ priority });
          }}
          className="shrink-0 pointer-coarse:h-11 pointer-coarse:w-9"
        />
        <AssigneePicker
          variant="icon"
          align="end"
          people={people}
          value={
            fields.assigneeId === undefined
              ? inheritedAssigneeId
              : fields.assigneeId
          }
          onChange={(assigneeId) => {
            set({ assigneeId });
          }}
          {...(currentUserId === undefined ? {} : { currentUserId })}
          className="shrink-0 pointer-coarse:h-11 pointer-coarse:w-9"
        />
      </form>
      {pasted !== null && (
        <ConfirmPastedTitles
          titles={pasted}
          onClose={() => {
            setPasted(null);
            inputRef.current?.focus();
          }}
          onConfirm={() =>
            onCreateMany(
              pasted,
              rowExtras(fields, inheritedPriority, inheritedAssigneeId)
            )
          }
        />
      )}
    </>
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
        className="h-5 w-5 shrink-0 pointer-coarse:h-9 pointer-coarse:w-9"
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
  onOpenRow,
  onPeekRow,
  emptyHint = true,
}) => {
  const openRow = onOpenRow ?? onPeekRow;
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

  const reorderToEdge = (id: string, edge: 'top' | 'bottom'): void => {
    if (display.ordering !== 'manual') {
      showToast('Switch ordering to Manual to move sub-issues', 'info');
      return;
    }
    const placements = manualEdgeKeys(visible, [id], edge);
    if (placements === null) return;
    const keys = new Map(
      placements.map((placement) => [placement.id, placement.sort_order])
    );
    update([...keys.keys()], (issue) => {
      const sort_order = keys.get(issue.id);
      return sort_order === undefined ? null : { sort_order };
    });
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
      if (!canEdit) return;
      if (event.shiftKey) reorderToEdge(id, arrow === -1 ? 'top' : 'bottom');
      else reorder(id, arrow);
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

  const childParent: ResolvedSubIssueParent = {
    id: parent.id,
    key: parent.key ?? '',
    teamId: parent.team_id,
    priority: parent.priority ?? 'none',
    projectId: parent.project_id ?? null,
    assigneeId: parent.assignee_id ?? null,
  };
  const rowAssigneeId = inheritedAssignee(
    childParent.assigneeId ?? null,
    currentUserId,
    isLoading || shown.length < progress.total
      ? undefined
      : shown.map((row) => row.assignee_id)
  );

  const addChild = async (
    title: string,
    extras: SubIssueExtras
  ): Promise<boolean> => {
    try {
      const child = await createIssue(
        workspaceId,
        subIssueBody(childParent, { title }, extras)
      );
      setCreated((pending) => [...pending, child]);
    } catch (cause) {
      showErrorToast(errorMessage(cause, 'Could not create that sub-issue.'));
      return false;
    }
    invalidateQueries([childrenKey(parent.id), activityKey(parent.id)]);
    return true;
  };

  const addChildren = async (
    titles: readonly string[],
    extras: SubIssueExtras
  ): Promise<void> => {
    const run = await createSubIssues(
      workspaceId,
      childParent,
      titles.map((title) => ({ title })),
      extras
    );
    setCreated((pending) => [...pending, ...run.created]);
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
      className="-mx-1 h-7 rounded-sm border border-dashed pointer-coarse:h-11 border-accent bg-accent-soft/40"
    />
  );
  const hiddenCount = hidingDone ? doneCount : 0;

  return (
    <RailSection
      title="Sub-issues"
      {...(count.total > 0
        ? {
            count: `${String(count.completed)}/${String(count.total)}`,
            countIcon: (
              <ProgressRing
                percent={Math.round((count.completed / count.total) * 100)}
                size={12}
              />
            ),
          }
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
        !adding &&
        emptyHint && (
          <p className="py-1 text-xs text-text-faint">No sub-issues</p>
        )
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
                'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 max-sm:hidden';
              const touch = 'pointer-coarse:h-11 pointer-coarse:w-9';
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
                      'group/row -mx-1 flex h-7 min-w-0 items-center gap-0.5 rounded-sm px-0.5 transition-colors duration-100 hover:bg-raised focus-within:bg-raised pointer-coarse:h-11',
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
                      className={cn('shrink-0', touch)}
                    />
                    <IssueHoverTrigger issueKey={child.key}>
                      {(hover) => (
                        <Link
                          to={issuePath(slug, child.key)}
                          {...hover}
                          draggable={false}
                          data-hover="parent"
                          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-sm pr-1 text-xs focus-visible:outline-none pointer-coarse:h-11 max-sm:text-sm"
                          onClick={(event) => {
                            if (
                              onOpenRow === undefined ||
                              event.button !== 0 ||
                              event.metaKey ||
                              event.ctrlKey ||
                              event.shiftKey ||
                              event.altKey
                            )
                              return;
                            event.preventDefault();
                            onOpenRow({ id: child.id, key: child.key });
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== ' ' || openRow === undefined)
                              return;
                            event.preventDefault();
                            openRow({ id: child.id, key: child.key });
                          }}
                        >
                          <span className="shrink-0 font-mono text-text-faint max-sm:hidden">
                            {child.key}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-text">
                            {child.title}
                          </span>
                        </Link>
                      )}
                    </IssueHoverTrigger>
                    {(canEdit || !noPriority) && (
                      <PriorityPicker
                        variant="icon"
                        align="end"
                        value={child.priority}
                        disabled={!canEdit}
                        onChange={(priority) => {
                          update([child.id], { priority });
                        }}
                        className={cn('shrink-0', touch, noPriority && faded)}
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
                        className={cn('shrink-0', touch, noAssignee && faded)}
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
              className="-mx-1 mt-0.5 flex h-6 items-center rounded-sm px-1 text-xs text-text-faint transition-colors duration-100 hover:bg-raised hover:text-text pointer-coarse:h-10 max-sm:text-sm"
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
          statuses={statuses}
          triage={triageOn}
          people={people}
          {...(currentUserId === undefined ? {} : { currentUserId })}
          inheritedPriority={childParent.priority}
          inheritedAssigneeId={rowAssigneeId}
          onCreate={addChild}
          onCreateMany={addChildren}
          onDone={() => {
            setAdding(false);
          }}
        />
      )}
    </RailSection>
  );
};

export default SubIssues;
