/**
 * The keyboard shortcut panel `?` opens: a sheet docked to the right that
 * leaves the page usable behind it, with a search box that filters by label,
 * heading and key. It lists what the registry holds right now, so a page's
 * own shortcuts appear while that page is open and are listed first, plus the
 * few keys handled outside the registry (the palette and Escape), which are
 * fixed, and in the desktop app the tab keys its shell handles. Bindings that
 * share a heading and a label, such as J and the down arrow, share one row.
 */

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { LuSearch, LuX } from 'react-icons/lu';
import {
  displayKeys,
  useRegisteredShortcuts,
  useShortcut,
} from '../../hooks/useShortcuts';
import type { ShortcutScope } from '../../hooks/useShortcuts';
import { IconButton } from '../ui/button';
import { desktopHasTabs } from '../../lib/desktop';
import { modKeyLabel } from '../../lib/platform';

/** Props for ShortcutHelp. */
export interface ShortcutHelpProps {
  open: boolean;
  onClose: () => void;
}

/** One way to press a row's action: the caps of each step, and its search words. */
interface Binding {
  steps: string[][];
  words: string[];
}

/** One row of the panel: an action and every binding that runs it. */
interface HelpRow {
  id: string;
  label: string;
  scope: ShortcutScope;
  bindings: Binding[];
}

/** One heading of the panel and its rows. */
interface HelpGroup {
  name: string;
  rows: HelpRow[];
  local: boolean;
}

/** The heading the panel's own keys are listed under. */
const PANEL_GROUP = 'This panel';

/** Other names a key is searched by, so "shift d" or "cmd k" find it. */
const ALIASES: Record<string, string[]> = {
  mod: ['ctrl', 'cmd', 'command'],
  '⌘': ['cmd', 'command', 'mod'],
  ctrl: ['control', 'mod'],
  '⇧': ['shift'],
  alt: ['option', 'opt'],
  '⌥': ['alt', 'option', 'opt'],
  escape: ['esc'],
  esc: ['escape'],
  enter: ['return'],
  arrowdown: ['down', 'arrow'],
  arrowup: ['up', 'arrow'],
  arrowleft: ['left', 'arrow'],
  arrowright: ['right', 'arrow'],
  '↓': ['down', 'arrow'],
  '↑': ['up', 'arrow'],
  '←': ['left', 'arrow'],
  '→': ['right', 'arrow'],
};

/** Every word a list of key names is searched by. */
const keyWords = (names: string[]): string[] =>
  names
    .map((name) => name.toLowerCase())
    .filter((name) => name !== '')
    .flatMap((name) => [name, ...(ALIASES[name] ?? [])]);

/** A binding from a registry `keys` string. */
const fromKeys = (keys: string): Binding => {
  const steps = displayKeys(keys).map((step) => step.split(' '));
  return {
    steps,
    words: keyWords([...keys.split(/[\s+]+/), ...steps.flat()]),
  };
};

/** A binding of one chord, from the caps it shows. */
const fromCaps = (caps: string[]): Binding => ({
  steps: [caps],
  words: keyWords(caps),
});

/** A fixed row and the bindings that run it. */
const fixedRow = (id: string, label: string, bindings: Binding[]): HelpRow => ({
  id,
  label,
  scope: 'global',
  bindings,
});

