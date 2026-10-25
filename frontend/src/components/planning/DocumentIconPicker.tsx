/**
 * The icon control beside a document's title: a button showing the current
 * mark that opens a panel with two tabs, the glyph set projects use and every
 * emoji, plus a way to remove the icon. Picking saves straight away.
 */

import React, { useState } from 'react';
import { cn } from '../../lib/cn';
import { PROJECT_ICON_GLYPHS, PROJECT_ICON_NAMES } from '../../lib/projectLook';
import EmojiPicker from '../discussion/EmojiPicker';
import Popover, { type PopoverTriggerProps } from '../ui/popover';
import DocumentIcon from './DocumentIcon';

/** Props for DocumentIconPicker. */
export interface DocumentIconPickerProps {
  icon: string | null;
  disabled?: boolean;
  /** Saves a new icon, or null to remove it. */
  onChange: (icon: string | null) => void;
}

/** Which half of the panel is showing. */
type Tab = 'icons' | 'emoji';

/** The tab buttons heading the panel. */
const TABS: { id: Tab; label: string }[] = [
  { id: 'icons', label: 'Icons' },
  { id: 'emoji', label: 'Emoji' },
];

/** The button and its panel. */
export const DocumentIconPicker: React.FC<DocumentIconPickerProps> = ({
  icon,
  disabled = false,
  onChange,
}) => {
  const [tab, setTab] = useState<Tab>('icons');
  const button = (props: Partial<PopoverTriggerProps>): React.ReactNode => (
    <button
      type="button"
      aria-label={icon === null ? 'Add icon' : 'Change icon'}
      disabled={disabled}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-2xl transition-colors duration-100 hover:bg-surface focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none disabled:hover:bg-transparent"
      {...props}
    >
      <DocumentIcon icon={icon} className="h-6 w-6" />
    </button>
  );
  if (disabled) return button({});
  return (
    <Popover label="Document icon" trigger={(trigger) => button(trigger)}>
      {(close) => (
        <div className="w-72">
          <div className="flex items-center gap-1 border-b border-line p-1.5">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={tab === entry.id}
                className={cn(
                  'rounded-sm px-2 py-1 text-xs font-medium text-text-muted hover:bg-raised hover:text-text',
                  tab === entry.id && 'bg-raised text-text'
                )}
                onClick={() => {
                  setTab(entry.id);
                }}
              >
                {entry.label}
              </button>
            ))}
            {icon !== null && (
              <button
                type="button"
                className="ml-auto rounded-sm px-2 py-1 text-xs text-text-muted hover:bg-raised hover:text-text"
                onClick={() => {
                  onChange(null);
                  close();
                }}
              >
                Remove
              </button>
            )}
          </div>
          {tab === 'icons' ? (
            <div
              role="group"
              aria-label="Icons"
              className="grid grid-cols-8 p-1.5"
            >
              {PROJECT_ICON_NAMES.map((name) => (
                <button
                  key={name}
                  type="button"
                  aria-label={name}
                  aria-pressed={icon === name}
                  title={name}
                  className={cn(
                    'inline-flex h-8 w-8 items-center justify-center rounded-sm text-text-muted hover:bg-raised hover:text-text',
                    icon === name && 'bg-accent-soft text-text'
                  )}
                  onClick={() => {
                    onChange(name);
                    close();
                  }}
                >
                  {React.createElement(PROJECT_ICON_GLYPHS[name], {
                    'aria-hidden': true,
                    className: 'h-4 w-4',
                  })}
                </button>
              ))}
            </div>
          ) : (
            <EmojiPicker
              onPick={(emoji) => {
                onChange(emoji);
                close();
              }}
            />
          )}
        </div>
      )}
    </Popover>
  );
};

export default DocumentIconPicker;
