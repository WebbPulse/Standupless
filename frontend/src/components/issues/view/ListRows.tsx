/**
 * The list layout: sticky group headers with counts that fold their rows
 * away, optional sub-group headers inside them, and one dense row per issue.
 * A row is a stretched link to the issue with the pickers lifted above it,
 * so a click on the row opens the issue and a click on a glyph edits it.
 * Every row reserves the same leading slots (select, disclosure, priority,
 * key, status) at fixed widths, so the glyphs line up across every group
 * whether or not a group holds a parent. Nested sub-issues indent their
 * title only, with tree connectors drawn in the indent; a parent carries a
 * done/total chip beside its title, and a sub-issue listed apart from its
 * parent names it in a muted prefix.
 *
 * Each group header carries a menu, from its "..." button or a right click,
 * that folds or unfolds every group beside it or hides the group. Alt+click on
 * a header folds or unfolds every group to match. Hidden groups drop out of
 * the list and wait in a quiet row at its foot, one click from coming back.
 *
 * Rows drag by their body, not by a checkbox or a picker, with a line marking
 * where they land. A drop inside a group writes a manual position between its
 * neighbours and switches the view to manual ordering; a drop in another group
 * or sub-group sets that grouped property, the way the board lands a card.
 * A drop on a group header, folded or not, moves the rows into that group, at
 * its end in manual ordering. Groups a drag cannot set, such as computed ones,
 * refuse the drop. A drag on a selected row carries the selection, with a
 * count badge, in one write with one undo entry. Nested sub-issues move as
 * their own issues and keep their parent.
 *
 * On a touch screen a row takes gestures instead of a drag: a swipe right
 * opens its status picker, a swipe left its quick menu of assign to me,
 * priority and a reminder, and a long press the same menu a right click
 * opens. A mouse still drags rows exactly as above.
 */

import React from 'react';
import {
  LuArchive,
  LuBan,
  LuChevronRight,
  LuChevronsDownUp,
  LuChevronsUpDown,
  LuEllipsis,
  LuEyeOff,
  LuFlame,
  LuPlus,
  LuRefreshCcw,
  LuRocket,
} from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { NONE, type OrderedIssueRead } from '../../../api/issues';
import { cn } from '../../../lib/cn';
import {
  foldedParentKey,
  parentRefOf,
  treeGuides,
  treeRows,
  type TreeGuide,
  type TreeRow,
} from '../../../lib/issueTree';
import {
  draggedIds,
  isNoOpDrop,
  setCountDragImage,
} from '../../../lib/boardDrop';
import { groupFigure } from '../../../lib/groupHeader';
import { FOCUS_FIELD } from '../../../lib/focusGrouping';
import {
  hiddenColumnKey,
  hiddenSubGroupKey,
  isLabelGroupField,
  splitHiddenSections,
  type GroupField,
  type HiddenGroup,
  type IssueGroup,
  type ViewState,
} from '../../../lib/issueView';
import { issuePath } from '../../../lib/paths';
import Avatar from '../../ui/avatar';
import { IconButton } from '../../ui/button';
import { ContextMenu, Menu, MenuItem, MenuSeparator } from '../../ui/menu';
import { PriorityGlyph } from '../../ui/glyphs';
import { StatusIcon } from '../../ui/StatusIcon';
import { TruncatedText, useTruncationTooltip } from '../../ui/truncated-text';
import MilestoneGlyph from '../../planning/MilestoneGlyph';
import ProgressRing from '../../planning/ProgressRing';
import { RelationMarkers } from '../BlockedMarker';
import {
  AssigneeCell,
  MetaChips,
  PriorityCell,
  StatusCell,
} from './IssueProperties';
import { useIssueViewEnv, useRowFocus } from './IssueViewContext';
import {
  canDragIssue,
  landIssueDrop,
  takesDrop,
  type DropCell,
  type DropLanding,
} from './issueDrop';
import { ParentPrefix, SubIssueProgressChip, TreeGuides } from './SubIssueCues';
import { useIssuePrefetch } from '../../../hooks/useIssuePrefetch';
import { useCoarsePointer } from '../../../hooks/useCoarsePointer';
import { useSwipeActions } from '../../../hooks/useSwipeActions';
import { useLatestCallback } from '../../../hooks/useLatestCallback';

/** One group with its sub-groups, when the view is sub-grouped. */
export interface IssueSection {
  group: IssueGroup;
  subs: IssueGroup[] | null;
}

/**
 * The figure a group header reads beside its name: the issue count, or the
 * total estimate when the view's group header asks for it, and a customer's
 * request count when the group carries one.
 */
export const GroupFigure: React.FC<{
  issues: readonly OrderedIssueRead[];
  requests?: number | undefined;
}> = ({ issues, requests }) => {
  const env = useIssueViewEnv();
  return (
    <>
      <span className="text-xs text-text-faint tabular-nums">
        {groupFigure(issues, env.state.groupHeader, {
          scaleFor: env.scaleFor,
          countsUnestimated: env.countsUnestimated,
        })}
      </span>
      {requests !== undefined && (
        <span className="shrink-0 text-xs text-text-faint tabular-nums">
          {requests === 1 ? '1 request' : `${requests} requests`}
        </span>
      )}
    </>
  );
};

const FOCUS_ICONS: Partial<Record<string, React.ReactNode>> = {
  sla: <LuFlame aria-hidden="true" className="h-3.5 w-3.5 text-text-muted" />,
  blockers: (
    <LuBan aria-hidden="true" className="h-3.5 w-3.5 text-text-muted" />
  ),
  cycle: (
    <LuRefreshCcw aria-hidden="true" className="h-3.5 w-3.5 text-text-muted" />
  ),
};

