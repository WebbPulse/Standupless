/**
 * The Display button of the projects list and the roadmap: the layout, how
 * rows group, what order they run in, which completed projects stay and
 * which list columns show. It
 * reads like the issue list's Display menu so every list is arranged the same
 * way, and it writes nothing itself. A page leaves out the choices it does
 * not offer.
 */

import React from 'react';
import {
  LuCalendarRange,
  LuList,
  LuSlidersHorizontal,
  LuSquareKanban,
} from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { cn } from '../../lib/cn';
import {
  CLOSED_WINDOWS,
  CLOSED_WINDOW_LABELS,
  CUSTOMER_PROJECT_ORDERINGS,
  PROJECT_GROUPINGS,
  PROJECT_GROUPING_LABELS,
  PROJECT_LAYOUTS,
  PROJECT_LAYOUT_LABELS,
  PROJECT_ORDERINGS,
  PROJECT_ORDERING_LABELS,
  PROJECT_COLUMNS,
  PROJECT_COLUMN_LABELS,
  parseDisplayField,
  type ClosedWindow,
  type ProjectColumn,
  type ProjectGrouping,
  type ProjectLayout,
  type ProjectOrdering,
} from '../../lib/projectList';
import Button from '../ui/button';
import { Popover } from '../ui/popover';
import { Select } from '../ui/select';

/** The glyph each layout is offered with. */
const LAYOUT_ICONS: Record<ProjectLayout, IconType> = {
  list: LuList,
  board: LuSquareKanban,
  timeline: LuCalendarRange,
};

/** Props for ProjectsDisplayMenu: the current choices and their setters. */
export interface ProjectsDisplayMenuProps {
  grouping: ProjectGrouping;
  onGroupingChange: (grouping: ProjectGrouping) => void;
  /** The layout, left out where the page has only one. */
  layout?: ProjectLayout;
  onLayoutChange?: (layout: ProjectLayout) => void;
  /** The ordering, left out where rows keep a fixed order. */
  ordering?: ProjectOrdering;
  onOrderingChange?: (ordering: ProjectOrdering) => void;
  /** True where the reader may see customers, so the customer requests ordering is offered. */
  customerOrdering?: boolean;
  /** Which completed projects stay, left out where every project shows. */
  closed?: ClosedWindow;
  onClosedChange?: (closed: ClosedWindow) => void;
  /** The shown list columns, left out where the layout draws no columns. */
  columns?: readonly ProjectColumn[];
  onColumnsChange?: (columns: ProjectColumn[]) => void;
  /** Puts every choice back to the page's own, or undefined when they match. */
  onReset?: (() => void) | undefined;
}

/** Props for one labelled select row of the panel. */
interface ChoiceRowProps<T extends string> {
  id: string;
  label: string;
  value: T;
  choices: readonly T[];
  labels: Record<T, string>;
  onChange: (value: T) => void;
}

/** One labelled select row of the Display panel. */
const ChoiceRow = <T extends string>({
  id,
  label,
  value,
  choices,
  labels,
  onChange,
}: ChoiceRowProps<T>): React.ReactElement => (
  <div className="flex items-center justify-between gap-4">
    <label htmlFor={id} className="text-xs text-text-muted">
      {label}
    </label>
    <Select
      id={id}
      className="h-7 w-36 py-0 text-xs"
      value={value}
      onChange={(event) => {
        const next = choices.find((choice) => choice === event.target.value);
        if (next !== undefined) onChange(next);
      }}
    >
      {choices.map((choice) => (
        <option key={choice} value={choice}>
          {labels[choice]}
        </option>
      ))}
    </Select>
  </div>
);

/** The Display button and its layout, grouping, ordering, window and column panel. */
export const ProjectsDisplayMenu: React.FC<ProjectsDisplayMenuProps> = ({
  grouping,
  layout,
  ordering,
  closed,
  onGroupingChange,
  onLayoutChange,
  onOrderingChange,
  onClosedChange,
  columns,
  onColumnsChange,
  onReset,
  customerOrdering = false,
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
    {layout !== undefined && onLayoutChange !== undefined && (
      <div
        role="radiogroup"
        aria-label="Layout"
        className="grid grid-cols-3 gap-1 border-b border-line p-2"
      >
        {PROJECT_LAYOUTS.map((value) => {
          const Icon = LAYOUT_ICONS[value];
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={layout === value}
              onClick={() => {
                const next = parseDisplayField('layout', value);
                if (next !== undefined) onLayoutChange(next);
              }}
              className={cn(
                'flex h-12 flex-col items-center justify-center gap-1 rounded-sm border text-xs transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
                layout === value
                  ? 'border-line-strong bg-raised text-text'
                  : 'border-transparent text-text-muted hover:bg-surface hover:text-text'
              )}
            >
              <Icon aria-hidden="true" className="h-4 w-4" />
              {PROJECT_LAYOUT_LABELS[value]}
            </button>
          );
        })}
      </div>
    )}
    <div className="flex flex-col gap-3 p-3">
      <ChoiceRow
        id="projects-group"
        label={layout === 'board' ? 'Columns' : 'Grouping'}
        value={grouping}
        choices={PROJECT_GROUPINGS}
        labels={PROJECT_GROUPING_LABELS}
        onChange={onGroupingChange}
      />
      {ordering !== undefined && onOrderingChange !== undefined && (
        <ChoiceRow
          id="projects-order"
          label="Ordering"
          value={ordering}
          choices={PROJECT_ORDERINGS.filter(
            (choice) =>
              customerOrdering ||
              choice === ordering ||
              !CUSTOMER_PROJECT_ORDERINGS.has(choice)
          )}
          labels={PROJECT_ORDERING_LABELS}
          onChange={onOrderingChange}
        />
      )}
      {closed !== undefined && onClosedChange !== undefined && (
        <ChoiceRow
          id="projects-closed"
          label="Completed projects"
          value={closed}
          choices={CLOSED_WINDOWS}
          labels={CLOSED_WINDOW_LABELS}
          onChange={onClosedChange}
        />
      )}
    </div>
    {columns !== undefined && onColumnsChange !== undefined && (
      <div className="border-t border-line p-3">
        <p className="mb-2 text-xs text-text-muted">Display properties</p>
        <div className="flex flex-wrap gap-1.5">
          {PROJECT_COLUMNS.map((column) => {
            const on = columns.includes(column);
            return (
              <button
                key={column}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  onColumnsChange(
                    PROJECT_COLUMNS.filter((item) =>
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
                {PROJECT_COLUMN_LABELS[column]}
              </button>
            );
          })}
        </div>
      </div>
    )}
    {onReset !== undefined && (
      <div className="flex justify-end border-t border-line px-3 py-2">
        <Button variant="ghost" size="sm" onClick={onReset}>
          Reset
        </Button>
      </div>
    )}
  </Popover>
);

export default ProjectsDisplayMenu;
