/**
 * The shortcut panel: that bindings sharing a heading and a label share one
 * row, that arrow keys read as arrows, that the rename and comment keys are
 * listed under Issue, that the search filters by label,
 * heading and key, that the page's own headings come first, that the status
 * position keys share one row, and that `?` and Escape open and close it.
 */

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  createShortcutRegistry,
  ShortcutRegistryContext,
  useShortcut,
} from '../../hooks/useShortcuts';
import type { ShortcutScope } from '../../hooks/useShortcuts';
import ShortcutHelp from './ShortcutHelp';
import ShortcutProvider from './ShortcutProvider';

/** The bindings the registry holds for the listing tests. */
const BINDINGS: [string, string, string, ShortcutScope][] = [
  ['j', 'Next issue', 'List', 'global'],
  ['arrowdown', 'Next issue', 'List', 'global'],
  ['k', 'Previous issue', 'List', 'global'],
  ['shift+d', 'Change due date', 'Issue', 'issue'],
  ['d', 'Duplicate issue', 'Issue', 'issue'],
  ['shift+b', 'Copy git branch name', 'Issue', 'issue'],
  ['r', 'Rename issue', 'Issue', 'issue'],
  ['mod+m', 'Add a comment', 'Issue', 'issue'],
  ['g i', 'Go to inbox', 'Navigation', 'global'],
];

/** Renders the open panel over a registry holding {@link BINDINGS}. */
const renderHelp = () => {
  const registry = createShortcutRegistry();
  BINDINGS.forEach(([keys, label, group, scope], at) => {
    registry.register({
      id: `${keys}-${String(at)}`,
      keys,
      label,
      scope,
      group,
      run: vi.fn(),
      order: at,
    });
  });
  const user = userEvent.setup();
  render(
    <ShortcutRegistryContext.Provider value={registry}>
      <ShortcutHelp open onClose={vi.fn()} />
    </ShortcutRegistryContext.Provider>
  );
  return user;
};

/** The headings the panel shows, in order. */
const headings = (): string[] =>
  screen
    .getAllByRole('region')
    .map((region) => region.getAttribute('aria-label') ?? '');

/** A shell that opens the panel on `?`, as the workspace layout does. */
const Shell: React.FC = () => {
  const [open, setOpen] = useState(false);
  useShortcut({
    keys: '?',
    label: 'Show keyboard shortcuts',
    handler: () => {
      setOpen(true);
    },
  });
  return (
    <ShortcutHelp
      open={open}
      onClose={() => {
        setOpen(false);
      }}
    />
  );
};

/** Renders the shell inside a live provider. */
const renderShell = () => {
  const user = userEvent.setup();
  render(
    <ShortcutProvider>
      <Shell />
    </ShortcutProvider>
  );
  return user;
};

/** The panel, or null when it is closed. */
const panel = () =>
  screen.queryByRole('complementary', { name: 'Keyboard shortcuts' });