/**
 * The glyph a Focus section heads with: the urgent priority, a status glyph
 * for the sections a status category names, and an icon for the rest.
 */
const FocusGlyph: React.FC<{ group: IssueGroup }> = ({ group }) => {
  if (group.priority !== undefined) {
    return <PriorityGlyph priority={group.priority} />;
  }
  if (group.statusLook !== undefined) {
    return <StatusIcon look={group.statusLook} />;
  }
  if (group.category !== undefined) {
    return <StatusIcon status={{ category: group.category }} />;
  }
  return FOCUS_ICONS[group.key] ?? null;
};

/** The glyph a group header leads with. */
export const GroupGlyph: React.FC<{ group: IssueGroup }> = ({ group }) => {
  if (group.field === FOCUS_FIELD) return <FocusGlyph group={group} />;
  if (group.field === 'status') {
    return group.statusLook === undefined ? (
      <StatusIcon
        {...(group.category === undefined
          ? {}
          : { status: { category: group.category } })}
      />
    ) : (
      <StatusIcon look={group.statusLook} />
    );
  }
  if (group.field === 'priority') {
    return <PriorityGlyph priority={group.priority} />;
  }
  if (group.field === 'assignee') {
    return group.person === undefined ? (
      <span
        aria-hidden="true"
        className="h-4 w-4 rounded-full border border-dashed border-text-faint"
      />
    ) : (
      <Avatar name={group.person} size="xs" />
    );
  }
  if (group.field === 'label' || isLabelGroupField(group.field)) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'h-2.5 w-2.5 rounded-full',
          group.color === undefined && 'border border-dashed border-text-faint'
        )}
        style={
          group.color === undefined
            ? undefined
            : { backgroundColor: group.color }
        }
      />
    );
  }
  if (group.field === 'customer') {
    return group.key === NONE ? (
      <span
        aria-hidden="true"
        className="h-4 w-4 rounded-sm border border-dashed border-text-faint"
      />
    ) : (
      <Avatar name={group.label} size="xs" shape="square" />
    );
  }
  if (group.field === 'release') {
    return group.key === NONE ? (
      <span
        aria-hidden="true"
        className="h-3.5 w-3.5 rounded-full border border-dashed border-text-faint"
      />
    ) : (
      <LuRocket aria-hidden="true" className="h-3.5 w-3.5 text-text-muted" />
    );
  }
  if (group.field === 'milestone' && group.milestone !== undefined) {
    return <MilestoneGlyph milestone={group.milestone} decorative />;
  }
  if (
    group.field === 'milestone' ||
    group.field === 'project' ||
    group.field === 'cycle'
  ) {
    return group.progress === undefined ? (
      <span
        aria-hidden="true"
        className="h-3.5 w-3.5 rounded-full border border-dashed border-text-faint"
      />
    ) : (
      <ProgressRing percent={group.progress} />
    );
  }
  return null;
};

/** Props for GroupHeader. */
export interface GroupHeaderProps {
  group: IssueGroup;
  collapsed: boolean;
  onToggle: () => void;
  /** Files a new issue into this group, when the group can take one. */
  onCreate?: (() => void) | undefined;
  /** True for a sub-group, drawn indented and quieter. */
  nested?: boolean;
  /**
   * Folds or unfolds this group and every group beside it, the top level
   * groups for a group and the sub-groups of the same parent for a sub-group.
   */
  onFoldAll?: ((folded: boolean) => void) | undefined;
  /** Hides the group from the list. */
  onHide?: (() => void) | undefined;
  /** Takes a drop of dragged rows, where the list drags. */
  drop?: HeaderDrop | undefined;
}

/** What a group header reads to take a drop of dragged rows. */
export interface HeaderDrop {
  /** True while the drag hovers this header. */
  active: boolean;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (event: React.DragEvent) => void;
}

/** Keeps Space on a checkbox a native toggle rather than the list's peek. */
const holdSpace = (event: React.KeyboardEvent): void => {
  if (event.key === ' ') event.stopPropagation();
};

/**
 * Selects or clears every issue in a section, folded or not, and shows a
 * partial selection as indeterminate. Hidden until the header is hovered or
 * something is already selected.
 */
const SectionCheckbox: React.FC<{ group: IssueGroup }> = ({ group }) => {
  const env = useIssueViewEnv();
  const ref = React.useRef<HTMLInputElement>(null);
  const ids = group.issues.map((issue) => issue.id);
  const held = ids.filter((id) => env.selected.has(id)).length;
  const all = ids.length > 0 && held === ids.length;
  const some = held > 0 && !all;
  const selecting = env.selected.size > 0;
  React.useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = some;
  }, [some]);
  if (env.selectMany === undefined || ids.length === 0) {
    return <span className="w-5 shrink-0" />;
  }
  const selectMany = env.selectMany;
  return (
    <span
      className={cn(
        'relative z-10 flex w-5 shrink-0 justify-center',
        !selecting && 'pointer-coarse:hidden'
      )}
    >
      <input
        ref={ref}
        type="checkbox"
        aria-label={`Select all in ${group.label}`}
        aria-checked={some ? 'mixed' : all}
        checked={all}
        onChange={() => {
          selectMany(ids, !all);
        }}
        onKeyDown={holdSpace}
        className={cn(
          'h-3.5 w-3.5 cursor-pointer accent-accent',
          !selecting &&
            'opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100'
        )}
      />
    </span>
  );
};

