/**
 * The search field at the top of the settings sidebar: typing filters a list of
 * the settings pages, sections and controls the viewer may open, and choosing
 * one goes there, scrolls to its section and briefly highlights it, as
 * Linear's settings search does. `/` focuses it on any settings page.
 *
 * The matches come from the static settings index, so the search works before
 * any settings data has loaded and ranks the same way on every visit.
 */

import React, { useContext, useId, useMemo, useRef, useState } from 'react';
import { LuSearch } from 'react-icons/lu';
import { useNavigate } from 'react-router-dom';
import { TeamsContext } from '../../contexts/TeamsContextDefinition';
import { useSettingsHighlight } from '../../hooks/useSettingsHighlight';
import { useShortcut } from '../../hooks/useShortcuts';
import { cn } from '../../lib/cn';
import {
  buildSettingsIndex,
  rankSettings,
  settingsAnchorId,
  type SettingsEntry,
} from '../../lib/settingsIndex';
import type { TeamRead, WorkspaceRead } from '../../types/Api';

/** How many matches the list shows at most. */
const MAX_RESULTS = 10;

/** Props for SettingsAnchor: the section's index anchor and its content. */
export interface SettingsAnchorProps {
  id: string;
  children: React.ReactNode;
}

/** Marks a section of a workspace or account settings page as a search target. */
export const SettingsAnchor: React.FC<SettingsAnchorProps> = ({
  id,
  children,
}) => (
  <div id={settingsAnchorId(id)} className="scroll-mt-4 rounded-md">
    {children}
  </div>
);

/** Props for SettingsSearch. */
export interface SettingsSearchProps {
  workspace: Pick<WorkspaceRead, 'slug' | 'role'> &
    Partial<Pick<WorkspaceRead, 'features'>>;
  /**
   * The teams whose settings are searched. Left unset, the teams the viewer
   * belongs to in the shared team list.
   */
  teams?: readonly Pick<TeamRead, 'name' | 'key_prefix'>[];
  className?: string;
}

/** The section path an entry is shown under, such as "Engine > Cycles". */
const trailText = (entry: SettingsEntry): string => entry.trail.join(' > ');

/** The search field and its list of matches. */
export const SettingsSearch: React.FC<SettingsSearchProps> = ({
  workspace,
  teams,
  className,
}) => {
  const navigate = useNavigate();
  const shared = useContext(TeamsContext)?.data;
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);

  useSettingsHighlight();

  useShortcut({
    keys: '/',
    label: 'Search settings',
    scope: 'page',
    group: 'Settings',
    handler: () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    },
  });

  const covered = useMemo(
    () => teams ?? (shared ?? []).filter((team) => team.is_member !== false),
    [teams, shared]
  );

  const index = useMemo(
    () => buildSettingsIndex({ workspace, teams: covered }),
    [workspace, covered]
  );

  const matches = useMemo(
    () => rankSettings(index, term, MAX_RESULTS),
    [index, term]
  );

  const showing = open && term.trim() !== '';

  const choose = (entry: SettingsEntry): void => {
    setTerm('');
    setOpen(false);
    inputRef.current?.blur();
    void navigate(entry.to, { state: { settingsJump: entry.id } });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((current) =>
        matches.length === 0 ? 0 : (current + 1) % matches.length
      );
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) =>
        matches.length === 0
          ? 0
          : (current - 1 + matches.length) % matches.length
      );
    } else if (event.key === 'Enter') {
      const entry = matches[active];
      if (entry !== undefined) {
        event.preventDefault();
        choose(entry);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (term !== '') {
        setTerm('');
      } else {
        inputRef.current?.blur();
      }
    }
  };

  const optionId = (position: number): string => `${listId}-option-${position}`;

  return (
    <div className={cn('relative', className)}>
      <LuSearch
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-text-faint"
      />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-label="Search settings"
        aria-expanded={showing}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          showing && matches.length > 0 ? optionId(active) : undefined
        }
        placeholder="Search settings"
        autoComplete="off"
        spellCheck={false}
        value={term}
        onChange={(event) => {
          setTerm(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
        }}
        onBlur={() => {
          setOpen(false);
        }}
        onKeyDown={onKeyDown}
        className="h-8 w-full rounded-sm border border-line bg-bg pr-7 pl-7 text-sm text-text placeholder:text-text-faint transition-colors duration-100 hover:border-line-strong focus-visible:border-accent focus-visible:outline-none pointer-coarse:h-10 [&::-webkit-search-cancel-button]:hidden"
      />
      {term === '' && (
        <kbd
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded-xs border border-line px-1 text-2xs text-text-faint"
        >
          /
        </kbd>
      )}
      {showing && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Settings matches"
          className="absolute top-full left-0 z-30 mt-1 max-h-96 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-md border border-line bg-surface p-1 shadow-lg"
        >
          {matches.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-text-muted">
              No settings match
            </li>
          ) : (
            matches.map((entry, position) => (
              <li
                key={entry.id}
                id={optionId(position)}
                role="option"
                aria-selected={position === active}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onMouseEnter={() => {
                  setActive(position);
                }}
                onClick={() => {
                  choose(entry);
                }}
                className={cn(
                  'flex cursor-pointer flex-col rounded-sm px-2 py-1.5 hover:bg-raised',
                  position === active ? 'bg-raised' : ''
                )}
              >
                <span className="truncate text-sm text-text">
                  {entry.title}
                </span>
                <span className="truncate text-xs text-text-faint">
                  {trailText(entry)}
                </span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
};

export default SettingsSearch;
