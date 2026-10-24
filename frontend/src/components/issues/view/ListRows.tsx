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
 */

import React from 'react';
import { LuArchive, LuChevronRight, LuPlus } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import type { OrderedIssueRead } from '../../../api/issues';
import { cn } from '../../../lib/cn';
import {
  foldedParentKey,
  parentRefOf,
  treeGuides,
  treeRows,
  type TreeGuide,
} from '../../../lib/issueTree';
import type { IssueGroup } from '../../../lib/issueView';
import { issuePath } from '../../../lib/paths';
import Avatar from '../../ui/avatar';
import { IconButton } from '../../ui/button';
import { PriorityGlyph } from '../../ui/glyphs';
import { StatusIcon } from '../../ui/StatusIcon';
import { TruncatedText, useTruncationTooltip } from '../../ui/truncated-text';
import ProgressRing from '../../planning/ProgressRing';
import { RelationMarkers } from '../BlockedMarker';
import {
  AssigneeCell,
  MetaChips,
  PriorityCell,
  StatusCell,
} from './IssueProperties';
import { useIssueViewEnv } from './IssueViewContext';
import { ParentPrefix, SubIssueProgressChip, TreeGuides } from './SubIssueCues';
import { useIssuePrefetch } from '../../../hooks/useIssuePrefetch';

/** One group with its sub-groups, when the view is sub-grouped. */
export interface IssueSection {
  group: IssueGroup;
  subs: IssueGroup[] | null;
}

/** The glyph a group header leads with. */
export const GroupGlyph: React.FC<{ group: IssueGroup }> = ({ group }) => {
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
  if (group.field === 'label') {
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

/**
 * A group's header: select-all, fold toggle, glyph, name, count and a create
 * button.
 */
export const GroupHeader: React.FC<GroupHeaderProps> = ({
  group,
  collapsed,
  onToggle,
  onCreate,
  nested = false,
}) => (
  <div
    className={cn(
      'group/header flex h-9 items-center pointer-coarse:h-11 gap-2 border-b border-line pr-3 pl-2 transition-colors duration-100 hover:bg-raised has-[button[aria-expanded]:active]:bg-line lg:pr-5',
      nested ? 'bg-bg pl-7 text-text-muted' : 'sticky top-0 z-20 bg-surface'
    )}
  >
    <SectionCheckbox group={group} />
    <button
      type="button"
      onClick={onToggle}
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
      <span className="text-xs text-text-faint tabular-nums">
        {group.issues.length}
      </span>
    </button>
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
  </div>
);

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
        className="relative z-10 flex h-5 w-5 items-center justify-center rounded-sm text-text-muted transition-colors duration-100 hover:bg-line hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
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
}

/** One dense row. */
export const IssueListRow: React.FC<IssueListRowProps> = ({ issue, tree }) => {
  const env = useIssueViewEnv();
  const shows = (property: (typeof env.state.visible)[number]): boolean =>
    env.state.visible.includes(property);
  const isFocused = env.focusedId === issue.id;
  const isSelected = env.selected.has(issue.id);
  const isPeeked = env.peekedKey === issue.key;
  const selecting = env.selected.size > 0;
  const archived = (issue.archived_at ?? null) !== null;
  const prefetch = useIssuePrefetch(issue.key, isFocused);
  const depth = tree?.depth ?? 0;
  const parent =
    depth === 0 ? (env.parentOf?.(issue) ?? parentRefOf(issue)) : undefined;
  const showsProgress = shows('sub_issues') && issue.progress.total > 0;
  const titleTip = useTruncationTooltip<HTMLAnchorElement>({ chain: prefetch });

  return (
    <li
      data-row-id={issue.id}
      aria-selected={isSelected}
      {...(tree === undefined ? {} : { 'aria-level': tree.depth + 1 })}
      onMouseMove={() => {
        if (!isFocused) env.focus(issue.id);
      }}
      onContextMenu={(event) => {
        if (env.openMenu === undefined) return;
        event.preventDefault();
        env.openMenu(issue, event.clientX, event.clientY);
      }}
      className={cn(
        'group/row relative flex h-row items-center gap-2 border-b border-line/60 pr-3 pl-2 text-sm lg:pr-5 pointer-coarse:pl-4',
        isSelected
          ? 'bg-accent-soft'
          : isFocused || isPeeked
            ? 'bg-surface'
            : 'hover:bg-surface',
        isFocused &&
          'before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-accent'
      )}
    >
      <span data-slot="select" className="flex shrink-0 items-center">
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
        <TreeDisclosure issueKey={issue.key} place={tree} />
      </span>
      {shows('priority') && <PriorityCell issue={issue} />}
      {shows('id') && (
        <span
          data-slot="key"
          className="shrink-0 truncate font-mono text-xs text-text-faint"
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
        data-hover="parent"
        onClick={(event) => {
          if (event.shiftKey) {
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

/** Props for ListRows. */
export interface ListRowsProps {
  sections: IssueSection[];
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  /** True to nest sub-issues under a parent in the same section. */
  nest?: boolean;
  /** Files an issue into a group, or undefined when it cannot. */
  createIn?:
    | ((group: IssueGroup, sub?: IssueGroup) => (() => void) | undefined)
    | undefined;
}

/** The rows of a group, as a list, nested under their parents with `nest`. */
const Rows: React.FC<{
  issues: OrderedIssueRead[];
  label: string;
  nest: boolean;
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
}> = ({ issues, label, nest, collapsed, onToggle }) => {
  const rows = treeRows(issues, nest, (id) =>
    collapsed.has(foldedParentKey(id))
  );
  const guides = nest ? treeGuides(rows) : [];
  return (
    <ul aria-label={label}>
      {rows.map((row, index) => (
        <IssueListRow
          key={row.issue.id}
          issue={row.issue}
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
      ))}
    </ul>
  );
};

/** Every section, its header and its rows. */
export const ListRows: React.FC<ListRowsProps> = ({
  sections,
  collapsed,
  onToggle,
  nest = false,
  createIn,
}) => (
  <div
    style={
      { [KEY_WIDTH_VAR]: String(keyColumnCh(sections)) } as React.CSSProperties
    }
  >
    {sections.map(({ group, subs }) => {
      const grouped = group.field !== 'none';
      const folded = collapsed.has(group.key);
      return (
        <section key={group.key} aria-label={grouped ? group.label : 'Issues'}>
          {grouped && (
            <GroupHeader
              group={group}
              collapsed={folded}
              onToggle={() => {
                onToggle(group.key);
              }}
              onCreate={createIn?.(group)}
            />
          )}
          {!folded &&
            (subs === null ? (
              <Rows
                issues={group.issues}
                label={group.label}
                nest={nest}
                collapsed={collapsed}
                onToggle={onToggle}
              />
            ) : (
              subs.map((sub) => {
                const subKey = `${group.key}/${sub.key}`;
                const subFolded = collapsed.has(subKey);
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
                    />
                    {!subFolded && (
                      <Rows
                        issues={sub.issues}
                        label={`${group.label}, ${sub.label}`}
                        nest={nest}
                        collapsed={collapsed}
                        onToggle={onToggle}
                      />
                    )}
                  </div>
                );
              })
            ))}
        </section>
      );
    })}
  </div>
);

export default ListRows;