/** The header menu's items, shared by its "..." button and its right click. */
const GroupMenuItems: React.FC<{
  onFoldAll?: ((folded: boolean) => void) | undefined;
  onHide?: (() => void) | undefined;
}> = ({ onFoldAll, onHide }) => (
  <>
    {onFoldAll !== undefined && (
      <>
        <MenuItem
          onSelect={() => {
            onFoldAll(true);
          }}
        >
          <LuChevronsDownUp aria-hidden="true" className="h-3.5 w-3.5" />
          Collapse all
        </MenuItem>
        <MenuItem
          onSelect={() => {
            onFoldAll(false);
          }}
        >
          <LuChevronsUpDown aria-hidden="true" className="h-3.5 w-3.5" />
          Expand all
        </MenuItem>
      </>
    )}
    {onFoldAll !== undefined && onHide !== undefined && <MenuSeparator />}
    {onHide !== undefined && (
      <MenuItem onSelect={onHide}>
        <LuEyeOff aria-hidden="true" className="h-3.5 w-3.5" />
        Hide group
      </MenuItem>
    )}
  </>
);

/**
 * A group's header: select-all, fold toggle, glyph, name, count, a create
 * button and the group menu. Alt+click on the fold toggle folds or unfolds
 * every group beside it to match the clicked one.
 */
export const GroupHeader: React.FC<GroupHeaderProps> = ({
  group,
  collapsed,
  onToggle,
  onCreate,
  nested = false,
  onFoldAll,
  onHide,
  drop,
}) => {
  const [pointer, setPointer] = React.useState<{ x: number; y: number } | null>(
    null
  );
  const hasMenu = onFoldAll !== undefined || onHide !== undefined;
  const menuLabel = `${group.label} group`;
  return (
    <div
      onContextMenu={(event) => {
        if (!hasMenu) return;
        event.preventDefault();
        setPointer({ x: event.clientX, y: event.clientY });
      }}
      {...(drop === undefined
        ? {}
        : {
            onDragOver: drop.onDragOver,
            onDragLeave: drop.onDragLeave,
            onDrop: drop.onDrop,
            'data-drop-target': drop.active ? '' : undefined,
          })}
      className={cn(
        'group/header flex h-9 items-center pointer-coarse:h-11 gap-2 border-b border-line pr-3 pl-2 transition-colors duration-100 hover:bg-raised has-[button[aria-expanded]:active]:bg-line lg:pr-5',
        nested ? 'bg-bg pl-7 text-text-muted' : 'sticky top-0 z-20 bg-surface',
        drop?.active === true && 'bg-accent-soft ring-1 ring-accent ring-inset'
      )}
    >
      <SectionCheckbox group={group} />
      <button
        type="button"
        onClick={(event) => {
          if (event.altKey && onFoldAll !== undefined) {
            onFoldAll(!collapsed);
            return;
          }
          onToggle();
        }}
        aria-expanded={!collapsed}
        data-hover="parent"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm py-1 text-left text-sm focus-visible:outline-2 focus-visible:outline-accent"
      >
        <LuChevronRight
          aria-hidden="true"
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-text-faint transition-transform duration-100',
            !collapsed && 'rotate-90'
          )}
        />
        <GroupGlyph group={group} />
        <TruncatedText className="font-medium text-text">
          {group.label}
        </TruncatedText>
        <GroupFigure issues={group.issues} requests={group.requests} />
      </button>
      {hasMenu && (
        <span className="flex items-center opacity-0 group-focus-within/header:opacity-100 group-hover/header:opacity-100 has-[button[aria-expanded=true]]:opacity-100 pointer-coarse:opacity-100">
          <Menu
            label={menuLabel}
            align="end"
            trigger={(props) => (
              <IconButton
                {...props}
                label={`Group options for ${group.label}`}
                size="sm"
                variant="ghost"
              >
                <LuEllipsis className="h-3.5 w-3.5" />
              </IconButton>
            )}
          >
            <GroupMenuItems onFoldAll={onFoldAll} onHide={onHide} />
          </Menu>
        </span>
      )}
      {onCreate !== undefined && (
        <IconButton
          label={`New issue in ${group.label}`}
          size="sm"
          variant="ghost"
          className="opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
          onClick={onCreate}
        >
          <LuPlus className="h-3.5 w-3.5" />
        </IconButton>
      )}
      {pointer !== null && (
        <ContextMenu
          x={pointer.x}
          y={pointer.y}
          label={menuLabel}
          onClose={() => {
            setPointer(null);
          }}
        >
          <GroupMenuItems onFoldAll={onFoldAll} onHide={onHide} />
        </ContextMenu>
      )}
    </div>
  );
};

/**
 * The quiet row at the foot of a list that counts its hidden groups and opens
 * a menu of them, where one click brings a group back.
 */
export const HiddenGroupsRow: React.FC<{
  hidden: readonly HiddenGroup[];
  onShow: (key: string) => void;
}> = ({ hidden, onShow }) => {
  if (hidden.length === 0) return null;
  const count =
    hidden.length === 1 ? '1 hidden group' : `${hidden.length} hidden groups`;
  return (
    <div className="flex h-9 items-center pr-3 pl-2 pointer-coarse:h-11 lg:pr-5">
      <Menu
        label="Hidden groups"
        trigger={(props) => (
          <button
            {...props}
            type="button"
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-text-faint transition-colors duration-100 pointer-coarse:h-11 hover:bg-raised hover:text-text-muted focus-visible:outline-2 focus-visible:outline-accent"
          >
            <LuEyeOff aria-hidden="true" className="h-3.5 w-3.5" />
            {count}
          </button>
        )}
      >
        {hidden.map(({ key, group, parent }) => {
          const name =
            parent === undefined
              ? group.label
              : `${parent.label} / ${group.label}`;
          return (
            <MenuItem
              key={key}
              textValue={name}
              onSelect={() => {
                onShow(key);
              }}
            >
              <GroupGlyph group={group} />
              <span className="min-w-0 flex-1 truncate">
                <span className="sr-only">Show </span>
                {name}
              </span>
              <GroupFigure issues={group.issues} requests={group.requests} />
            </MenuItem>
          );
        })}
      </Menu>
    </div>
  );
};

