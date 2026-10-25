/**
 * The Display button of the initiatives list: whether rows group by status,
 * lead team, owner, health or target month, what order initiatives run in
 * inside each group, the manual order among them, whether completed
 * initiatives show, and which properties show beside the name. It reads like the projects list's Display
 * menu so every planning list is arranged the same way, and it writes nothing
 * itself.
 */

import React from 'react';
import { LuSlidersHorizontal } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import {
  INITIATIVE_COLUMNS,
  INITIATIVE_COLUMN_LABELS,
  INITIATIVE_GROUPINGS,
  INITIATIVE_GROUPING_LABELS,
  INITIATIVE_ORDERINGS,
  INITIATIVE_ORDERING_LABELS,
  type CompletedChoice,
  type InitiativeColumn,
  type InitiativeGrouping,
  type InitiativeOrdering,
} from '../../lib/initiativeList';
import Button from '../ui/button';
import { Popover } from '../ui/popover';
import { ChoiceRow, SwitchRow } from './ProjectsDisplayMenu';

/** Props for InitiativesDisplayMenu: the current choices and their setters. */
export interface InitiativesDisplayMenuProps {
  grouping: InitiativeGrouping;
  onGroupingChange: (grouping: InitiativeGrouping) => void;
  ordering: InitiativeOrdering;
  onOrderingChange: (ordering: InitiativeOrdering) => void;
  completed: CompletedChoice;
  onCompletedChange: (completed: CompletedChoice) => void;
  columns: readonly InitiativeColumn[];
  onColumnsChange: (columns: InitiativeColumn[]) => void;
  /** Puts every choice back to the default, or undefined when they match. */
  onReset?: (() => void) | undefined;
}

/** The Display button and its grouping, ordering, completed and property panel. */
export const InitiativesDisplayMenu: React.FC<InitiativesDisplayMenuProps> = ({
  grouping,
  onGroupingChange,
  ordering,
  onOrderingChange,
  completed,
  onCompletedChange,
  columns,
  onColumnsChange,
  onReset,
}) => (
  <Popover
    label="Display options"
    align="end"
    contentClassName="w-72 p-0"
    trigger={(props) => (
      <Button {...props} size="sm" variant="secondary" className="gap-1.5">
        <LuSlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
        Display
      </Button>
    )}
  >
    <div className="flex flex-col gap-3 p-3">
      <ChoiceRow
        id="initiatives-grouping"
        label="Grouping"
        value={grouping}
        choices={INITIATIVE_GROUPINGS}
        labels={INITIATIVE_GROUPING_LABELS}
        onChange={onGroupingChange}
      />
      <ChoiceRow
        id="initiatives-order"
        label="Ordering"
        value={ordering}
        choices={INITIATIVE_ORDERINGS}
        labels={INITIATIVE_ORDERING_LABELS}
        onChange={onOrderingChange}
      />
      <SwitchRow
        id="initiatives-completed"
        label="Show completed initiatives"
        checked={completed === 'show'}
        onChange={(checked) => {
          onCompletedChange(checked ? 'show' : 'hide');
        }}
      />
    </div>
    <div className="border-t border-line p-3">
      <p className="mb-2 text-xs text-text-muted">Display properties</p>
      <div className="flex flex-wrap gap-1.5">
        {INITIATIVE_COLUMNS.map((column) => {
          const on = columns.includes(column);
          return (
            <button
              key={column}
              type="button"
              aria-pressed={on}
              onClick={() => {
                onColumnsChange(
                  INITIATIVE_COLUMNS.filter((item) =>
                    item === column ? !on : columns.includes(item)
                  )
                );
              }}
              className={cn(
                'h-6 rounded-full border px-2 text-2xs focus-visible:outline-2 focus-visible:outline-accent',
                on
                  ? 'border-line-strong bg-raised text-text'
                  : 'border-line text-text-faint hover:text-text-muted'
              )}
            >
              {INITIATIVE_COLUMN_LABELS[column]}
            </button>
          );
        })}
      </div>
    </div>
    {onReset !== undefined && (
      <div className="flex items-center justify-end border-t border-line px-3 py-2">
        <Button variant="ghost" size="sm" onClick={onReset}>
          Reset
        </Button>
      </div>
    )}
  </Popover>
);

export default InitiativesDisplayMenu;
