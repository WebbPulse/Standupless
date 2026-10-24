/**
 * The list the `#` reference picker opens under the caret: issues with their
 * status glyph and key, projects with their own mark, and documents with the
 * project or initiative they belong to. It only draws; the editor owns the
 * query, the highlight and what a pick writes.
 */

import React from 'react';
import { LuFileText } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { referenceLabel, type ReferenceItem } from '../../lib/references';
import type { StatusLike } from '../../lib/statusAppearance';
import type { ProjectIconName } from '../../types/Api';
import { ProjectMark } from '../ui/ReferenceChip';
import { StatusIcon } from '../ui/StatusIcon';

/** Props for ReferenceMenu. */
export interface ReferenceMenuProps {
  items: ReferenceItem[];
  highlight: number;
  /** True while a search for the typed query is in flight. */
  loading: boolean;
  /** False while the query is too short to search, which shows a hint. */
  searchable: boolean;
  top: number;
  left: number;
  onChoose: (item: ReferenceItem) => void;
  onHighlight: (index: number) => void;
}

/** The status an issue hit carries, in the shape the glyph resolves. */
const statusOf = (
  item: Extract<ReferenceItem, { kind: 'issue' }>
): StatusLike | undefined =>
  item.statusCategory === null
    ? undefined
    : {
        category: item.statusCategory,
        color: item.statusColor,
        icon: item.statusIcon,
      };

/** The leading glyph of one row. */
const ItemGlyph: React.FC<{ item: ReferenceItem }> = ({ item }) => {
  switch (item.kind) {
    case 'issue':
      return (
        <StatusIcon
          status={statusOf(item)}
          className="h-3.5 w-3.5 shrink-0"
          {...(item.statusName === null ? {} : { name: item.statusName })}
        />
      );
    case 'project':
      return (
        <ProjectMark
          icon={item.icon as ProjectIconName | null}
          color={item.color}
        />
      );
    case 'document':
      return (
        <LuFileText
          aria-hidden="true"
          className="h-3 w-3 shrink-0 text-text-muted"
        />
      );
  }
};

/** The text a row carries after its glyph. */
const ItemText: React.FC<{ item: ReferenceItem }> = ({ item }) => {
  switch (item.kind) {
    case 'issue':
      return (
        <>
          <span className="w-14 shrink-0 truncate font-mono text-xs text-text-faint">
            {item.key}
          </span>
          <span className="min-w-0 flex-1 truncate text-text">
            {item.title}
          </span>
        </>
      );
    case 'project':
      return (
        <>
          <span className="min-w-0 flex-1 truncate text-text">
            {referenceLabel(item)}
          </span>
          <span className="shrink-0 text-xs text-text-faint">Project</span>
        </>
      );
    case 'document':
      return (
        <>
          <span className="min-w-0 flex-1 truncate text-text">
            {referenceLabel(item)}
          </span>
          <span className="max-w-24 shrink-0 truncate text-xs text-text-faint">
            {item.parentName}
          </span>
        </>
      );
  }
};

/** The hint a row shows when there is nothing to pick. */
const emptyHint = (searchable: boolean, loading: boolean): string => {
  if (!searchable) return 'Type to search issues, projects and documents';
  return loading ? 'Searching' : 'No matches';
};

/** The picker's listbox, anchored at the caret. */
export const ReferenceMenu: React.FC<ReferenceMenuProps> = ({
  items,
  highlight,
  loading,
  searchable,
  top,
  left,
  onChoose,
  onHighlight,
}) => (
  <ul
    role="listbox"
    aria-label="Reference an issue, project or document"
    aria-busy={loading}
    className="absolute z-20 w-80 overflow-hidden rounded-md border border-line bg-overlay py-1 shadow-overlay"
    style={{ top, left }}
  >
    {items.length === 0 ? (
      <li className="px-2 py-1.5 text-sm text-text-faint">
        {emptyHint(searchable, loading)}
      </li>
    ) : (
      items.map((item, index) => (
        <li
          key={`${item.kind}-${item.id}`}
          role="option"
          aria-selected={index === highlight}
          data-kind={item.kind}
          className={cn(
            'flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm hover:bg-raised hover:text-text active:bg-line',
            index === highlight ? 'bg-raised text-text' : 'text-text-muted'
          )}
          onMouseDown={(event) => {
            event.preventDefault();
            onChoose(item);
          }}
          onMouseEnter={() => {
            onHighlight(index);
          }}
        >
          <ItemGlyph item={item} />
          <ItemText item={item} />
        </li>
      ))
    )}
  </ul>
);

export default ReferenceMenu;