/** The quiet mark an archived issue carries in a view that lists them. */
export const ArchivedMarker: React.FC<{ className?: string }> = ({
  className = '',
}) => (
  <span
    title="Archived"
    className={cn('flex shrink-0 items-center text-text-faint', className)}
  >
    <LuArchive aria-hidden="true" className="h-3.5 w-3.5" />
    <span className="sr-only">Archived</span>
  </span>
);

/** Where a row sits in a nested section. */
export interface IssueTreePlace {
  depth: number;
  childCount: number;
  expanded: boolean;
  onToggle: () => void;
  /** How the row's connector is drawn, from its place among its siblings. */
  guide?: TreeGuide | undefined;
}

/** The width one level of nesting indents a title by, in pixels. */
const INDENT = 22;

/** The CSS variable that carries the list's key column width, in ch. */
const KEY_WIDTH_VAR = '--issue-key-ch';

/** The fewest characters the key column is sized for. */
const MIN_KEY_CH = 6;

/** The key column width, in ch, that fits the longest key in the sections. */
const keyColumnCh = (sections: IssueSection[]): number =>
  sections.reduce(
    (widest, { group }) =>
      group.issues.reduce(
        (inner, issue) => Math.max(inner, issue.key.length),
        widest
      ),
    MIN_KEY_CH
  );

/**
 * The fixed disclosure slot every row reserves: a chevron that folds a
 * parent's sub-issues, or an empty slot of the same width.
 */
const TreeDisclosure: React.FC<{
  issueKey: string;
  place: IssueTreePlace | undefined;
}> = ({ issueKey, place }) => (
  <span data-slot="disclosure" className="flex w-5 shrink-0 items-center">
    {place !== undefined && place.childCount > 0 ? (
      <button
        type="button"
        aria-expanded={place.expanded}
        aria-label={`${place.expanded ? 'Collapse' : 'Expand'} sub-issues of ${issueKey}`}
        title={place.expanded ? 'Collapse sub-issues' : 'Expand sub-issues'}
        onClick={place.onToggle}
        className="relative z-10 flex h-5 w-5 items-center justify-center rounded-sm text-text-muted transition-colors duration-100 hover:bg-line hover:text-text focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:before:absolute pointer-coarse:before:-inset-3"
      >
        <LuChevronRight
          aria-hidden="true"
          className={cn(
            'h-3.5 w-3.5 transition-transform duration-100',
            place.expanded && 'rotate-90'
          )}
        />
      </button>
    ) : null}
  </span>
);

/** Props for IssueListRow. */
export interface IssueListRowProps {
  issue: OrderedIssueRead;
  /** Where the row sits when the section nests sub-issues. */
  tree?: IssueTreePlace | undefined;
  /** Hands the row element up, for a list that scrolls its highlight. */
  rowRef?: ((node: HTMLLIElement | null) => void) | undefined;
  /** The row's part in a drag, where the list drags. */
  drag?: RowDrag | undefined;
}

/**
 * What a row reads to take part in a drag. A memoized row renders again only
 * when `draggable` or `dimmed` changes, so the handlers it holds may be from an
 * earlier render: the list hands rows handlers that read its latest state when
 * they run, never state captured when the row last rendered.
 */
