/**
 * The inbox header's Filter and Display buttons. Filter narrows the list to
 * chosen notification types, and Display decides whether read and snoozed
 * rows stay in it and whether unread rows sort first. Both only report a new view; the page owns the state.
 */

import React from 'react';
import { LuListFilter, LuSlidersHorizontal } from 'react-icons/lu';
import Button from '../../components/ui/button';
import Checkbox from '../../components/ui/checkbox';
import { Popover } from '../../components/ui/popover';
import { DEFAULT_VIEW, INBOX_CATEGORIES, type InboxView } from './groups';

/** Props for the inbox menus: the current view and how to change it. */
export interface InboxViewMenuProps {
  view: InboxView;
  onChange: (view: InboxView) => void;
}

/** The Filter button and its list of notification types. */
export const InboxFilterMenu: React.FC<InboxViewMenuProps> = ({
  view,
  onChange,
}) => {
  const active = view.categories.length;
  const toggle = (id: string, on: boolean): void => {
    const categories = on
      ? [...view.categories, id]
      : view.categories.filter((one) => one !== id);
    onChange({ ...view, categories });
  };
  return (
    <Popover
      label="Filter notifications"
      align="end"
      contentClassName="w-64 p-0"
      trigger={(props) => (
        <Button {...props} size="sm" variant="secondary" className="gap-1.5">
          <LuListFilter aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="sr-only sm:not-sr-only">Filter</span>
          {active > 0 && (
            <span
              aria-label={`${active} ${active === 1 ? 'type' : 'types'} chosen`}
              className="rounded-sm bg-raised px-1 text-2xs tabular-nums text-text-muted"
            >
              {active}
            </span>
          )}
        </Button>
      )}
    >
      <fieldset className="flex flex-col gap-2 p-3">
        <legend className="mb-1 text-xs text-text-muted">
          Notification type
        </legend>
        {INBOX_CATEGORIES.map((category) => (
          <Checkbox
            key={category.id}
            label={category.label}
            checked={view.categories.includes(category.id)}
            onChange={(event) => {
              toggle(category.id, event.target.checked);
            }}
          />
        ))}
      </fieldset>
      {active > 0 && (
        <div className="flex justify-end border-t border-line px-3 py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange({ ...view, categories: [] });
            }}
          >
            Clear filter
          </Button>
        </div>
      )}
    </Popover>
  );
};

/** The Display button and its read, snoozed and unread first toggles. */
export const InboxDisplayMenu: React.FC<InboxViewMenuProps> = ({
  view,
  onChange,
}) => {
  const changed =
    view.showRead !== DEFAULT_VIEW.showRead ||
    view.showSnoozed !== DEFAULT_VIEW.showSnoozed ||
    view.unreadFirst !== DEFAULT_VIEW.unreadFirst;
  return (
    <Popover
      label="Display options"
      align="end"
      contentClassName="w-60 p-0"
      trigger={(props) => (
        <Button {...props} size="sm" variant="secondary" className="gap-1.5">
          <LuSlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="sr-only sm:not-sr-only">Display</span>
        </Button>
      )}
    >
      <div className="flex flex-col gap-2 p-3">
        <Checkbox
          label="Show read"
          checked={view.showRead}
          onChange={(event) => {
            onChange({ ...view, showRead: event.target.checked });
          }}
        />
        <Checkbox
          label="Show snoozed"
          checked={view.showSnoozed}
          onChange={(event) => {
            onChange({ ...view, showSnoozed: event.target.checked });
          }}
        />
        <Checkbox
          label="Show unread first"
          checked={view.unreadFirst}
          onChange={(event) => {
            onChange({ ...view, unreadFirst: event.target.checked });
          }}
        />
      </div>
      {changed && (
        <div className="flex justify-end border-t border-line px-3 py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange({
                ...view,
                showRead: DEFAULT_VIEW.showRead,
                showSnoozed: DEFAULT_VIEW.showSnoozed,
                unreadFirst: DEFAULT_VIEW.unreadFirst,
              });
            }}
          >
            Reset
          </Button>
        </div>
      )}
    </Popover>
  );
};
