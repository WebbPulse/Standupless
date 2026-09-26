/**
 * The list layout: sticky group headers with counts that fold their rows
 * away, optional sub-group headers inside them, and one dense row per issue.
 * A row is a stretched link to the issue with the pickers lifted above it,
 * so a click on the row opens the issue and a click on a glyph edits it.
 */

import React from 'react';
import { LuChevronRight, LuPlus } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import type { OrderedIssueRead } from '../../../api/issues';
import { cn } from '../../../lib/cn';
import type { IssueGroup } from '../../../lib/issueView';
import { issuePath } from '../../../lib/paths';
import Avatar from '../../ui/avatar';
import { IconButton } from '../../ui/button';
import { PriorityGlyph, StatusGlyph } from '../../ui/glyphs';
import ProgressRing from '../../planning/ProgressRing';
import {
  AssigneeCell,
  MetaChips,
  PriorityCell,
  StatusCell,
} from './IssueProperties';
import { useIssueViewEnv } from './IssueViewContext';

/** One group with its sub-groups, when the view is sub-grouped. */
export interface IssueSection {
  group: IssueGroup;
  subs: IssueGroup[] | null;
}

/** The glyph a group header leads with. */
export const GroupGlyph: React.FC<{ group: IssueGroup }> = ({ group }) => {
  if (group.field === 'status') {
    return <StatusGlyph category={group.category} />;
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
  if (group.field === 'milestone') {
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

/** A group's header: fold toggle, glyph, name, count and a create button. */
export const GroupHeader: React.FC<GroupHeaderProps> = ({
  group,
  collapsed,
  onToggle,
  onCreate,
  nested = false,
}) => (
  <div
    className={cn(
      'group/header flex h-9 items-center gap-2 border-b border-line pr-3 pl-2 lg:pr-5',
      nested ? 'bg-bg pl-7 text-text-muted' : 'sticky top-0 z-20 bg-surface'
    )}
  >
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
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
      <span className="truncate font-medium text-text">{group.label}</span>
      <span className="text-xs text-text-faint tabular-nums">
        {group.issues.length}
      </span>
    </button>
    {onCreate !== undefined && (
      <IconButton
        label={`New issue in ${group.label}`}
        size="sm"
        variant="ghost"
        className="opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100"
        onClick={onCreate}
      >
        <LuPlus className="h-3.5 w-3.5" />
      </IconButton>
    )}
  </div>
);

/** Props for IssueListRow. */
export interface IssueListRowProps {
  issue: OrderedIssueRead;
}

/** One dense row. */
export const IssueListRow: React.FC<IssueListRowProps> = ({ issue }) => {
  const env = useIssueViewEnv();
  const shows = (property: (typeof env.state.visible)[number]): boolean =>
    env.state.visible.includes(property);
  const isFocused = env.focusedId === issue.id;
  const isSelected = env.selected.has(issue.id);
  const isPeeked = env.peekedKey === issue.key;
  const selecting = env.selected.size > 0;

  return (
    <li
      data-row-id={issue.id}
      aria-selected={isSelected}
      onMouseMove={() => {
        if (!isFocused) env.focus(issue.id);
      }}
      className={cn(
        'group/row relative flex h-row items-center gap-2 border-b border-line/60 pr-3 pl-2 text-sm lg:pr-5',
        isSelected
          ? 'bg-accent-soft'
          : isFocused || isPeeked
            ? 'bg-surface'
            : '',
        isFocused &&
          'before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-accent'
      )}
    >
      <span className="relative z-10 flex w-5 shrink-0 justify-center">
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
          className={cn(
            'h-3.5 w-3.5 cursor-pointer accent-accent',
            !selecting &&
              !isSelected &&
              'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100'
          )}
        />
      </span>
      {shows('priority') && <PriorityCell issue={issue} />}
      {shows('id') && (
        <span className="w-14 shrink-0 truncate font-mono text-xs text-text-faint sm:w-16">
          {issue.key}
        </span>
      )}
      {shows('status') && <StatusCell issue={issue} />}
      <Link
        to={issuePath(env.slug, issue.key)}
        onClick={(event) => {
          if (event.shiftKey) {
            event.preventDefault();
            env.toggleSelected(issue.id, true);
          }
        }}
        className="min-w-0 flex-1 truncate font-medium text-text after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
      >
        {issue.title}
      </Link>
      <span className="flex shrink-0 items-center gap-1.5">
        <MetaChips issue={issue} />
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
  /** Files an issue into a group, or undefined when it cannot. */
  createIn?:
    | ((group: IssueGroup, sub?: IssueGroup) => (() => void) | undefined)
    | undefined;
}

/** The rows of a group, as a list. */
const Rows: React.FC<{ issues: OrderedIssueRead[]; label: string }> = ({
  issues,
  label,
}) => (
  <ul aria-label={label}>
    {issues.map((issue) => (
      <IssueListRow key={issue.id} issue={issue} />
    ))}
  </ul>
);

/** Every section, its header and its rows. */
export const ListRows: React.FC<ListRowsProps> = ({
  sections,
  collapsed,
  onToggle,
  createIn,
}) => (
  <div>
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
              <Rows issues={group.issues} label={group.label} />
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