export interface RowDrag {
  draggable: boolean;
  /** True while the row rides along in a drag. */
  dimmed: boolean;
  onPointerDown: (event: React.PointerEvent) => void;
  onDragStart: (event: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (event: React.DragEvent) => void;
}

/** One dense row. */
export const IssueListRow: React.FC<IssueListRowProps> = ({
  issue,
  tree,
  rowRef,
  drag,
}) => {
  const env = useIssueViewEnv();
  const selectable = env.selectable !== false;
  const shows = (property: (typeof env.state.visible)[number]): boolean =>
    env.state.visible.includes(property);
  const { focused: isFocused, peeked: isPeeked } = useRowFocus(issue);
  const isSelected = env.selected.has(issue.id);
  const selecting = env.selected.size > 0;
  const archived = (issue.archived_at ?? null) !== null;
  const prefetch = useIssuePrefetch(issue.key, isFocused);
  const depth = tree?.depth ?? 0;
  const parent =
    depth === 0 ? (env.parentOf?.(issue) ?? parentRefOf(issue)) : undefined;
  const showsProgress = shows('sub_issues') && issue.progress.total > 0;
  const titleTip = useTruncationTooltip<HTMLAnchorElement>({ chain: prefetch });
  const coarse = useCoarsePointer();
  const own = React.useRef<HTMLLIElement | null>(null);
  const setRow = React.useCallback(
    (node: HTMLLIElement | null) => {
      own.current = node;
      rowRef?.(node);
    },
    [rowRef]
  );
  const editable =
    env.canEdit && (env.canEditIssue === undefined || env.canEditIssue(issue));
  const { openStatus, openQuickMenu, openMenu } = env;
  const swipe = useSwipeActions({
    enabled: coarse,
    right:
      editable && openStatus !== undefined
        ? {
            onCommit: () => {
              openStatus(issue);
            },
          }
        : undefined,
    left:
      openQuickMenu === undefined
        ? undefined
        : {
            onCommit: () => {
              const box = own.current?.getBoundingClientRect();
              openQuickMenu(issue, box?.right ?? 0, box?.bottom ?? 0);
            },
          },
    onLongPress:
      openMenu === undefined
        ? undefined
        : (x, y) => {
            openMenu(issue, x, y);
          },
  });
  const rowPointerDown = drag?.onPointerDown;

  return (
    <li
      ref={setRow}
      data-row-id={issue.id}
      aria-selected={isSelected}
      {...(tree === undefined ? {} : { 'aria-level': tree.depth + 1 })}
      {...swipe.handlers}
      {...(drag === undefined
        ? {}
        : {
            draggable: drag.draggable && !coarse,
            onDragStart: drag.onDragStart,
            onDragEnd: drag.onDragEnd,
            onDragOver: drag.onDragOver,
          })}
      onPointerDown={(event) => {
        rowPointerDown?.(event);
        swipe.handlers.onPointerDown(event);
      }}
      style={swipe.style}
      onMouseMove={() => {
        if (!isFocused) env.focus(issue.id);
      }}
      onContextMenu={(event) => {
        if (env.openMenu === undefined) return;
        event.preventDefault();
        env.openMenu(issue, event.clientX, event.clientY);
      }}
      className={cn(
        'group/row relative flex h-row items-center gap-2 border-b border-line/60 pr-3 pl-2 text-sm lg:pr-5 pointer-coarse:pl-4 max-sm:pl-3',
        isSelected
          ? 'bg-accent-soft'
          : isFocused || isPeeked
            ? 'bg-surface'
            : 'hover:bg-surface',
        isFocused &&
          'before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-accent',
        drag?.dimmed === true && 'opacity-40',
        coarse && 'touch-pan-y select-none [-webkit-touch-callout:none]',
        coarse &&
          !swipe.dragging &&
          'motion-safe:transition-transform motion-safe:duration-150 motion-safe:ease-out'
      )}
    >
      <span
        data-slot="select"
        className={cn(
          'flex shrink-0 items-center',
          !selecting &&
            (tree === undefined || tree.childCount === 0) &&
            'max-sm:hidden',
          !selectable && tree === undefined && 'hidden'
        )}
      >
        {selectable && (
          <span
            className={cn(
              'relative z-10 flex w-5 shrink-0 justify-center',
              !selecting && 'pointer-coarse:hidden'
            )}
          >
            <input
              type="checkbox"
              aria-label={`Select ${issue.key}`}
              checked={isSelected}
              onChange={(event) => {
                env.toggleSelected(
                  issue.id,
                  (event.nativeEvent as MouseEvent).shiftKey
                );
              }}
              onKeyDown={holdSpace}
              className={cn(
                'h-3.5 w-3.5 cursor-pointer accent-accent',
                !selecting &&
                  !isSelected &&
                  'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100'
              )}
            />
          </span>
        )}
        <TreeDisclosure issueKey={issue.key} place={tree} />
      </span>
      {shows('priority') && <PriorityCell issue={issue} />}
      {shows('id') && (
        <span
          data-slot="key"
          className="shrink-0 truncate font-mono text-xs text-text-faint max-sm:w-auto!"
          style={{ width: `calc(var(${KEY_WIDTH_VAR}, 8) * 1ch)` }}
        >
          {issue.key}
        </span>
      )}
      {shows('status') && <StatusCell issue={issue} />}
      {tree !== undefined && (
        <TreeGuides
          depth={depth}
          indent={INDENT}
          guide={tree.guide}
          opensBelow={tree.expanded && tree.childCount > 0}
        />
      )}
      {parent !== undefined && (
        <ParentPrefix
          slug={env.slug}
          parent={parent}
          className={tree === undefined ? undefined : 'ml-2'}
        />
      )}
      <Link
        ref={titleTip.ref}
        to={issuePath(env.slug, issue.key)}
        {...prefetch}
        {...titleTip.handlers}
        {...(drag?.draggable === true && !coarse ? { draggable: false } : {})}
        data-hover="parent"
        onClick={(event) => {
          if (event.shiftKey && selectable) {
            event.preventDefault();
            env.toggleSelected(issue.id, true);
            return;
          }
          env.onOpen?.();
        }}
        style={
          tree === undefined || tree.depth === 0
            ? undefined
            : { paddingLeft: tree.depth * INDENT }
        }
        className={cn(
          'min-w-0 truncate font-medium after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent',
          archived ? 'text-text-muted' : 'text-text'
        )}
      >
        {issue.title}
      </Link>
      {titleTip.tip}
      {showsProgress && <SubIssueProgressChip progress={issue.progress} />}
      <span aria-hidden="true" className="flex-1" />
      {archived && <ArchivedMarker />}
      <RelationMarkers issue={issue} />
      <span className="flex shrink-0 items-center gap-1.5">
        <MetaChips issue={issue} withProgress={false} />
      </span>
      {shows('assignee') && <AssigneeCell issue={issue} />}
    </li>
  );
};

/** Whether two connector guides draw the same. */
const sameGuide = (
  a: TreeGuide | undefined,
  b: TreeGuide | undefined
): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.last === b.last &&
    a.continues.length === b.continues.length &&
    a.continues.every((on, index) => on === b.continues[index]));

/**
 * Whether two tree places draw the same row. The toggle is left out: the list
 * hands every render a toggle that does the same thing for the same row.
 */
const sameTree = (
  a: IssueTreePlace | undefined,
  b: IssueTreePlace | undefined
): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.depth === b.depth &&
    a.childCount === b.childCount &&
    a.expanded === b.expanded &&
    sameGuide(a.guide, b.guide));

