/**
 * The small menu a block's grip opens: Turn into, which lists the block types
 * the `/` menu inserts, then Duplicate and Delete. It only draws and reports
 * picks; the editor owns which block it is for and what each pick does.
 * ArrowUp and ArrowDown move between rows, ArrowRight and ArrowLeft open and
 * close the Turn into list, and Escape closes the menu.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { IconType } from 'react-icons';
import {
  LuChevronRight,
  LuCopy,
  LuPilcrow,
  LuRepeat,
  LuTrash2,
} from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { SLASH_COMMANDS, type SlashCommand } from './slashCommands';

/** The slash commands Turn into offers, in the `/` menu's order. */
const TURN_INTO_IDS = new Set([
  'heading1',
  'heading2',
  'heading3',
  'bulletList',
  'orderedList',
  'taskList',
  'blockquote',
  'codeBlock',
  'callout',
]);

/** One row of Turn into: plain text, or a slash command's block. */
export interface TurnIntoOption {
  id: string;
  label: string;
  icon: IconType;
  command: SlashCommand | null;
}

/** Every Turn into row, plain text first. */
export const TURN_INTO_OPTIONS: TurnIntoOption[] = [
  { id: 'paragraph', label: 'Text', icon: LuPilcrow, command: null },
  ...SLASH_COMMANDS.filter((command) => TURN_INTO_IDS.has(command.id)).map(
    (command): TurnIntoOption => ({
      id: command.id,
      label: command.label,
      icon: command.icon,
      command,
    })
  ),
];

/** Props for BlockMenu. */
export interface BlockMenuProps {
  top: number;
  left: number;
  /** False leaves Turn into out, as for an image or a table. */
  canTurnInto: boolean;
  onTurnInto: (option: TurnIntoOption) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
  /** Told when focus leaves the menu, so the surface can commit. */
  onBlur?: (event: React.FocusEvent) => void;
}

/** Moves focus to the next or previous menu row inside a list. */
const stepFocus = (list: HTMLElement | null, step: 1 | -1): void => {
  if (list === null) return;
  const rows = Array.from(
    list.querySelectorAll<HTMLButtonElement>(':scope > li > button')
  );
  if (rows.length === 0) return;
  const at = rows.findIndex((row) => row === document.activeElement);
  const next = rows[(at + step + rows.length) % rows.length];
  next?.focus();
};

/** A menu row's classes. */
const ROW_CLASS =
  'flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-text-muted outline-none hover:bg-raised hover:text-text focus-visible:bg-raised focus-visible:text-text';

/** The grip's menu, anchored under the grip. */
export const BlockMenu: React.FC<BlockMenuProps> = ({
  top,
  left,
  canTurnInto,
  onTurnInto,
  onDuplicate,
  onDelete,
  onClose,
  onBlur,
}) => {
  const main = useRef<HTMLUListElement>(null);
  const sub = useRef<HTMLUListElement>(null);
  const [turnInto, setTurnInto] = useState(false);

  useEffect(() => {
    main.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);

  useEffect(() => {
    if (turnInto)
      sub.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [turnInto]);

  useEffect(() => {
    const away = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (main.current?.parentElement?.contains(target) === true) return;
      onClose();
    };
    document.addEventListener('mousedown', away);
    return () => {
      document.removeEventListener('mousedown', away);
    };
  }, [onClose]);

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const inSub = sub.current?.contains(document.activeElement) === true;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (inSub) {
        setTurnInto(false);
        main.current?.querySelector<HTMLButtonElement>('button')?.focus();
        return;
      }
      onClose();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      stepFocus(
        inSub ? sub.current : main.current,
        event.key === 'ArrowDown' ? 1 : -1
      );
      return;
    }
    if (event.key === 'ArrowRight' && !inSub && canTurnInto) {
      const first = main.current?.querySelector('button');
      if (document.activeElement === first) {
        event.preventDefault();
        setTurnInto(true);
      }
      return;
    }
    if (event.key === 'ArrowLeft' && inSub) {
      event.preventDefault();
      setTurnInto(false);
      main.current?.querySelector<HTMLButtonElement>('button')?.focus();
    }
  };

  return (
    <div
      className="absolute z-20 flex items-start gap-1"
      style={{ top, left }}
      onKeyDown={onKeyDown}
      {...(onBlur === undefined ? {} : { onBlur })}
    >
      <ul
        ref={main}
        role="menu"
        aria-label="Block actions"
        className="w-44 rounded-md border border-line bg-overlay p-1 shadow-overlay"
      >
        {canTurnInto && (
          <li role="none">
            <button
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={turnInto}
              className={cn(ROW_CLASS, turnInto && 'bg-raised text-text')}
              onClick={() => {
                setTurnInto((open) => !open);
              }}
              onMouseEnter={() => {
                setTurnInto(true);
              }}
            >
              <LuRepeat aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-text">
                Turn into
              </span>
              <LuChevronRight
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 text-text-faint"
              />
            </button>
          </li>
        )}
        <li role="none">
          <button
            type="button"
            role="menuitem"
            className={ROW_CLASS}
            onClick={onDuplicate}
            onMouseEnter={() => {
              setTurnInto(false);
            }}
          >
            <LuCopy aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-text">Duplicate</span>
          </button>
        </li>
        <li role="none">
          <button
            type="button"
            role="menuitem"
            className={ROW_CLASS}
            onClick={onDelete}
            onMouseEnter={() => {
              setTurnInto(false);
            }}
          >
            <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-text">Delete</span>
          </button>
        </li>
      </ul>
      {turnInto && canTurnInto && (
        <ul
          ref={sub}
          role="menu"
          aria-label="Turn into"
          className="max-h-72 w-48 overflow-y-auto rounded-md border border-line bg-overlay p-1 shadow-overlay"
        >
          {TURN_INTO_OPTIONS.map((option) => {
            const Icon = option.icon;
            return (
              <li key={option.id} role="none">
                <button
                  type="button"
                  role="menuitem"
                  data-turn-into={option.id}
                  className={ROW_CLASS}
                  onClick={() => {
                    onTurnInto(option);
                  }}
                >
                  <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-text">
                    {option.label}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default BlockMenu;
