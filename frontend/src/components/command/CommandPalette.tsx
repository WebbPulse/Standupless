/**
 * The command palette: one input over one list, holding the places a person
 * can go and the issues a term matches.
 *
 * Navigation commands and search results share a list rather than sitting in
 * separate panes, because the person typing does not know yet which of the two
 * their term is going to be, and a single highlight that Enter always resolves
 * is the whole point of the surface.
 *
 * An exact issue key resolves without the index, the same way the search page
 * does, since the index does not hold keys and a key is the most common thing
 * anyone types here.
 */

import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  LuArrowRight,
  LuCircleDot,
  LuInbox,
  LuLayers,
  LuList,
  LuMap,
  LuSearch,
  LuSettings,
  LuSquareKanban,
  LuTarget,
} from 'react-icons/lu';
import { useNavigate } from 'react-router-dom';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { search } from '../../api/views';
import { cn } from '../../lib/cn';
import {
  inboxPath,
  issuePath,
  myIssuesPath,
  projectsPath,
  roadmapPath,
  searchPath,
  settingsPath,
  teamPath,
  viewsPath,
} from '../../lib/paths';
import { searchKey } from '../../lib/queryKeys';
import {
  hasIndexableTerm,
  isIssueKey,
  isPartialIssueKey,
  MIN_TERM,
} from '../../lib/searchTerms';
import type { TeamRead } from '../../types/Api';

/** How many hits the palette asks the search route for. */
const RESULT_LIMIT = 20;

/** How often an open search re-reads while its term is unchanged. */
const POLL_MS = 60000;

/** Props for CommandPalette. */
export interface CommandPaletteProps {
  /** Whether the palette is showing. */
  open: boolean;
  /** Called when the palette should close, on Escape, backdrop or activation. */
  onClose: () => void;
  /** The workspace id the search route is read under. */
  workspaceId: string;
  /** The workspace slug every route is built from. */
  slug: string;
  /** The teams the caller can see, each offered as a "Go to team" command. */
  teams?: readonly TeamRead[];
}

/** One row of the palette: a label, an icon, and where activating it goes. */
interface Command {
  id: string;
  label: string;
  /** A key or a team prefix shown at the end of the row. */
  hint?: string;
  icon: React.ReactNode;
  to: string;
}

/** A run of commands under one heading. */
interface CommandGroup {
  heading: string;
  commands: Command[];
}

const ICON = 'h-3.5 w-3.5 shrink-0';

/**
 * The places that do not depend on the term, built for one workspace. Kept out
 * of the component body so the list is one allocation per slug and team set
 * rather than one per keystroke.
 */
const navigationCommands = (
  slug: string,
  teams: readonly TeamRead[]
): Command[] => [
  {
    id: 'nav-my-issues',
    label: 'My issues',
    icon: <LuList className={ICON} />,
    to: myIssuesPath(slug),
  },
  {
    id: 'nav-inbox',
    label: 'Inbox',
    icon: <LuInbox className={ICON} />,
    to: inboxPath(slug),
  },
  {
    id: 'nav-projects',
    label: 'Projects',
    icon: <LuLayers className={ICON} />,
    to: projectsPath(slug),
  },
  {
    id: 'nav-roadmap',
    label: 'Roadmap',
    icon: <LuMap className={ICON} />,
    to: roadmapPath(slug),
  },
  {
    id: 'nav-views',
    label: 'Views',
    icon: <LuSquareKanban className={ICON} />,
    to: viewsPath(slug),
  },
  {
    id: 'nav-search',
    label: 'Search',
    icon: <LuSearch className={ICON} />,
    to: searchPath(slug),
  },
  {
    id: 'nav-settings',
    label: 'Settings',
    icon: <LuSettings className={ICON} />,
    to: settingsPath(slug),
  },
  ...teams.map((team) => ({
    id: `nav-team-${team.id}`,
    label: `Go to ${team.name}`,
    hint: team.key_prefix,
    icon: <LuTarget className={ICON} />,
    to: teamPath(slug, team.key_prefix),
  })),
];

/** Matches a command against the typed term, on a plain substring. */
const matches = (command: Command, term: string): boolean => {
  if (term === '') return true;
  const needle = term.toLowerCase();
  return (
    command.label.toLowerCase().includes(needle) ||
    (command.hint ?? '').toLowerCase().includes(needle)
  );
};

