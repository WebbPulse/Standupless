/**
 * The inline color and icon picker a status row in team settings opens. The
 * trigger is the status glyph itself, the panel previews whatever the pointer
 * or keyboard rests on before anything is saved, and both swatch grids are
 * radio groups walked with the arrow keys.
 */

import React, { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import {
  CATEGORY_DEFAULT_COLOR,
  ICONS_BY_CATEGORY,
  STATUS_COLORS,
  STATUS_COLOR_LABELS,
  STATUS_COLOR_VALUES,
  STATUS_ICON_LABELS,
  defaultIcon,
  iconFits,
  isStatusColor,
  type StatusColor,
  type StatusIconName,
  type StatusLike,
} from '../../lib/statusAppearance';
import type { StatusCategory } from '../../types/Api';
import { Popover } from '../ui/popover';
import { StatusIcon } from '../ui/StatusIcon';

/** A status's two appearance fields, where null means the category default. */
export interface StatusAppearance {
  color: string | null;
  icon: string | null;
}

/** Props for StatusAppearancePicker. */
export interface StatusAppearancePickerProps {
  /** The name shown in the preview and announced on the trigger. */
  name: string;
  category: StatusCategory;
  value: StatusAppearance;
  /** Called with the fields a choice changes, each one alone. */
  onChange: (patch: Partial<StatusAppearance>) => void;
  /** The status itself, for its rank among the team's started statuses. */
  status?: StatusLike;
  statuses?: readonly StatusLike[];
  disabled?: boolean;
}

/** Moves focus through a radio group by arrow key, wrapping at either end. */
const moveFocus = (
  event: React.KeyboardEvent<HTMLElement>,
  columns: number
) => {
  const step: Record<string, number> = {
    ArrowRight: 1,
    ArrowLeft: -1,
    ArrowDown: columns,
    ArrowUp: -columns,
  };
  const delta = step[event.key];
  const buttons = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')
  );
  const current = buttons.indexOf(document.activeElement as HTMLElement);
  if (current < 0) return;
  let next: number | undefined;
  if (delta !== undefined) {
    next = (current + delta + buttons.length) % buttons.length;
  } else if (event.key === 'Home') {
    next = 0;
  } else if (event.key === 'End') {
    next = buttons.length - 1;
  }
  if (next === undefined) return;
  event.preventDefault();
  buttons[next]?.focus();
};

/** One round swatch or icon cell in a picker grid. */
const Cell: React.FC<{
  label: string;
  checked: boolean;
  focusable: boolean;
  onPick: () => void;
  onPreview: (on: boolean) => void;
  children: React.ReactNode;
}> = ({ label, checked, focusable, onPick, onPreview, children }) => (
  <button
    type="button"
    role="radio"
    aria-checked={checked}
    aria-label={label}
    title={label}
    tabIndex={focusable ? 0 : -1}
    onClick={onPick}
    onMouseEnter={() => {
      onPreview(true);
    }}
    onMouseLeave={() => {
      onPreview(false);
    }}
    onFocus={() => {
      onPreview(true);
    }}
    onBlur={() => {
      onPreview(false);
    }}
    className={cn(
      'flex h-6 w-6 items-center justify-center rounded-sm transition-colors duration-100 hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent',
      checked && 'bg-raised ring-1 ring-line-strong'
    )}
  >
    {children}
  </button>
);