/** The keys bound outside the registry, which always apply. */
const fixedGroups = (): HelpGroup[] => {
  const mod = modKeyLabel();
  const groups: HelpGroup[] = [
    {
      name: 'General',
      local: false,
      rows: [
        fixedRow('fixed-palette', 'Open the command palette', [
          fromKeys('mod+k'),
        ]),
        fixedRow('fixed-escape', 'Close a dialog or menu', [
          fromKeys('escape'),
        ]),
      ],
    },
    {
      name: PANEL_GROUP,
      local: false,
      rows: [
        fixedRow('panel-close', 'Close this panel', [
          fromKeys('?'),
          fromKeys('escape'),
        ]),
      ],
    },
  ];
  if (desktopHasTabs()) {
    groups.push({
      name: 'Tabs',
      local: false,
      rows: [
        fixedRow('tabs-new', 'New tab', [fromCaps([mod, 'T'])]),
        fixedRow('tabs-close', 'Close tab', [fromCaps([mod, 'W'])]),
        fixedRow('tabs-reopen', 'Reopen closed tab', [
          fromCaps([mod, 'Shift', 'T']),
        ]),
        fixedRow('tabs-select', 'Go to tab 1 to 8', [fromCaps([mod, '1-8'])]),
        fixedRow('tabs-last', 'Go to the last tab', [fromCaps([mod, '9'])]),
        fixedRow('tabs-next', 'Next tab', [fromCaps(['Ctrl', 'Tab'])]),
        fixedRow('tabs-previous', 'Previous tab', [
          fromCaps(['Ctrl', 'Shift', 'Tab']),
        ]),
      ],
    });
  }
  return groups;
};

/** The headings every workspace page has; any other comes from the page in view. */
const APP_WIDE = ['General', 'Navigation', 'Open', 'Tabs', PANEL_GROUP];

/** The order page headings appear in; anything else follows alphabetically. */
const PAGE_ORDER = ['Issue', 'List', 'Board'];

/** Where a heading sorts: the page's own first, then the app-wide ones. */
const rank = (group: HelpGroup): number => {
  if (group.local) {
    const at = PAGE_ORDER.indexOf(group.name);
    return at === -1 ? PAGE_ORDER.length : at;
  }
  return PAGE_ORDER.length + 1 + APP_WIDE.indexOf(group.name);
};

/** The words of a piece of text, for prefix matching. */
const textWords = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');

/**
 * Whether a row matches a search: the whole query inside its label or
 * heading, or every word of the query starting a word of its label, its
 * heading or its keys.
 */
export const rowMatches = (
  row: HelpRow,
  group: string,
  query: string
): boolean => {
  const wanted = query.trim().toLowerCase();
  if (wanted === '') return true;
  if (
    row.label.toLowerCase().includes(wanted) ||
    group.toLowerCase().includes(wanted)
  ) {
    return true;
  }
  const haystack = [
    ...textWords(row.label),
    ...textWords(group),
    ...row.bindings.flatMap((binding) => binding.words),
  ];
  return wanted
    .split(/[\s+]+/)
    .filter((word) => word !== '')
    .every((word) => haystack.some((candidate) => candidate.startsWith(word)));
};

/** How one binding reads: each step's caps, with "then" between steps. */
const KeyCaps: React.FC<{ steps: string[][] }> = ({ steps }) => (
  <span className="flex shrink-0 items-center gap-1">
    {steps.map((caps, at) => (
      <React.Fragment key={`${caps.join('+')}-${String(at)}`}>
        {at > 0 && <span className="text-2xs text-text-faint">then</span>}
        {caps.map((cap, capAt) => (
          <kbd
            key={`${cap}-${String(capAt)}`}
            className="inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-line bg-surface px-1 font-sans text-2xs text-text-muted"
          >
            {cap}
          </kbd>
        ))}
      </React.Fragment>
    ))}
  </span>
);

