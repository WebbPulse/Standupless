/**
 * The Display button of the projects list and the roadmap: the layout, how
 * projects group and in which direction, the grouping inside each group,
 * what order they run in, which closed projects stay, whether a team page
 * keeps only the projects it leads, whether the board keeps empty columns,
 * how far the timeline is zoomed, whether it draws its dependency lines, and
 * which properties show. It reads like the issue list's Display menu so every
 * list is arranged the same way, and it writes nothing itself. A page leaves
 * out the choices it does not offer.
 */

import React from 'react';
import {
  LuArrowDown,
  LuArrowUp,
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
  PROJECT_COLUMN_CHIPS,
  PROJECT_COLUMN_LABELS,
  parseDisplayField,
  type ClosedWindow,
  type DependencyLinesChoice,
  type EmptyColumnsChoice,
  type GroupDirection,
  type LeadTeamChoice,
  type ProjectColumn,
  type ProjectGrouping,
  type ProjectLayout,
  type ProjectOrdering,
} from '../../lib/projectList';
import {
  TIMELINE_ZOOMS,
  TIMELINE_ZOOM_LABELS,
  type TimelineZoom,
} from '../../lib/timeline';
import type { ProjectsDefaultActions } from '../../hooks/useProjectsDisplayDefault';
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
  /** The direction groups run in, left out where groups keep a fixed order. */
  direction?: GroupDirection;
  onDirectionChange?: (direction: GroupDirection) => void;
  /** The grouping inside each group, left out where the layout has one level. */
  rows?: ProjectGrouping;
  onRowsChange?: (rows: ProjectGrouping) => void;
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
  /** Whether only the projects a team leads stay, left out off a team page. */
  leadTeam?: LeadTeamChoice;
  onLeadTeamChange?: (leadTeam: LeadTeamChoice) => void;
  /** Whether empty board columns show, left out off the board. */
  empty?: EmptyColumnsChoice;
  onEmptyChange?: (empty: EmptyColumnsChoice) => void;
  /** How far the timeline is zoomed, left out off the timeline. */
  zoom?: TimelineZoom;
  onZoomChange?: (zoom: TimelineZoom) => void;
  /** Whether the timeline draws its dependency lines, left out off the timeline. */
  dependencies?: DependencyLinesChoice;
  onDependenciesChange?: (dependencies: DependencyLinesChoice) => void;
  /** Whether archived projects list too, left out where they never show. */
  archived?: boolean;
  onArchivedChange?: (archived: boolean) => void;
  /** The shown properties, left out where the layout draws no columns. */
  columns?: readonly ProjectColumn[];
  onColumnsChange?: (columns: ProjectColumn[]) => void;
  /** The properties offered as chips, every one by default. */
  chips?: readonly ProjectColumn[];
  /** Puts every choice back to the page's own, or undefined when they match. */
  onReset?: (() => void) | undefined;
  /** Saving or clearing the default for everyone, left out for a non-admin and on a view. */
  defaultActions?: ProjectsDefaultActions | undefined;
}

/** The muted text buttons the panel footer is drawn with. */
const FOOTER_ACTION =
  'text-xs text-text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50';

/** Who a default for everyone reaches, named in the footer button titles. */
const SCOPE_AUDIENCE: Record<ProjectsDefaultActions['scope'], string> = {
  team: 'everyone on this team',
  workspace: 'everyone in this workspace',
};

/** Props for one labelled select row of the panel. */
export interface ChoiceRowProps<T extends string> {
  id: string;
  label: string;
  value: T;
  choices: readonly T[];
  labels: Record<T, string>;
  onChange: (value: T) => void;
  /** Drawn before the select, such as a direction button. */
  adornment?: React.ReactNode;
  disabled?: boolean;
}

/** One labelled select row of the Display panel. */
export const ChoiceRow = <T extends string>({
  id,
  label,
  value,
  choices,
  labels,
  onChange,
  adornment,
  disabled = false,
}: ChoiceRowProps<T>): React.ReactElement => (
  <div className="flex items-center justify-between gap-4">
    <label htmlFor={id} className="text-xs text-text-muted">
      {label}
    </label>
    <div className="flex items-center gap-1">
      {adornment}
      <Select
        id={id}
        className="h-7 w-36 py-0 text-xs"
        value={value}
        disabled={disabled}
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
  </div>
);

/** One on or off choice of the Display panel, drawn as a labelled switch. */
export const SwitchRow: React.FC<{
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}> = ({ id, label, checked, onChange }) => (
  <div className="flex items-center justify-between gap-4">
    <label htmlFor={id} className="text-xs text-text-muted">
      {label}
    </label>
    <input
      id={id}
      type="checkbox"
      role="switch"
      checked={checked}
      onChange={(event) => {
        onChange(event.target.checked);
      }}
      className="h-4 w-7 cursor-pointer accent-accent"
    />
  </div>
);

