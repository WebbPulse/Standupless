/**
 * The command palette: one input over one list, holding what a person can do
 * right now, the places they can go and the issues a term matches.
 *
 * Actions, destinations and search results share a list rather than sitting in
 * separate panes, because the person typing does not know yet which of the
 * three their term is going to be, and a single highlight that Enter always
 * resolves is the whole point of the surface.
 *
 * The actions on the issue in focus are not declared here. They are whatever
 * the page registered in the `'issue'` shortcut scope, run through the same
 * registry the keys use, so an action a page adds is reachable by name without
 * the palette knowing about it.
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
  LuArrowLeftRight,
  LuArrowRight,
  LuChevronLeft,
  LuCircleDot,
  LuInbox,
  LuKeyboard,
  LuLayers,
  LuLink,
  LuMap,
  LuMonitor,
  LuMoon,
  LuRefreshCcw,
  LuSearch,
  LuSettings,
  LuSquarePen,
  LuSun,
  LuTarget,
  LuUserRound,
  LuUsers,
  LuUsersRound,
  LuZap,
} from 'react-icons/lu';
import { useLocation, useNavigate } from 'react-router-dom';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { search } from '../../api/views';
import { useCreateIssue } from '../../hooks/useCreateIssue';
import { useCreateTeam } from '../../hooks/useCreateTeam';
import { displayKeys, useRegisteredShortcuts } from '../../hooks/useShortcuts';
import { useTheme } from '../../hooks/useTheme';
import { cn } from '../../lib/cn';
import {
  inboxPath,
  issuePath,
  myIssuesPath,
  projectsPath,
  roadmapPath,
  routeIssueKey,
  routeTeamPrefix,
  searchPath,
  settingsTeamsPath,
  teamCyclesPath,
  teamPath,
  teamSettingsPath,
  viewsPath,
} from '../../lib/paths';
import { searchKey } from '../../lib/queryKeys';
import {
  hasIndexableTerm,
  isIssueKey,
  isPartialIssueKey,
  MIN_TERM,
} from '../../lib/searchTerms';
import type { Theme } from '../../lib/theme';
import { currentOrFirstTeam, settingsLanding } from '../../lib/workspaceNav';
import type { TeamRead, WorkspaceRead } from '../../types/Api';

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
  /** The workspace every route and read is built from. */
  workspace: Pick<WorkspaceRead, 'id' | 'slug' | 'role'>;
  /** The teams the caller can see. */
  teams?: readonly TeamRead[];
  /** Opens the keyboard shortcut overlay. */
  onShowShortcuts?: () => void;
}

/**
 * One row of the palette. A row either goes somewhere (`to`) or does
 * something (`run`), and a row with `page` opens a nested list instead.
 */
interface Command {
  id: string;
  label: string;
  /** Extra words the row matches on without showing them. */
  keywords?: string;
  /** A key, a shortcut or a team prefix shown at the end of the row. */
  hint?: string;
  icon: React.ReactNode;
  to?: string;
  run?: () => void;
  page?: Page;
}

/** A run of commands under one heading. */
interface CommandGroup {
  heading: string;
  commands: Command[];
}

/** The palette's lists: the top level, or the team switcher inside it. */
type Page = 'root' | 'teams';

const ICON = 'h-3.5 w-3.5 shrink-0';

/** The words a theme setting reads as, and the icon it shows. */
const THEMES: { theme: Theme; label: string; icon: React.ReactNode }[] = [
  {
    theme: 'dark',
    label: 'Switch to dark theme',
    icon: <LuMoon className={ICON} />,
  },
  {
    theme: 'light',
    label: 'Switch to light theme',
    icon: <LuSun className={ICON} />,
  },
  {
    theme: 'system',
    label: 'Use system theme',
    icon: <LuMonitor className={ICON} />,
  },
];

/** A shortcut as a row hint, such as "G then I". */
const shortcutHint = (keys: string): string =>
  displayKeys(keys).join(keys.includes(' ') ? ' then ' : ' ');

