/**
 * The keyboard shortcut overlay `?` opens. It lists what the registry holds
 * right now, so a page's own shortcuts appear while that page is open and
 * disappear when it is not, plus the few keys handled outside the registry
 * (the palette and Escape), which are fixed, and in the desktop app the tab
 * keys its shell handles. Bindings that share a heading
 * and a label, such as J and the down arrow, share one row.
 */

import React, { useMemo } from 'react';
import { displayKeys, useRegisteredShortcuts } from '../../hooks/useShortcuts';
import Dialog from '../ui/dialog';
import { desktopHasTabs } from '../../lib/desktop';
import { modKeyLabel } from '../../lib/platform';

/** Props for ShortcutHelp. */
export interface ShortcutHelpProps {
  open: boolean;
  onClose: () => void;
}

/** One way to press a row's action: its caps, and whether they are a sequence. */
interface Binding {
  keys: string[];
  sequence: boolean;
}

/** One row of the overlay: an action and every binding that runs it. */
interface HelpRow {
  id: string;
  label: string;
  bindings: Binding[];
}

/** The keys bound outside the registry, which always apply. */
const FIXED: { group: string; rows: HelpRow[] }[] = [
  {
    group: 'General',
    rows: [
      {
        id: 'fixed-palette',
        label: 'Open the command palette',
        bindings: [{ keys: [modKeyLabel(), 'K'], sequence: false }],
      },
      {
        id: 'fixed-escape',
        label: 'Close a dialog or menu',
        bindings: [{ keys: ['Esc'], sequence: false }],
      },
    ],
  },
];

/** A fixed row with one chord binding. */
const chordRow = (id: string, label: string, keys: string[]): HelpRow => ({
  id,
  label,
  bindings: [{ keys, sequence: false }],
});

/** The tab keys the desktop app's shell handles, before the page sees them. */
const desktopTabs = (): { group: string; rows: HelpRow[] } => {
  const mod = modKeyLabel();
  return {
    group: 'Tabs',
    rows: [
      chordRow('tabs-new', 'New tab', [mod, 'T']),
      chordRow('tabs-close', 'Close tab', [mod, 'W']),
      chordRow('tabs-reopen', 'Reopen closed tab', [mod, 'Shift', 'T']),
      chordRow('tabs-select', 'Go to tab 1 to 8', [mod, '1-8']),
      chordRow('tabs-last', 'Go to the last tab', [mod, '9']),
      chordRow('tabs-next', 'Next tab', ['Ctrl', 'Tab']),
      chordRow('tabs-previous', 'Previous tab', ['Ctrl', 'Shift', 'Tab']),
    ],
  };
};

/** The order headings appear in; anything else follows alphabetically. */
const ORDER = ['General', 'Navigation', 'Open', 'Issue', 'List', 'Board'];

/** How a key sequence reads: caps joined by "then" for a sequence. */
const KeyCaps: React.FC<{ keys: string[]; sequence: boolean }> = ({
  keys,
  sequence,
}) => (
  <span className="flex shrink-0 items-center gap-1">
    {keys.map((cap, at) => (
      <React.Fragment key={`${cap}-${String(at)}`}>
        {sequence && at > 0 && (
          <span className="text-2xs text-text-faint">then</span>
        )}
        <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-line bg-surface px-1 font-sans text-2xs text-text-muted">
          {cap}
        </kbd>
      </React.Fragment>
    ))}
  </span>
);

/** The overlay listing every shortcut, grouped. */
export const ShortcutHelp: React.FC<ShortcutHelpProps> = ({
  open,
  onClose,
}) => {
  const registered = useRegisteredShortcuts();

  const groups = useMemo(() => {
    const byGroup = new Map<string, HelpRow[]>();
    const fixedGroups = desktopHasTabs() ? [...FIXED, desktopTabs()] : FIXED;
    for (const fixed of fixedGroups) {
      byGroup.set(
        fixed.group,
        fixed.rows.map((row) => ({ ...row }))
      );
    }
    for (const shortcut of registered) {
      if (shortcut.keys === 'escape' || shortcut.keys === '') continue;
      const rows = byGroup.get(shortcut.group) ?? [];
      const binding = {
        keys: displayKeys(shortcut.keys),
        sequence: shortcut.keys.includes(' '),
      };
      const same = rows.find((row) => row.label === shortcut.label);
      if (same === undefined) {
        rows.push({
          id: shortcut.id,
          label: shortcut.label,
          bindings: [binding],
        });
      } else {
        same.bindings = [...same.bindings, binding];
      }
      byGroup.set(shortcut.group, rows);
    }
    const rank = (name: string): number => {
      const at = ORDER.indexOf(name);
      return at === -1 ? ORDER.length : at;
    };
    return [...byGroup.entries()].sort(
      ([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)
    );
  }, [registered]);

  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" size="lg">
      <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
        {groups.map(([group, rows]) => (
          <section key={group} aria-label={group}>
            <h3 className="pb-1.5 text-xs font-medium text-text-faint">
              {group}
            </h3>
            <ul className="space-y-1">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className="flex h-7 items-center justify-between gap-3 text-sm"
                >
                  <span className="min-w-0 truncate text-text">
                    {row.label}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {row.bindings.map((binding, at) => (
                      <React.Fragment key={binding.keys.join(' ')}>
                        {at > 0 && (
                          <span className="text-2xs text-text-faint">or</span>
                        )}
                        <KeyCaps
                          keys={binding.keys}
                          sequence={binding.sequence}
                        />
                      </React.Fragment>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
};

export default ShortcutHelp;