/** The button that flips the direction groups run in. */
const DirectionButton: React.FC<{
  direction: GroupDirection;
  disabled: boolean;
  onChange: (direction: GroupDirection) => void;
}> = ({ direction, disabled, onChange }) => (
  <button
    type="button"
    aria-label="Reverse grouping"
    aria-pressed={direction === 'desc'}
    title="Reverse grouping"
    disabled={disabled}
    onClick={() => {
      onChange(direction === 'desc' ? 'asc' : 'desc');
    }}
    className={cn(
      'flex h-7 w-7 items-center justify-center rounded-md border text-text-muted focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50',
      direction === 'desc'
        ? 'border-line-strong bg-raised text-text'
        : 'border-line hover:border-line-strong hover:text-text'
    )}
  >
    {direction === 'desc' ? (
      <LuArrowUp aria-hidden="true" className="h-3.5 w-3.5" />
    ) : (
      <LuArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
    )}
  </button>
);

/** The Display button and its layout, grouping, ordering, window and property panel. */
export const ProjectsDisplayMenu: React.FC<ProjectsDisplayMenuProps> = ({
  grouping,
  direction,
  onDirectionChange,
  rows,
  onRowsChange,
  leadTeam,
  onLeadTeamChange,
  empty,
  onEmptyChange,
  zoom,
  onZoomChange,
  dependencies,
  onDependenciesChange,
  archived,
  onArchivedChange,
  layout,
  ordering,
  closed,
  onGroupingChange,
  onLayoutChange,
  onOrderingChange,
  onClosedChange,
  columns,
  onColumnsChange,
  chips = PROJECT_COLUMN_CHIPS,
  onReset,
  defaultActions,
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
        adornment={
          direction !== undefined && onDirectionChange !== undefined ? (
            <DirectionButton
              direction={direction}
              disabled={grouping === 'none'}
              onChange={onDirectionChange}
            />
          ) : undefined
        }
      />
      {rows !== undefined && onRowsChange !== undefined && (
        <ChoiceRow
          id="projects-rows"
          label={layout === 'board' ? 'Rows' : 'Sub-grouping'}
          value={grouping === 'none' || rows === grouping ? 'none' : rows}
          choices={PROJECT_GROUPINGS.filter(
            (choice) => choice === 'none' || choice !== grouping
          )}
          labels={PROJECT_GROUPING_LABELS}
          disabled={grouping === 'none'}
          onChange={onRowsChange}
        />
      )}
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
      {zoom !== undefined && onZoomChange !== undefined && (
        <ChoiceRow
          id="projects-zoom"
          label="Zoom"
          value={zoom}
          choices={TIMELINE_ZOOMS}
          labels={TIMELINE_ZOOM_LABELS}
          onChange={onZoomChange}
        />
      )}
      {closed !== undefined && onClosedChange !== undefined && (
        <ChoiceRow
          id="projects-closed"
          label="Show closed projects"
          value={closed}
          choices={CLOSED_WINDOWS}
          labels={CLOSED_WINDOW_LABELS}
          onChange={onClosedChange}
        />
      )}
      {leadTeam !== undefined && onLeadTeamChange !== undefined && (
        <SwitchRow
          id="projects-lead-team"
          label="Only show lead team projects"
          checked={leadTeam === 'lead'}
          onChange={(checked) => {
            onLeadTeamChange(checked ? 'lead' : 'all');
          }}
        />
      )}
      {empty !== undefined && onEmptyChange !== undefined && (
        <SwitchRow
          id="projects-empty"
          label="Show empty columns"
          checked={empty === 'show'}
          onChange={(checked) => {
            onEmptyChange(checked ? 'show' : 'hide');
          }}
        />
      )}
      {dependencies !== undefined && onDependenciesChange !== undefined && (
        <SwitchRow
          id="projects-dependencies"
          label="Show dependencies"
          checked={dependencies === 'show'}
          onChange={(checked) => {
            onDependenciesChange(checked ? 'show' : 'hide');
          }}
        />
      )}
      {archived !== undefined && onArchivedChange !== undefined && (
        <SwitchRow
          id="projects-archived"
          label="Show archived projects"
          checked={archived}
          onChange={onArchivedChange}
        />
      )}
    </div>
    {columns !== undefined && onColumnsChange !== undefined && (
      <div className="border-t border-line p-3">
        <p className="mb-2 text-xs text-text-muted">Display properties</p>
        <div className="flex flex-wrap gap-1.5">
          {chips
            .filter(
              (column) =>
                customerOrdering ||
                column !== 'important' ||
                columns.includes(column)
            )
            .map((column) => {
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
    {(onReset !== undefined ||
      defaultActions?.onSave !== undefined ||
      defaultActions?.onClear !== undefined) && (
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 border-t border-line px-3 py-2">
        {defaultActions?.onClear !== undefined && (
          <button
            type="button"
            disabled={defaultActions.busy}
            onClick={defaultActions.onClear}
            title={`Stop opening this page this way for ${SCOPE_AUDIENCE[defaultActions.scope]}`}
            className={FOOTER_ACTION}
          >
            Clear default
          </button>
        )}
        {defaultActions?.onSave !== undefined && (
          <button
            type="button"
            disabled={defaultActions.busy}
            onClick={defaultActions.onSave}
            title={`Open this page this way for ${SCOPE_AUDIENCE[defaultActions.scope]} until they change it`}
            className={FOOTER_ACTION}
          >
            Set default for everyone
          </button>
        )}
        {onReset !== undefined && (
          <Button variant="ghost" size="sm" onClick={onReset}>
            Reset
          </Button>
        )}
      </div>
    )}
  </Popover>
);

export default ProjectsDisplayMenu;