/** The open panel: its search, its keys, and the filtered list. */
const ShortcutPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const registered = useRegisteredShortcuts();
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const titleId = useId();

  useShortcut({
    keys: '?',
    label: 'Close this panel',
    scope: 'page',
    group: PANEL_GROUP,
    handler: onClose,
  });
  useShortcut({
    keys: 'escape',
    label: 'Close this panel',
    scope: 'page',
    group: PANEL_GROUP,
    handler: onClose,
  });

  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    search.current?.focus();
    return () => {
      if (previous?.isConnected === true) previous.focus();
    };
  }, []);

  const groups = useMemo(() => {
    const byGroup = new Map<string, HelpGroup>();
    for (const fixed of fixedGroups()) {
      byGroup.set(fixed.name, {
        ...fixed,
        rows: fixed.rows.map((row) => ({ ...row })),
      });
    }
    for (const shortcut of registered) {
      if (shortcut.keys === 'escape' || shortcut.keys === '') continue;
      if (shortcut.group === PANEL_GROUP) continue;
      const group = byGroup.get(shortcut.group) ?? {
        name: shortcut.group,
        rows: [],
        local: !APP_WIDE.includes(shortcut.group),
      };
      const binding = fromKeys(shortcut.keys);
      const same = group.rows.find((row) => row.label === shortcut.label);
      if (same === undefined) {
        group.rows.push({
          id: shortcut.id,
          label: shortcut.label,
          scope: shortcut.scope,
          bindings: [binding],
        });
      } else {
        same.bindings = [...same.bindings, binding];
        if (shortcut.scope !== 'global') same.scope = shortcut.scope;
      }
      if (shortcut.scope !== 'global') group.local = true;
      byGroup.set(shortcut.group, group);
    }
    return [...byGroup.values()].sort(
      (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)
    );
  }, [registered]);

  const visible = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          rows: group.rows.filter((row) => rowMatches(row, group.name, query)),
        }))
        .filter((group) => group.rows.length > 0),
    [groups, query]
  );

  return (
    <aside
      aria-labelledby={titleId}
      className="fixed inset-y-0 right-0 z-40 flex w-[360px] max-w-full flex-col border-l border-line bg-overlay pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-overlay"
    >
      <div className="flex h-topbar shrink-0 items-center gap-2 px-4">
        <h2
          id={titleId}
          className="min-w-0 flex-1 truncate text-sm font-medium"
        >
          Keyboard shortcuts
        </h2>
        <IconButton label="Close" size="sm" onClick={onClose}>
          <LuX className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      <div className="shrink-0 border-b border-line px-4 pb-3">
        <label className="relative block">
          <span className="sr-only">Search shortcuts</span>
          <LuSearch
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-text-faint"
          />
          <input
            ref={search}
            type="search"
            value={query}
            placeholder="Search shortcuts"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (
                event.key === 'Escape' ||
                (event.key === '?' && query === '')
              ) {
                event.preventDefault();
                event.stopPropagation();
                onClose();
              }
            }}
            className="h-8 w-full rounded-sm border border-line-strong bg-bg pr-2.5 pl-8 text-sm text-text transition-colors duration-100 placeholder:text-text-faint hover:border-text-faint focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent [&::-webkit-search-cancel-button]:hidden"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        {visible.length === 0 ? (
          <p className="py-10 text-center text-sm text-text-muted">
            No shortcuts match &ldquo;{query.trim()}&rdquo;.
          </p>
        ) : (
          <div className="space-y-5">
            {visible.map((group) => (
              <section key={group.name} aria-label={group.name}>
                <h3 className="flex items-center gap-2 pb-1.5 text-xs font-medium text-text-faint">
                  {group.name}
                  {group.local && (
                    <span className="rounded-xs bg-surface px-1 text-2xs text-text-muted">
                      This page
                    </span>
                  )}
                </h3>
                <ul className="space-y-1">
                  {group.rows.map((row) => (
                    <li
                      key={row.id}
                      className="flex min-h-7 items-center justify-between gap-3 text-sm"
                    >
                      <span className="min-w-0 truncate text-text">
                        {row.label}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {row.bindings.map((binding, at) => (
                          <React.Fragment
                            key={binding.steps
                              .map((s) => s.join('+'))
                              .join(' ')}
                          >
                            {at > 0 && (
                              <span className="text-2xs text-text-faint">
                                or
                              </span>
                            )}
                            <KeyCaps steps={binding.steps} />
                          </React.Fragment>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
};

/** The side panel listing every shortcut, grouped and searchable. */
export const ShortcutHelp: React.FC<ShortcutHelpProps> = ({ open, onClose }) =>
  open ? <ShortcutPanel onClose={onClose} /> : null;

export default ShortcutHelp;
