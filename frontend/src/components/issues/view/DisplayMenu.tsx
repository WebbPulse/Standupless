/**
 * The display options of a list or board: the layout, the grouping and
 * sub-grouping, the ordering, whether empty groups show, and which
 * properties the rows carry. Every change lands in the URL at once, so the
 * menu is a live control rather than a form with a save button.
 */

import React from 'react';
import { LuKanban, LuList, LuSlidersHorizontal } from 'react-icons/lu';
import type { IssueListSort } from '../../../api/issues';
import { cn } from '../../../lib/cn';
import {
  DISPLAY_PROPERTIES,
  GROUP_FIELDS,
  GROUP_LABELS,
  ORDERINGS,
  ORDERING_LABELS,
  PROPERTY_LABELS,
  type GroupField,
  type ViewState,
} from '../../../lib/issueView';
import Button from '../../ui/button';
import { Popover } from '../../ui/popover';
import { Select } from '../../ui/select';

/** Props for DisplayMenu. */
export interface DisplayMenuProps {
  state: ViewState;
  onChange: (state: ViewState) => void;
  /** Puts every display option back to the page's own, or undefined when they match. */
  onReset?: (() => void) | undefined;
}

/** One labelled row of the menu. */
const Row: React.FC<{
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}> = ({ label, htmlFor, children }) => (
  <div className="flex items-center justify-between gap-4">
    <label htmlFor={htmlFor} className="text-xs text-text-muted">
      {label}
    </label>
    {children}
  </div>
);

const SELECT_CLASS = 'h-7 w-40 py-0 text-xs';

/** The Display button and its panel. */
export const DisplayMenu: React.FC<DisplayMenuProps> = ({
  state,
  onChange,
  onReset,
}) => {
  const set = (patch: Partial<ViewState>): void => {
    onChange({ ...state, ...patch });
  };
  const layouts = [
    { value: 'list', label: 'List', icon: <LuList className="h-4 w-4" /> },
    { value: 'board', label: 'Board', icon: <LuKanban className="h-4 w-4" /> },
  ] as const;

  return (
    <Popover
      label="Display options"
      align="end"
      contentClassName="w-80 p-0"
      trigger={(props) => (
        <Button {...props} size="sm" variant="secondary" className="gap-1.5">
          <LuSlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
          Display
        </Button>
      )}
    >
      <div className="flex flex-col gap-3 p-3">
        <div
          role="radiogroup"
          aria-label="Layout"
          className="grid grid-cols-2 gap-1.5"
        >
          {layouts.map((layout) => {
            const active = state.layout === layout.value;
            return (
              <button
                key={layout.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => {
                  set({
                    layout: layout.value,
                    showEmpty: layout.value === 'board',
                    ...(layout.value === 'board' && state.groupBy === 'none'
                      ? { groupBy: 'status' as const }
                      : {}),
                  });
                }}
                className={cn(
                  'flex h-14 flex-col items-center justify-center gap-1 rounded-md border text-xs focus-visible:outline-2 focus-visible:outline-accent',
                  active
                    ? 'border-line-strong bg-raised text-text'
                    : 'border-line text-text-muted hover:border-line-strong hover:text-text'
                )}
              >
                {layout.icon}
                {layout.label}
              </button>
            );
          })}
        </div>
        <Row
          label={state.layout === 'board' ? 'Columns' : 'Grouping'}
          htmlFor="display-group"
        >
          <Select
            id="display-group"
            className={SELECT_CLASS}
            value={state.groupBy}
            onChange={(event) => {
              const groupBy = event.target.value as GroupField;
              set({
                groupBy,
                subGroupBy:
                  state.subGroupBy === groupBy ? 'none' : state.subGroupBy,
              });
            }}
          >
            {GROUP_FIELDS.filter(
              (field) => state.layout === 'list' || field !== 'none'
            ).map((field) => (
              <option key={field} value={field}>
                {GROUP_LABELS[field]}
              </option>
            ))}
          </Select>
        </Row>
        <Row
          label={state.layout === 'board' ? 'Rows' : 'Sub-grouping'}
          htmlFor="display-sub"
        >
          <Select
            id="display-sub"
            className={SELECT_CLASS}
            value={state.subGroupBy}
            disabled={state.groupBy === 'none'}
            onChange={(event) => {
              set({ subGroupBy: event.target.value as GroupField });
            }}
          >
            {GROUP_FIELDS.filter(
              (field) => field === 'none' || field !== state.groupBy
            ).map((field) => (
              <option key={field} value={field}>
                {GROUP_LABELS[field]}
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Ordering" htmlFor="display-order">
          <Select
            id="display-order"
            className={SELECT_CLASS}
            value={state.ordering}
            onChange={(event) => {
              set({ ordering: event.target.value as IssueListSort });
            }}
          >
            {ORDERINGS.map((ordering) => (
              <option key={ordering} value={ordering}>
                {ORDERING_LABELS[ordering]}
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Show empty groups" htmlFor="display-empty">
          <input
            id="display-empty"
            type="checkbox"
            role="switch"
            checked={state.showEmpty}
            onChange={(event) => {
              set({ showEmpty: event.target.checked });
            }}
            className="h-4 w-7 cursor-pointer accent-accent"
          />
        </Row>
      </div>
      <div className="border-t border-line p-3">
        <p className="mb-2 text-xs text-text-muted">Display properties</p>
        <div className="flex flex-wrap gap-1.5">
          {DISPLAY_PROPERTIES.map((property) => {
            const on = state.visible.includes(property);
            return (
              <button
                key={property}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  set({
                    visible: on
                      ? state.visible.filter((item) => item !== property)
                      : DISPLAY_PROPERTIES.filter(
                          (item) =>
                            item === property || state.visible.includes(item)
                        ),
                  });
                }}
                className={cn(
                  'h-6 rounded-full border px-2 text-2xs focus-visible:outline-2 focus-visible:outline-accent',
                  on
                    ? 'border-line-strong bg-raised text-text'
                    : 'border-line text-text-faint hover:text-text-muted'
                )}
              >
                {PROPERTY_LABELS[property]}
              </button>
            );
          })}
        </div>
      </div>
      {onReset !== undefined && (
        <div className="flex justify-end border-t border-line px-3 py-2">
          <button
            type="button"
            onClick={onReset}
            className="text-xs text-text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
          >
            Reset to default
          </button>
        </div>
      )}
    </Popover>
  );
};

export default DisplayMenu;