/** The glyph trigger and its color and icon panel for one status. */
export const StatusAppearancePicker: React.FC<StatusAppearancePickerProps> = ({
  name,
  category,
  value,
  onChange,
  status,
  statuses = [],
  disabled = false,
}) => {
  const [previewColor, setPreviewColor] = useState<string | null | undefined>(
    undefined
  );
  const [previewIcon, setPreviewIcon] = useState<string | null | undefined>(
    undefined
  );
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    panel.current
      ?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')
      ?.focus();
  }, [open]);

  const color = isStatusColor(value.color) ? value.color : null;
  const icon = iconFits(category, value.icon) ? value.icon : null;
  const base: StatusLike = status ?? { category };

  const shown = (draft: StatusAppearance): StatusLike => ({
    ...base,
    category,
    color: draft.color,
    icon: draft.icon,
  });
  const siblings = (draft: StatusLike): StatusLike[] =>
    status?.id === undefined
      ? [...statuses, draft]
      : statuses.map((row) => (row.id === status.id ? draft : row));

  const current = shown({ color, icon });
  const preview = shown({
    color: previewColor === undefined ? color : previewColor,
    icon: previewIcon === undefined ? icon : previewIcon,
  });
  const icons = ICONS_BY_CATEGORY[category];
  const colorChoices: (StatusColor | null)[] = [null, ...STATUS_COLORS];
  const iconChoices: (StatusIconName | null)[] = [null, ...icons.slice(1)];

  return (
    <Popover
      label={`Color and icon for ${name}`}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setPreviewColor(undefined);
          setPreviewIcon(undefined);
        }
      }}
      contentClassName="w-64 p-2"
      trigger={(props) => (
        <button
          type="button"
          {...props}
          disabled={disabled}
          aria-label={`Change the color and icon of ${name}`}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm transition-colors duration-100 hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none"
        >
          <StatusIcon status={current} statuses={siblings(current)} />
        </button>
      )}
    >
      <div ref={panel} className="space-y-2">
        <div
          className="flex h-8 items-center gap-2 rounded-sm bg-surface px-2"
          data-testid="status-appearance-preview"
        >
          <StatusIcon status={preview} statuses={siblings(preview)} />
          <span className="truncate text-sm font-medium text-text">
            {name === '' ? 'New status' : name}
          </span>
        </div>
        <div className="space-y-1">
          <p className="px-1 text-2xs font-medium text-text-faint">Color</p>
          <div
            role="radiogroup"
            aria-label="Color"
            className="grid grid-cols-8 gap-0.5"
            onKeyDown={(event) => {
              moveFocus(event, 8);
            }}
          >
            {colorChoices.map((choice) => {
              const checked = choice === color;
              const label =
                choice === null
                  ? 'Category default'
                  : STATUS_COLOR_LABELS[choice];
              return (
                <Cell
                  key={choice ?? 'default'}
                  label={label}
                  checked={checked}
                  focusable={checked}
                  onPick={() => {
                    if (!checked) onChange({ color: choice });
                  }}
                  onPreview={(on) => {
                    setPreviewColor(on ? choice : undefined);
                  }}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'h-3.5 w-3.5 rounded-full',
                      choice === null &&
                        'border border-dashed border-line-strong'
                    )}
                    style={{
                      backgroundColor:
                        choice === null
                          ? CATEGORY_DEFAULT_COLOR[category]
                          : STATUS_COLOR_VALUES[choice],
                    }}
                  />
                </Cell>
              );
            })}
          </div>
        </div>
        <div className="space-y-1">
          <p className="px-1 text-2xs font-medium text-text-faint">Icon</p>
          <div
            role="radiogroup"
            aria-label="Icon"
            className="flex flex-wrap gap-0.5"
            onKeyDown={(event) => {
              moveFocus(event, 1);
            }}
          >
            {iconChoices.map((choice) => {
              const checked = choice === icon;
              const drawn = choice ?? defaultIcon(category);
              const label =
                choice === null
                  ? `Category default, ${STATUS_ICON_LABELS[drawn].toLowerCase()}`
                  : STATUS_ICON_LABELS[choice];
              const cell = shown({ color: preview.color ?? null, icon: drawn });
              return (
                <Cell
                  key={choice ?? 'default'}
                  label={label}
                  checked={checked}
                  focusable={checked}
                  onPick={() => {
                    if (!checked) onChange({ icon: choice });
                  }}
                  onPreview={(on) => {
                    setPreviewIcon(on ? choice : undefined);
                  }}
                >
                  <StatusIcon status={cell} statuses={siblings(cell)} />
                </Cell>
              );
            })}
          </div>
        </div>
      </div>
    </Popover>
  );
};

export default StatusAppearancePicker;
