/**
 * The keyboard shortcut overlay `?` opens. It lists what the registry holds
 * right now, so a page's own shortcuts appear while that page is open and
 * disappear when it is not, plus the few keys handled outside the registry
 * (the palette and list movement), which are fixed.
 */

import React, { useMemo } from 'react';
import { displayKeys, useRegisteredShortcuts } from '../../hooks/useShortcuts';
import Dialog from '../ui/dialog';
import { modKeyLabel } from '../../lib/platform';

/** Props for ShortcutHelp. */
export interface ShortcutHelpProps {
  open: boolean;
  onClose: () => void;
}

/** One row of the overlay. */
interface HelpRow {
  id: string;
  label: string;
  keys: string[];
}

/** The keys bound outside the registry, which always apply. */
const FIXED: { group: string; rows: HelpRow[] }[] = [
  {
    group: 'General',
    rows: [
      {
        id: 'fixed-palette',
        label: 'Open the command palette',
        keys: [modKeyLabel(), 'K'],
      },
      { id: 'fixed-escape', label: 'Close a dialog or menu', keys: ['Esc'] },
    ],
  },
  {
    group: 'Lists',
    rows: [
      { id: 'fixed-down', label: 'Move down', keys: ['J'] },
      { id: 'fixed-up', label: 'Move up', keys: ['K'] },
      {
        id: 'fixed-open',
        label: 'Open the highlighted issue',
        keys: ['Enter'],
      },
    ],
  },
];

/** The order headings appear in; anything else follows alphabetically. */
const ORDER = ['General', 'Navigation', 'Issue', 'Lists'];

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
    const byGroup = new Map<string, (HelpRow & { sequence: boolean })[]>();
    for (const fixed of FIXED) {
      byGroup.set(
        fixed.group,
        fixed.rows.map((row) => ({ ...row, sequence: false }))
      );
    }
    for (const shortcut of registered) {
      if (shortcut.keys === 'escape') continue;
      const rows = byGroup.get(shortcut.group) ?? [];
      rows.push({
        id: shortcut.id,
        label: shortcut.label,
        keys: displayKeys(shortcut.keys),
        sequence: shortcut.keys.includes(' '),
      });
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
                  <KeyCaps keys={row.keys} sequence={row.sequence} />
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
