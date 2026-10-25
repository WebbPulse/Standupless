/**
 * The insert menu a `/` opens under the caret, drawn the way the `#`
 * reference picker is: a listbox of rows with a glyph, a name and, at the end,
 * the Markdown that types the same block, with its chord as the tooltip. It
 * only draws; the editor owns the query, the highlight and what a pick does.
 */

import React, { useEffect, useRef } from 'react';
import { cn } from '../../lib/cn';
import { shortcutLabel } from './formatting';
import type { SlashCommand } from './slashCommands';

/** Props for SlashMenu. */
export interface SlashMenuProps {
  commands: SlashCommand[];
  highlight: number;
  top: number;
  left: number;
  onChoose: (command: SlashCommand) => void;
  onHighlight: (index: number) => void;
}

/** The insert menu's listbox, anchored at the caret. */
export const SlashMenu: React.FC<SlashMenuProps> = ({
  commands,
  highlight,
  top,
  left,
  onChoose,
  onHighlight,
}) => {
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const row = list.current?.children[highlight];
    if (typeof row?.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [highlight]);

  return (
    <ul
      ref={list}
      role="listbox"
      aria-label="Insert a block"
      className="absolute z-20 max-h-72 w-64 overflow-y-auto rounded-md border border-line bg-overlay py-1 shadow-overlay"
      style={{ top, left }}
    >
      {commands.map((command, index) => {
        const Icon = command.icon;
        return (
          <li
            key={command.id}
            role="option"
            aria-selected={index === highlight}
            data-command={command.id}
            title={
              command.keys === undefined
                ? undefined
                : `${command.label}  ${shortcutLabel(command.keys)}`
            }
            className={cn(
              'flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm hover:bg-raised hover:text-text active:bg-line',
              index === highlight ? 'bg-raised text-text' : 'text-text-muted'
            )}
            onMouseDown={(event) => {
              event.preventDefault();
              onChoose(command);
            }}
            onMouseEnter={() => {
              onHighlight(index);
            }}
          >
            <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-text">
              {command.label}
            </span>
            {command.hint !== undefined && (
              <span className="shrink-0 font-mono text-xs text-text-faint">
                {command.hint}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
};

export default SlashMenu;