/** Whether two drag parts draw the same row, handlers aside (see RowDrag). */
const sameDrag = (a: RowDrag | undefined, b: RowDrag | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.draggable === b.draggable &&
    a.dimmed === b.dimmed);

/**
 * Whether a row would render the same for the new props. The issue is held
 * steady across polls by the view, so an unchanged issue is the same object.
 */
const sameRowProps = (
  prev: IssueListRowProps,
  next: IssueListRowProps
): boolean =>
  prev.issue === next.issue &&
  prev.rowRef === next.rowRef &&
  sameTree(prev.tree, next.tree) &&
  sameDrag(prev.drag, next.drag);

/**
 * A row that renders again only when its own issue, place or drag state
 * changes, so a poll that returns unchanged rows, or changes one, leaves the
 * other rows alone. Focus, peek and the view environment still reach it
 * through context.
 */
export const MemoIssueListRow = React.memo(IssueListRow, sameRowProps);

/** Props for ListRows. */
export interface ListRowsProps {
  sections: IssueSection[];
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  /** True to nest sub-issues under a parent in the same section. */
  nest?: boolean;
  /**
   * Folds or unfolds many keys at once, for Collapse all and Expand all. Left
   * out, each key that differs is toggled in turn.
   */
  onFoldMany?: ((keys: readonly string[], folded: boolean) => void) | undefined;
  /** Files an issue into a group, or undefined when it cannot. */
  createIn?:
    | ((group: IssueGroup, sub?: IssueGroup) => (() => void) | undefined)
    | undefined;
  /**
   * Changes the view state, used to switch to manual ordering on a reorder.
   * Left out, rows do not drag.
   */
  onStateChange?: ((state: ViewState) => void) | undefined;
}

/** The lane key of a group that has no sub-groups. */
const ONE_LANE = 'all';

/** What a press on a row lands on when it should not start a drag. */
const GRAB_CONTROLS =
  'button, input, select, textarea, [role="button"], [role="combobox"], [contenteditable="true"]';

/** The rows being dragged, in display order, the lead row and the cell it left. */
interface ListDragSource extends DropCell {
  ids: string[];
  lead: string;
}

/** A slot between two rows of one cell. */
interface ListSlot extends DropCell {
  index: number;
}

/** The map key of one cell's rows. */
const cellKey = (lane: string, column: string): string =>
  `${column}\u0000${lane}`;

/** The line drawn where dragged rows would land. */
const DropLine: React.FC = () => (
  <li
    aria-hidden="true"
    data-drop-indicator=""
    className="pointer-events-none relative z-30 h-0"
  >
    <span className="absolute inset-x-0 -top-px h-0.5 bg-accent" />
  </li>
);

/** The rows of a group, as a list, nested under their parents with `nest`. */
const Rows: React.FC<{
  rows: TreeRow<OrderedIssueRead>[];
  label: string;
  nest: boolean;
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  /** The index the drop line sits before, or null for none. */
  line: number | null;
  rowDrag?: ((issue: OrderedIssueRead, index: number) => RowDrag) | undefined;
  onDragOver?: ((event: React.DragEvent) => void) | undefined;
  onDrop?: ((event: React.DragEvent) => void) | undefined;
}> = ({
  rows,
  label,
  nest,
  collapsed,
  onToggle,
  line,
  rowDrag,
  onDragOver,
  onDrop,
}) => {
  const guides = nest ? treeGuides(rows) : [];
  return (
    <ul aria-label={label} onDragOver={onDragOver} onDrop={onDrop}>
      {rows.map((row, index) => (
        <React.Fragment key={row.issue.id}>
          {line === index && <DropLine />}
          <MemoIssueListRow
            issue={row.issue}
            drag={rowDrag?.(row.issue, index)}
            tree={
              nest
                ? {
                    depth: row.depth,
                    childCount: row.childCount,
                    expanded: !collapsed.has(foldedParentKey(row.issue.id)),
                    onToggle: () => {
                      onToggle(foldedParentKey(row.issue.id));
                    },
                    guide: guides[index],
                  }
                : undefined
            }
          />
        </React.Fragment>
      ))}
      {line !== null && line >= rows.length && <DropLine />}
    </ul>
  );
};

/**
 * Every shown section, its header and its rows, then the hidden groups row.
 * Groups hidden through the board's hidden column keys, or a sub-group hidden
 * inside its parent, drop out of the list.
 */