/** The frame, the input and the list of what a term resolves to. */
export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onClose,
  workspaceId,
  slug,
  teams = [],
}) => {
  const navigate = useNavigate();
  const auth = useQueryAuth();
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const titleId = useId();

  const deferred = useDeferredValue(term).trim();
  const isKey = isIssueKey(deferred);
  const isPartialKey = isPartialIssueKey(deferred);
  const indexable = hasIndexableTerm(deferred);
  const enabled =
    open &&
    workspaceId !== '' &&
    deferred !== '' &&
    indexable &&
    !isKey &&
    !isPartialKey;

  const { data, isLoading } = usePolledQuery(
    ({ signal }) =>
      search(workspaceId, deferred, { limit: RESULT_LIMIT }, signal),
    {
      intervalMs: POLL_MS,
      enabled,
      queryKey: searchKey(workspaceId, deferred, ''),
      auth,
    }
  );

  const navigation = useMemo(
    () => navigationCommands(slug, teams),
    [slug, teams]
  );

  const groups = useMemo<CommandGroup[]>(() => {
    const built: CommandGroup[] = [];

    if (isKey) {
      const key = deferred.toUpperCase();
      built.push({
        heading: 'Issue',
        commands: [
          {
            id: `key-${key}`,
            label: `Go to ${key}`,
            icon: <LuArrowRight className={ICON} />,
            to: issuePath(slug, key),
          },
        ],
      });
    }

    const results = data ?? [];
    if (!isKey && results.length > 0) {
      built.push({
        heading: 'Issues',
        commands: results.map((result) => ({
          id: `issue-${result.issue_id}`,
          label: result.title,
          hint: result.key,
          icon: <LuCircleDot className={ICON} />,
          to: issuePath(slug, result.key),
        })),
      });
    }

    const places = navigation.filter((command) => matches(command, deferred));
    if (places.length > 0) {
      built.push({ heading: 'Go to', commands: places });
    }

    return built;
  }, [data, deferred, isKey, navigation, slug]);

  const flat = useMemo(
    () => groups.flatMap((group) => group.commands),
    [groups]
  );

  const index = flat.length === 0 ? 0 : Math.min(active, flat.length - 1);
  const current = flat[index];

  const run = useCallback(
    (command: Command) => {
      onClose();
      void navigate(command.to);
    },
    [navigate, onClose]
  );

  const move = useCallback(
    (delta: number) => {
      setActive((previous) => {
        if (flat.length === 0) return 0;
        const from = Math.min(previous, flat.length - 1);
        return (from + delta + flat.length) % flat.length;
      });
    },
    [flat.length]
  );

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    input.current?.focus();
    return () => {
      document.body.style.overflow = bodyOverflow;
      previous?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const row = list.current?.querySelector<HTMLElement>(
      '[data-active="true"]'
    );
    if (typeof row?.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [open, index, flat.length]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')) {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')) {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (current !== undefined) run(current);
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      input.current?.focus();
    }
  };

  if (!open) return null;

  const empty =
    deferred !== '' && !isKey && !indexable
      ? `Search needs a word of at least ${String(MIN_TERM)} letters.`
      : isLoading && enabled
        ? 'Searching'
        : 'Nothing matched that.';

  let cursor = -1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh] pb-6 backdrop-blur-[2px] dark:bg-black/60"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="flex max-h-[60vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-line bg-overlay shadow-overlay"
      >
        <h2 id={titleId} className="sr-only">
          Command palette
        </h2>
        <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-line px-3.5">
          <LuSearch aria-hidden="true" className="h-4 w-4 text-text-faint" />
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-label="Type a command or search"
            aria-autocomplete="list"
            {...(current === undefined
              ? {}
              : { 'aria-activedescendant': `${listId}-${current.id}` })}
            autoComplete="off"
            spellCheck={false}
            placeholder="Type a command or search"
            className="min-w-0 flex-1 bg-transparent text-sm text-text placeholder:text-text-faint focus:outline-none"
            value={term}
            onChange={(event) => {
              setTerm(event.target.value);
              setActive(0);
            }}
          />
          <kbd className="hidden shrink-0 rounded-xs border border-line px-1.5 py-0.5 font-sans text-2xs text-text-faint sm:block">
            Esc
          </kbd>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
          {flat.length === 0 ? (
            <p className="px-3.5 py-6 text-center text-sm text-text-muted">
              {empty}
            </p>
          ) : (
            <ul ref={list} id={listId} role="listbox" aria-label="Commands">
              {groups.map((group) => (
                <li key={group.heading}>
                  <div
                    role="presentation"
                    className="px-3.5 pt-2 pb-1 text-xs tracking-wide text-text-faint uppercase"
                  >
                    {group.heading}
                  </div>
                  <ul role="group" aria-label={group.heading}>
                    {group.commands.map((command) => {
                      cursor += 1;
                      const at = cursor;
                      const selected = at === index;
                      return (
                        <li
                          key={command.id}
                          id={`${listId}-${command.id}`}
                          role="option"
                          aria-selected={selected}
                          data-active={selected}
                          className={cn(
                            'mx-1.5 flex h-9 cursor-pointer items-center gap-2.5 rounded-sm px-2 text-sm',
                            selected ? 'bg-raised text-text' : 'text-text-muted'
                          )}
                          onMouseMove={() => {
                            setActive(at);
                          }}
                          onClick={() => {
                            run(command);
                          }}
                        >
                          <span className="text-text-faint">
                            {command.icon}
                          </span>
                          <span className="min-w-0 flex-1 truncate">
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
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};

export default CommandPalette;
