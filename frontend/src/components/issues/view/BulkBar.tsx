/**
 * The bar that rises while issues are selected: how many, the properties
 * that can be set on all of them at once, and a way out. Each button opens
 * the same property list the keyboard does, so a bulk change and a single
 * change are the same gesture. Archive and delete close the bar's actions,
 * each with its key.
 */

import React from 'react';
import {
  LuArchive,
  LuArchiveRestore,
  LuCircleDashed,
  LuMilestone,
  LuSignal,
  LuTag,
  LuTrash2,
  LuTriangle,
  LuUserRound,
  LuX,
} from 'react-icons/lu';
import { Kbd } from '../../ui/badge';
import { displayKeys } from '../../../hooks/useShortcuts';
import { IconButton } from '../../ui/button';
import {
  ARCHIVE_ISSUE_KEYS,
  DELETE_ISSUE_KEYS,
  PROPERTY_KEYS,
  type CommandProperty,
} from './propertyKeys';

/** Props for BulkBar. */
export interface BulkBarProps {
  count: number;
  /** Whether estimates can be set, false when the teams have them off. */
  estimates: boolean;
  /** Whether a milestone can be set, true only inside one project's list. */
  milestones?: boolean;
  /** True when every selected issue is archived, so archive restores. */
  archived?: boolean;
  onProperty: (property: CommandProperty) => void;
  /** Archives or restores the selection, absent when the caller cannot. */
  onArchive?: (() => void) | undefined;
  /** Deletes the selection after a confirmation, absent when it cannot. */
  onDelete?: (() => void) | undefined;
  onClear: () => void;
}

const ACTION_BASE =
  'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-text-muted hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent';

const ACTION_CLASS = `${ACTION_BASE} hover:text-text`;

const DANGER_ACTION_CLASS = `${ACTION_BASE} hover:text-danger`;

/** The key hint at the end of a bar button. */
const BarKeys: React.FC<{ keys: string }> = ({ keys }) => (
  <Kbd className="hidden sm:inline-flex">{displayKeys(keys).join(' ')}</Kbd>
);

const ACTIONS: {
  property: CommandProperty;
  label: string;
  icon: React.ReactNode;
}[] = [
  {
    property: 'status',
    label: 'Status',
    icon: <LuCircleDashed className="h-3.5 w-3.5" />,
  },
  {
    property: 'priority',
    label: 'Priority',
    icon: <LuSignal className="h-3.5 w-3.5" />,
  },
  {
    property: 'assignee',
    label: 'Assignee',
    icon: <LuUserRound className="h-3.5 w-3.5" />,
  },
  {
    property: 'labels',
    label: 'Labels',
    icon: <LuTag className="h-3.5 w-3.5" />,
  },
  {
    property: 'estimate',
    label: 'Estimate',
    icon: <LuTriangle className="h-3.5 w-3.5" />,
  },
  {
    property: 'milestone',
    label: 'Milestone',
    icon: <LuMilestone className="h-3.5 w-3.5" />,
  },
];

/** The bar. Renders nothing with no selection. */
export const BulkBar: React.FC<BulkBarProps> = ({
  count,
  estimates,
  milestones = false,
  archived = false,
  onProperty,
  onArchive,
  onDelete,
  onClear,
}) => {
  if (count === 0) return null;
  return (
    <div
      role="toolbar"
      aria-label="Selected issues"
      className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4"
    >
      <div className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-lg border border-line-strong bg-overlay p-1 shadow-overlay">
        <span className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-dashed border-line-strong px-2 text-xs text-text tabular-nums">
          {count} selected
          <IconButton
            label="Clear selection"
            size="sm"
            variant="ghost"
            className="-mr-1 h-5 w-5"
            onClick={onClear}
          >
            <LuX className="h-3 w-3" />
          </IconButton>
        </span>
        {ACTIONS.filter(
          (action) =>
            (estimates || action.property !== 'estimate') &&
            (milestones || action.property !== 'milestone')
        ).map((action) => (
          <button
            key={action.property}
            type="button"
            onClick={() => {
              onProperty(action.property);
            }}
            className={ACTION_CLASS}
          >
            {action.icon}
            {action.label}
            <BarKeys keys={PROPERTY_KEYS[action.property]} />
          </button>
        ))}
        {(onArchive !== undefined || onDelete !== undefined) && (
          <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line" />
        )}
        {onArchive !== undefined && (
          <button type="button" onClick={onArchive} className={ACTION_CLASS}>
            {archived ? (
              <LuArchiveRestore className="h-3.5 w-3.5" />
            ) : (
              <LuArchive className="h-3.5 w-3.5" />
            )}
            {archived ? 'Restore' : 'Archive'}
            <BarKeys keys={ARCHIVE_ISSUE_KEYS} />
          </button>
        )}
        {onDelete !== undefined && (
          <button
            type="button"
            onClick={onDelete}
            className={DANGER_ACTION_CLASS}
          >
            <LuTrash2 className="h-3.5 w-3.5" />
            Delete
            <BarKeys keys={DELETE_ISSUE_KEYS} />
          </button>
        )}
      </div>
    </div>
  );
};

export default BulkBar;