/** Matches a command against the typed term, on a plain substring. */
const matches = (command: Command, term: string): boolean => {
  if (term === '') return true;
  const needle = term.toLowerCase();
  return [command.label, command.hint ?? '', command.keywords ?? ''].some(
    (text) => text.toLowerCase().includes(needle)
  );
};

/**
 * The same page under another team: a team route keeps its tab, anything else
 * lands on the team's issues.
 */
const switchTeamPath = (
  pathname: string,
  slug: string,
  from: string | null,
  to: string
): string => {
  const base = from === null ? null : teamPath(slug, from);
  if (base !== null && (pathname === base || pathname.startsWith(`${base}/`))) {
    return `${teamPath(slug, to)}${pathname.slice(base.length)}`;
  }
  return teamPath(slug, to);
};

/**
 * The open palette. It mounts on open and unmounts on close, so every opening
 * starts on an empty term at the top level without resetting state by hand.
 */
const PaletteBody: React.FC<Omit<CommandPaletteProps, 'open'>> = ({
  onClose,
  workspace,
  teams = [],
  onShowShortcuts,
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useQueryAuth();
  const createIssue = useCreateIssue();
  const createTeam = useCreateTeam();
  const { theme, setTheme } = useTheme();
  const registered = useRegisteredShortcuts();
  const [term, setTerm] = useState('');
  const [page, setPage] = useState<Page>('root');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const titleId = useId();

  const workspaceId = workspace.id;
  const slug = workspace.slug;
  const routePrefix = routeTeamPrefix(location.pathname, location.search);
  const issueKey = routeIssueKey(location.pathname);
  const team = currentOrFirstTeam(teams, routePrefix);

  const deferred = useDeferredValue(term).trim();
  const isKey = page === 'root' && isIssueKey(deferred);
  const isPartialKey = isPartialIssueKey(deferred);
  const indexable = hasIndexableTerm(deferred);
  const enabled =
    page === 'root' &&
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

  const issueActions = useMemo<Command[]>(() => {
    const actions: Command[] = registered
      .filter((shortcut) => shortcut.scope === 'issue')
      .map((shortcut) => ({
        id: `issue-action-${shortcut.id}`,
        label: shortcut.label,
        hint: shortcutHint(shortcut.keys),
        icon: <LuZap className={ICON} />,
        run: () => {
          shortcut.run();
        },
      }));
    if (issueKey !== null) {
      actions.push({
        id: 'issue-copy-link',
        label: 'Copy issue link',
        keywords: 'url share',
        hint: issueKey,
        icon: <LuLink className={ICON} />,
        run: () => {
          void globalThis.navigator.clipboard
            .writeText(
              `${globalThis.location.origin}${issuePath(slug, issueKey)}`
            )
            .catch(() => undefined);
        },
      });
    }
    return actions;
  }, [registered, issueKey, slug]);

  const actions = useMemo<Command[]>(() => {
    const built: Command[] = [];
    if (createIssue.canCreate) {
      built.push({
        id: 'action-create-issue',
        label: 'Create issue',
        keywords: 'new',
        hint: 'C',
        icon: <LuSquarePen className={ICON} />,
        run: () => {
          createIssue.open();
        },
      });
    }
    if (createTeam.canCreate) {
      built.push({
        id: 'action-create-team',
        label: 'Create team',
        keywords: 'new add',
        icon: <LuUsersRound className={ICON} />,
        run: createTeam.open,
      });
    }
    if (teams.length > 1) {
      built.push({
        id: 'action-switch-team',
        label: 'Switch team',
        keywords: 'change',
        icon: <LuArrowLeftRight className={ICON} />,
        page: 'teams',
      });
    }
    for (const option of THEMES) {
      if (option.theme === theme) continue;
      built.push({
        id: `action-theme-${option.theme}`,
        label: option.label,
        keywords: 'toggle theme appearance',
        icon: option.icon,
        run: () => {
          setTheme(option.theme);
        },
      });
    }
    if (onShowShortcuts !== undefined) {
      built.push({
        id: 'action-shortcuts',
        label: 'Keyboard shortcuts',
        keywords: 'help keys',
        hint: '?',
        icon: <LuKeyboard className={ICON} />,
        run: onShowShortcuts,
      });
    }
    return built;
  }, [createIssue, createTeam, teams.length, theme, setTheme, onShowShortcuts]);

  const places = useMemo<Command[]>(() => {
    const built: Command[] = [
      {
        id: 'nav-my-issues',
        label: 'My issues',
        hint: 'G then M',
        icon: <LuUserRound className={ICON} />,
        to: myIssuesPath(slug),
      },
      {
        id: 'nav-inbox',
        label: 'Inbox',
        hint: 'G then I',
        icon: <LuInbox className={ICON} />,
        to: inboxPath(slug),
      },
      {
        id: 'nav-projects',
        label: 'Projects',
        hint: 'G then P',
        icon: <LuTarget className={ICON} />,
        to: projectsPath(slug),
      },
    ];
    if (team !== undefined) {
      built.push({
        id: 'nav-cycles',
        label: `${team.name} cycles`,
        keywords: 'cycles',
        hint: 'G then C',
        icon: <LuRefreshCcw className={ICON} />,
        to: teamCyclesPath(slug, team.key_prefix),
      });
    }
    built.push(
      {
        id: 'nav-roadmap',
        label: 'Roadmap',
        hint: 'G then R',
        icon: <LuMap className={ICON} />,
        to: roadmapPath(slug),
      },
      {
        id: 'nav-views',
        label: 'Views',
        hint: 'G then V',
        icon: <LuLayers className={ICON} />,
        to: viewsPath(slug),
      },
      {
        id: 'nav-search',
        label: 'Search',
        hint: '/',
        icon: <LuSearch className={ICON} />,
        to: searchPath(slug),
      },
      {
        id: 'nav-settings',
        label: 'Settings',
        hint: 'G then S',
        icon: <LuSettings className={ICON} />,
        to: settingsLanding(workspace),
      },
      {
        id: 'nav-settings-teams',
        label: 'Manage teams',
        keywords: 'settings teams',
        icon: <LuUsers className={ICON} />,
        to: settingsTeamsPath(slug),
      },
      ...teams.map((row) => ({
        id: `nav-team-${row.id}`,
        label: `Go to ${row.name}`,
        hint: row.key_prefix,
        icon: <LuUsers className={ICON} />,
        to: teamPath(slug, row.key_prefix),
      }))
    );
    return built;
  }, [slug, team, teams, workspace]);

  const teamSettings = useMemo<Command[]>(
    () =>
      teams.map((row) => ({
        id: `settings-team-${row.id}`,
        label: `${row.name} settings`,
        keywords: 'team settings members labels statuses workflow',
        hint: row.key_prefix,
        icon: <LuSettings className={ICON} />,
        to: teamSettingsPath(slug, row.key_prefix),
      })),
    [teams, slug]
  );

  const groups = useMemo<CommandGroup[]>(() => {
    if (page === 'teams') {
      const rows = teams
        .map((row) => ({
          id: `switch-${row.id}`,
          label: row.name,
          hint: row.key_prefix,
          icon: <LuUsers className={ICON} />,
          to: switchTeamPath(
            location.pathname,
            slug,
            routePrefix,
            row.key_prefix
          ),
        }))
        .filter((command) => matches(command, deferred));
      return rows.length === 0
        ? []
        : [{ heading: 'Switch team', commands: rows }];
    }

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

    const current = issueActions.filter((command) =>
      matches(command, deferred)
    );
    if (current.length > 0) {
      built.push({
        heading: issueKey === null ? 'Current issue' : issueKey,
        commands: current,
      });
    }

    const results = data ?? [];
    if (!isKey && enabled && results.length > 0) {
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

    const doable = actions.filter((command) => matches(command, deferred));
    if (deferred === '' && routePrefix !== null) {
      const here = teams.find((row) => row.key_prefix === routePrefix);
      if (here !== undefined) {
        doable.push({
          id: `settings-current-${here.id}`,
          label: `${here.name} settings`,
          hint: here.key_prefix,
          icon: <LuSettings className={ICON} />,
          to: teamSettingsPath(slug, here.key_prefix),
        });
      }
    }
    if (doable.length > 0) built.push({ heading: 'Actions', commands: doable });

    const going = places.filter((command) => matches(command, deferred));
    if (going.length > 0) built.push({ heading: 'Go to', commands: going });

    if (deferred !== '') {
      const settings = teamSettings.filter((command) =>
        matches(command, deferred)
      );
      if (settings.length > 0) {
        built.push({ heading: 'Team settings', commands: settings });
      }
    }

    return built;
  }, [
    page,
    teams,
    location.pathname,
    slug,
    routePrefix,
    deferred,
    isKey,
    issueActions,
    issueKey,
    data,
    enabled,
    actions,
    places,
    teamSettings,
  ]);

  const flat = useMemo(
    () => groups.flatMap((group) => group.commands),
    [groups]
  );

  const index = flat.length === 0 ? 0 : Math.min(active, flat.length - 1);
  const current = flat[index];

  const enterPage = useCallback((next: Page) => {
    setPage(next);
    setTerm('');
    setActive(0);
    input.current?.focus();
  }, []);

  const activate = useCallback(
    (command: Command) => {
      if (command.page !== undefined) {
        enterPage(command.page);
        return;
      }
      onClose();
      if (command.to !== undefined) {
        void navigate(command.to);
        return;
      }
      const run = command.run;
      if (run !== undefined) globalThis.setTimeout(run, 0);
    },
    [enterPage, navigate, onClose]
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
    const previous = document.activeElement as HTMLElement | null;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    input.current?.focus();
    return () => {
      document.body.style.overflow = bodyOverflow;
      previous?.focus();
    };
  }, []);

  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>(
      '[data-active="true"]'
    );
    if (typeof row?.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [index, flat.length]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'Backspace' && term === '' && page !== 'root') {
      event.preventDefault();
      enterPage('root');
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
      if (current !== undefined) activate(current);
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      input.current?.focus();
    }
  };

  const empty =
    page === 'root' && deferred !== '' && !isKey && !indexable
      ? `Search needs a word of at least ${String(MIN_TERM)} letters.`
      : isLoading && enabled
        ? 'Searching'
        : 'Nothing matched that.';

  const placeholder =
    page === 'teams' ? 'Switch to a team' : 'Type a command or search';

  let cursor = -1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh] pb-6 backdrop-blur-[2px] dark:bg-black/60"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="flex max-h-[60vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-line bg-overlay shadow-overlay"
      >
        <h2 id={titleId} className="sr-only">
          Command palette
        </h2>
        {page !== 'root' && (
          <div className="flex shrink-0 items-center gap-1 px-3 pt-2.5">
            <button
              type="button"
              onClick={() => {
                enterPage('root');
              }}
              className="inline-flex h-5 items-center gap-1 rounded-xs bg-raised px-1.5 text-2xs text-text-muted hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
            >
              <LuChevronLeft aria-hidden="true" className="h-3 w-3" />
              Switch team
            </button>
          </div>
        )}
        <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-line px-3.5">
          <LuSearch aria-hidden="true" className="h-4 w-4 text-text-faint" />
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-label={placeholder}
            aria-autocomplete="list"
            {...(current === undefined
              ? {}
              : { 'aria-activedescendant': `${listId}-${current.id}` })}
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
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
                <li key={group.heading} role="presentation">
                  <div
                    role="presentation"
                    className="px-3.5 pt-2 pb-1 text-xs text-text-faint"
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
                            activate(command);
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

/** The palette, rendered only while it is open. */
export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  ...props
}) => (open ? <PaletteBody {...props} /> : null);

export default CommandPalette;