export const ListRows: React.FC<ListRowsProps> = ({
  sections,
  collapsed,
  onToggle,
  nest = false,
  onFoldMany,
  createIn,
  onStateChange,
}) => {
  const env = useIssueViewEnv();
  const [drag, setDrag] = React.useState<ListDragSource | null>(null);
  const [slot, setSlot] = React.useState<ListSlot | null>(null);
  const [headerTarget, setHeaderTarget] = React.useState<string | null>(null);
  const grabbed = React.useRef(false);
  const toggle = useLatestCallback(onToggle);
  const { shown, hidden } = splitHiddenSections(sections, collapsed);
  const drags = onStateChange !== undefined && env.canEdit;
  const foldMany = (keys: readonly string[], folded: boolean): void => {
    if (onFoldMany !== undefined) {
      onFoldMany(keys, folded);
      return;
    }
    for (const key of keys) {
      if (collapsed.has(key) !== folded) onToggle(key);
    }
  };
  const groupKeys = shown
    .filter(({ group }) => group.field !== 'none')
    .map(({ group }) => group.key);

  const columnField: GroupField = shown[0]?.group.field ?? env.state.groupBy;
  const laneField: GroupField = shown.some(({ subs }) => subs !== null)
    ? env.state.subGroupBy
    : 'none';
  const isFolded = (id: string): boolean => collapsed.has(foldedParentKey(id));
  const cells = new Map<string, TreeRow<OrderedIssueRead>[]>();
  const order: string[] = [];
  const cellOf = new Map<string, DropCell>();
  const byId = new Map<string, OrderedIssueRead>();
  for (const { group, subs } of shown) {
    const parts =
      subs === null
        ? [{ lane: ONE_LANE, issues: group.issues, folded: false }]
        : subs.map((sub) => ({
            lane: sub.key,
            issues: sub.issues,
            folded: collapsed.has(`${group.key}/${sub.key}`),
          }));
    for (const part of parts) {
      const rows = treeRows(part.issues, nest, isFolded);
      cells.set(cellKey(part.lane, group.key), rows);
      if (collapsed.has(group.key) || part.folded) continue;
      for (const { issue } of rows) {
        if (byId.has(issue.id)) continue;
        byId.set(issue.id, issue);
        order.push(issue.id);
        cellOf.set(issue.id, { lane: part.lane, column: group.key });
      }
    }
  }
  const rowsIn = (lane: string, column: string): TreeRow<OrderedIssueRead>[] =>
    cells.get(cellKey(lane, column)) ?? [];

  const takes = (
    source: DropCell,
    column: string,
    lane: string | null
  ): boolean =>
    (column === source.column || takesDrop(columnField, env)) &&
    (lane === null ||
      laneField === 'none' ||
      lane === source.lane ||
      takesDrop(laneField, env));

  const endDrag = (): void => {
    setDrag(null);
    setSlot(null);
    setHeaderTarget(null);
  };

  const drop = (to: DropLanding): void => {
    const source = drag;
    endDrag();
    if (source === null || onStateChange === undefined) return;
    if (!takes(source, to.column, to.lane)) return;
    landIssueDrop({
      env,
      onStateChange,
      movers: source.ids.flatMap((id) => {
        const issue = byId.get(id);
        return issue === undefined ? [] : [issue];
      }),
      lead: source.lead,
      source: { lane: source.lane, column: source.column },
      cellOf: (id) => cellOf.get(id),
      to,
      columnField,
      laneField,
      cellIssues: (lane, column) =>
        rowsIn(lane, column).map((row) => row.issue),
      columnLabel: (key) =>
        shown.find(({ group }) => group.key === key)?.group.label ?? key,
      laneLabel: (key) =>
        shown.flatMap(({ subs }) => subs ?? []).find((sub) => sub.key === key)
          ?.label ?? key,
    });
  };

  const refuse = (event: React.DragEvent): void => {
    event.dataTransfer.dropEffect = 'none';
    if (slot !== null) setSlot(null);
    if (headerTarget !== null) setHeaderTarget(null);
  };

  const liveRowDrag =
    (cell: DropCell) =>
    (issue: OrderedIssueRead, index: number): RowDrag => ({
      draggable: canDragIssue(env, issue),
      dimmed: drag?.ids.includes(issue.id) ?? false,
      onPointerDown: (event) => {
        grabbed.current =
          (event.target as HTMLElement).closest(GRAB_CONTROLS) !== null;
      },
      onDragStart: (event) => {
        if (grabbed.current) {
          grabbed.current = false;
          event.preventDefault();
          return;
        }
        const row = event.currentTarget as HTMLElement;
        const ids = draggedIds(issue.id, env.selected, order);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData(
          'text/plain',
          ids.map((id) => byId.get(id)?.key ?? id).join('\n')
        );
        setCountDragImage(
          event.dataTransfer,
          row,
          ids.length,
          `${String(ids.length)} issues`,
          { x: event.clientX, y: event.clientY }
        );
        setDrag({ ids, lead: issue.id, ...cell });
      },
      onDragEnd: endDrag,
      onDragOver: (event) => {
        if (drag === null) return;
        if (!takes(drag, cell.column, cell.lane)) {
          refuse(event);
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const box = (
          event.currentTarget as HTMLElement
        ).getBoundingClientRect();
        const at = event.clientY > box.top + box.height / 2 ? index + 1 : index;
        if (headerTarget !== null) setHeaderTarget(null);
        if (
          slot?.lane !== cell.lane ||
          slot.column !== cell.column ||
          slot.index !== at
        ) {
          setSlot({ ...cell, index: at });
        }
      },
    });

  const latest = React.useRef({ liveRowDrag, rowsIn });
  React.useLayoutEffect(() => {
    latest.current = { liveRowDrag, rowsIn };
  });

  /**
   * The drag part a row is handed: its looks from this render, its handlers
   * reading the list's latest state and the row's latest place in its cell
   * when they run, so a memoized row that has not rendered since still drags
   * and drops where it now sits.
   */
  const rowDrag =
    (cell: DropCell) =>
    (issue: OrderedIssueRead, index: number): RowDrag => {
      const now = (): RowDrag => {
        const live = latest.current;
        const rows = live.rowsIn(cell.lane, cell.column);
        const at = rows.findIndex((row) => row.issue.id === issue.id);
        const held = at < 0 ? undefined : rows[at];
        return live.liveRowDrag(cell)(
          held?.issue ?? issue,
          at < 0 ? index : at
        );
      };
      return {
        draggable: canDragIssue(env, issue),
        dimmed: drag?.ids.includes(issue.id) ?? false,
        onPointerDown: (event) => {
          now().onPointerDown(event);
        },
        onDragStart: (event) => {
          now().onDragStart(event);
        },
        onDragEnd: () => {
          now().onDragEnd();
        },
        onDragOver: (event) => {
          now().onDragOver(event);
        },
      };
    };

  const cellDrops = (cell: DropCell) => ({
    rowDrag: rowDrag(cell),
    onDragOver: (event: React.DragEvent): void => {
      if (drag === null) return;
      if ((event.target as HTMLElement).closest('[data-row-id]') !== null) {
        return;
      }
      if (!takes(drag, cell.column, cell.lane)) {
        refuse(event);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const end = rowsIn(cell.lane, cell.column).length;
      if (
        slot?.lane !== cell.lane ||
        slot.column !== cell.column ||
        slot.index !== end
      ) {
        setSlot({ ...cell, index: end });
      }
    },
    onDrop: (event: React.DragEvent): void => {
      event.preventDefault();
      drop(
        slot !== null && slot.lane === cell.lane && slot.column === cell.column
          ? slot
          : {
              ...cell,
              index: rowsIn(cell.lane, cell.column).length,
            }
      );
    },
  });

  const lineIn = (cell: DropCell): number | null => {
    if (
      drag === null ||
      slot === null ||
      slot.lane !== cell.lane ||
      slot.column !== cell.column
    ) {
      return null;
    }
    const from = rowsIn(cell.lane, cell.column).findIndex(
      (row) => row.issue.id === drag.lead
    );
    return drag.ids.length > 1 ||
      !isNoOpDrop(
        { lane: drag.lane, column: drag.column, from },
        { lane: slot.lane, column: slot.column, index: slot.index }
      )
      ? slot.index
      : null;
  };

  const headerDrop = (
    key: string,
    landing: () => DropLanding
  ): HeaderDrop | undefined =>
    drags
      ? {
          active: headerTarget === key,
          onDragOver: (event) => {
            if (drag === null) return;
            const to = landing();
            if (!takes(drag, to.column, to.lane)) {
              refuse(event);
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            if (slot !== null) setSlot(null);
            if (headerTarget !== key) setHeaderTarget(key);
          },
          onDragLeave: () => {
            if (headerTarget === key) setHeaderTarget(null);
          },
          onDrop: (event) => {
            event.preventDefault();
            drop(landing());
          },
        }
      : undefined;

  const endIndex = (lane: string, column: string): number | null =>
    env.state.ordering === 'manual' ? rowsIn(lane, column).length : null;

  return (
    <div
      style={
        {
          [KEY_WIDTH_VAR]: String(keyColumnCh(shown)),
        } as React.CSSProperties
      }
    >
      {shown.map(({ group, subs }) => {
        const grouped = group.field !== 'none';
        const folded = collapsed.has(group.key);
        const subKeys =
          subs === null ? [] : subs.map((sub) => `${group.key}/${sub.key}`);
        const cell = { lane: ONE_LANE, column: group.key };
        const drops = drags ? cellDrops(cell) : undefined;
        return (
          <section
            key={group.key}
            aria-label={grouped ? group.label : 'Issues'}
          >
            {grouped && (
              <GroupHeader
                group={group}
                collapsed={folded}
                onToggle={() => {
                  onToggle(group.key);
                }}
                onCreate={createIn?.(group)}
                onFoldAll={(fold) => {
                  foldMany(groupKeys, fold);
                }}
                onHide={() => {
                  onToggle(hiddenColumnKey(group.key));
                }}
                drop={headerDrop(group.key, () =>
                  subs === null
                    ? {
                        ...cell,
                        index: endIndex(ONE_LANE, group.key),
                      }
                    : { lane: null, column: group.key, index: null }
                )}
              />
            )}
            {!folded &&
              (subs === null ? (
                <Rows
                  rows={rowsIn(ONE_LANE, group.key)}
                  label={group.label}
                  nest={nest}
                  collapsed={collapsed}
                  onToggle={toggle}
                  line={lineIn(cell)}
                  rowDrag={drops?.rowDrag}
                  onDragOver={drops?.onDragOver}
                  onDrop={drops?.onDrop}
                />
              ) : (
                subs.map((sub) => {
                  const subKey = `${group.key}/${sub.key}`;
                  const subFolded = collapsed.has(subKey);
                  const subCell = { lane: sub.key, column: group.key };
                  const subDrops = drags ? cellDrops(subCell) : undefined;
                  return (
                    <div key={subKey}>
                      <GroupHeader
                        nested
                        group={sub}
                        collapsed={subFolded}
                        onToggle={() => {
                          onToggle(subKey);
                        }}
                        onCreate={createIn?.(group, sub)}
                        onFoldAll={(fold) => {
                          foldMany(subKeys, fold);
                        }}
                        onHide={() => {
                          onToggle(hiddenSubGroupKey(group.key, sub.key));
                        }}
                        drop={headerDrop(subKey, () => ({
                          ...subCell,
                          index: endIndex(sub.key, group.key),
                        }))}
                      />
                      {!subFolded && (
                        <Rows
                          rows={rowsIn(sub.key, group.key)}
                          label={`${group.label}, ${sub.label}`}
                          nest={nest}
                          collapsed={collapsed}
                          onToggle={toggle}
                          line={lineIn(subCell)}
                          rowDrag={subDrops?.rowDrag}
                          onDragOver={subDrops?.onDragOver}
                          onDrop={subDrops?.onDrop}
                        />
                      )}
                    </div>
                  );
                })
              ))}
          </section>
        );
      })}
      <HiddenGroupsRow hidden={hidden} onShow={onToggle} />
    </div>
  );
};

/**
 * The list held still while the view re-renders for something the rows do not
 * read, such as the keyboard focus or the peek, which each row takes from the
 * view's focus store instead.
 */
const MemoListRows = React.memo(ListRows);

export default MemoListRows;
