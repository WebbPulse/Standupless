/**
 * The shortcut overlay: that bindings sharing a heading and a label share one
 * row, and that arrow keys read as arrows rather than their raw names.
 */

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  createShortcutRegistry,
  ShortcutRegistryContext,
} from '../../hooks/useShortcuts';
import ShortcutHelp from './ShortcutHelp';

/** Renders the overlay over a registry holding the list's movement keys. */
const renderHelp = () => {
  const registry = createShortcutRegistry();
  const bindings: [string, string][] = [
    ['j', 'Next issue'],
    ['arrowdown', 'Next issue'],
    ['k', 'Previous issue'],
  ];
  bindings.forEach(([keys, label], at) => {
    registry.register({
      id: `${keys}-${String(at)}`,
      keys,
      label,
      scope: 'global',
      group: 'List',
      run: vi.fn(),
      order: at,
    });
  });
  render(
    <ShortcutRegistryContext.Provider value={registry}>
      <ShortcutHelp open onClose={vi.fn()} />
    </ShortcutRegistryContext.Provider>
  );
};

describe('ShortcutHelp', () => {
  it('lists each list action once, with every key that runs it', () => {
    renderHelp();
    const list = screen.getByRole('region', { name: 'List' });

    expect(within(list).getAllByText('Next issue')).toHaveLength(1);
    const row = within(list).getByText('Next issue').closest('li');
    if (row === null) throw new Error('no row');
    expect(within(row).getByText('J')).toBeInTheDocument();
    expect(within(row).getByText('↓')).toBeInTheDocument();
    expect(within(row).getByText('or')).toBeInTheDocument();
  });

  it('keeps no second, fixed list heading beside the registry one', () => {
    renderHelp();

    expect(screen.queryByRole('region', { name: 'Lists' })).toBeNull();
    expect(screen.queryByText('arrowdown')).toBeNull();
  });
});