/** Moves focus out of the search, onto the page behind the panel. */
const blurSearch = () => {
  act(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
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

  it('shows a sequence as two caps with then between them', () => {
    renderHelp();
    const row = screen.getByText('Go to inbox').closest('li');
    if (row === null) throw new Error('no row');

    expect(within(row).getByText('G').tagName).toBe('KBD');
    expect(within(row).getByText('I').tagName).toBe('KBD');
    expect(within(row).getByText('then')).toBeInTheDocument();
  });

  it("lists the page's own headings before the app-wide ones", () => {
    renderHelp();

    const order = headings();
    expect(order.indexOf('Issue')).toBeLessThan(order.indexOf('General'));
    expect(order.indexOf('List')).toBeLessThan(order.indexOf('Navigation'));
    expect(order).toContain('This panel');
    expect(
      within(screen.getByRole('region', { name: 'Issue' })).getByText(
        'This page'
      )
    ).toBeInTheDocument();
  });

  it('lists its own close keys', () => {
    renderHelp();
    const row = within(screen.getByRole('region', { name: 'This panel' }))
      .getByText('Close this panel')
      .closest('li');
    if (row === null) throw new Error('no row');

    expect(within(row).getByText('?')).toBeInTheDocument();
    expect(within(row).getByText('Esc')).toBeInTheDocument();
  });

  it('lists the attach chord under Editor', () => {
    renderHelp();
    const row = within(screen.getByRole('region', { name: 'Editor' }))
      .getByText('Attach a file or image')
      .closest('li');
    if (row === null) throw new Error('no row');

    expect(within(row).getByText('U')).toBeInTheDocument();
  });

  it('focuses the search on open', () => {
    renderHelp();

    expect(
      screen.getByRole('searchbox', { name: 'Search shortcuts' })
    ).toHaveFocus();
  });

  it('finds a chord by its key names', async () => {
    const user = renderHelp();

    await user.type(screen.getByRole('searchbox'), 'shift d');

    expect(screen.getByText('Change due date')).toBeInTheDocument();
    expect(screen.queryByText('Duplicate issue')).toBeNull();
    expect(screen.queryByText('Copy git branch name')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Navigation' })).toBeNull();
  });

  it('lists the rename and comment keys under Issue', async () => {
    const user = renderHelp();
    const issue = screen.getByRole('region', { name: 'Issue' });
    const rename = within(issue).getByText('Rename issue').closest('li');
    if (rename === null) throw new Error('no row');
    expect(within(rename).getByText('R')).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox'), 'cmd m');

    expect(screen.getByText('Add a comment')).toBeInTheDocument();
    expect(screen.queryByText('Rename issue')).toBeNull();
  });

  it('filters by label and by heading', async () => {
    const user = renderHelp();
    const search = screen.getByRole('searchbox');

    await user.type(search, 'branch');
    expect(headings()).toEqual(['Issue']);
    expect(screen.getByText('Copy git branch name')).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, 'navigation');
    expect(headings()).toEqual(['Navigation']);
  });

  it('says when nothing matches', async () => {
    const user = renderHelp();

    await user.type(screen.getByRole('searchbox'), 'zzzz');

    expect(screen.queryAllByRole('region')).toHaveLength(0);
    expect(screen.getByText(/No shortcuts match/)).toBeInTheDocument();
  });

  it('opens on ? and closes on ? again from the search', async () => {
    const user = renderShell();

    await user.keyboard('?');
    expect(panel()).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveFocus();

    await user.keyboard('?');
    expect(panel()).toBeNull();
  });

  it('closes on ? from the page behind it', async () => {
    const user = renderShell();

    await user.keyboard('?');
    blurSearch();
    await user.keyboard('?');

    expect(panel()).toBeNull();
  });

  it('closes on Escape from the search and from the page', async () => {
    const user = renderShell();

    await user.keyboard('?');
    await user.keyboard('{Escape}');
    expect(panel()).toBeNull();

    await user.keyboard('?');
    blurSearch();
    await user.keyboard('{Escape}');
    expect(panel()).toBeNull();
  });

  it('types ? into a search that already holds text', async () => {
    const user = renderShell();

    await user.keyboard('?');
    await user.keyboard('a?');

    expect(panel()).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('a?');
  });

  it('leaves the page outside a modal', async () => {
    const user = renderShell();

    await user.keyboard('?');

    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });

  it('lists the Cmd or Ctrl+Alt digit status keys as one row', () => {
    const registry = createShortcutRegistry();
    [1, 2, 3].forEach((position) => {
      registry.register({
        id: `status-${String(position)}`,
        keys: `mod+alt+${String(position)}`,
        label: `Set status ${String(position)}`,
        scope: 'issue',
        group: 'Issue',
        run: vi.fn(),
        order: position,
      });
    });
    render(
      <ShortcutRegistryContext.Provider value={registry}>
        <ShortcutHelp open onClose={vi.fn()} />
      </ShortcutRegistryContext.Provider>
    );

    const issue = screen.getByRole('region', { name: 'Issue' });
    expect(within(issue).getAllByText('Set status 1 to 9')).toHaveLength(1);
    expect(within(issue).queryByText('Set status 2')).toBeNull();
    const row = within(issue).getByText('Set status 1 to 9').closest('li');
    if (row === null) throw new Error('no row');
    expect(within(row).getByText('1-9').tagName).toBe('KBD');
  });
});
