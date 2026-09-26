/**
 * The bar that rises while issues are selected: how many, the properties
 * that can be set on all of them at once, and a way out. Each button opens
 * the same property list the keyboard does, so a bulk change and a single
 * change are the same gesture.
 */

import React from 'react';
import {
  LuCircleDashed,
  LuSignal,
  LuTag,
  LuTriangle,
  LuUserRound,
  LuX,
} from 'react-icons/lu';
import { Kbd } from '../../ui/badge';
import { IconButton } from '../../ui/button';
import { PROPERTY_KEYS, type CommandProperty } from './propertyKeys';

/** Props for BulkBar. */
export interface BulkBarProps {
  count: number;
  /** Whether estimates can be set, false when the teams have them off. */
  estimates: boolean;
  onProperty: (property: CommandProperty) => void;
  onClear: () => void;
}

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
];

/** The bar. Renders nothing with no selection. */
export const BulkBar: React.FC<BulkBarProps> = ({
  count,
  estimates,
  onProperty,
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
          (action) => estimates || action.property !== 'estimate'
        ).map((action) => (
          <button
            key={action.property}
            type="button"
            onClick={() => {
              onProperty(action.property);
            }}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-text-muted hover:bg-raised hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
          >
            {action.icon}
            {action.label}
            <Kbd className="hidden sm:inline-flex">
              {PROPERTY_KEYS[action.property]}
            </Kbd>
          </button>
        ))}
      </div>
    </div>
  );
};

export default BulkBar;
