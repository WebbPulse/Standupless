/**
 * The shared dropdown menu. Covers typeahead filtering: typing hides items
 * that do not match and focuses the first match, Enter picks it, Backspace
 * edits the filter, a page shortcut never sees the typed letters, a filter
 * that matches nothing says so, and Escape closes the menu.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ContextMenu, Menu, MenuItem, MenuLabel, MenuShortcut } from './menu';

const PageShortcut: React.FC<{ onKey: (key: string) => void }> = ({
  onKey,
}) => {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!event.defaultPrevented) onKey(event.key);
    };
    document.addEventListener('keydown', listener);
    return () => {
      document.removeEventListener('keydown', listener);
    };
  }, [onKey]);
  return null;
};

const renderMenu = (onSelect = vi.fn(), onPageKey = vi.fn()) => {
  render(
    <MemoryRouter>
      <PageShortcut onKey={onPageKey} />
      <Menu
        label="Issue actions"
        trigger={(props) => (
          <button type="button" {...props}>
            Actions
          </button>
        )}
      >
        <MenuLabel>Edit</MenuLabel>
        <MenuItem
          onSelect={() => {
            onSelect('assign');
          }}
        >
          Assign to me
          <MenuShortcut keys="i" />
        </MenuItem>
        <MenuItem
          onSelect={() => {
            onSelect('copy');
          }}
        >
          Copy link
        </MenuItem>
        <MenuItem
          onSelect={() => {
            onSelect('archive');
          }}
          textValue="Archive issue"
        >
          Archive
        </MenuItem>
        <MenuItem
          danger
          onSelect={() => {
            onSelect('delete');
          }}
        >
          Delete
        </MenuItem>
      </Menu>
    </MemoryRouter>
  );
  return { onSelect, onPageKey };
};

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'Actions' }));
};

describe('Menu typeahead', () => {
  it('filters to matching items and focuses the first match', async () => {
    const user = userEvent.setup();
    renderMenu();
    await open(user);
    await user.keyboard('co');
    expect(screen.getByRole('menuitem', { name: 'Copy link' })).toHaveFocus();
    expect(screen.queryByRole('menuitem', { name: /Assign/ })).toBeNull();
    expect(screen.queryByText('Edit')).not.toBeVisible();
    expect(screen.getByText('co')).toBeVisible();
  });

  it('prefers an item whose text starts with the filter', async () => {
    const user = userEvent.setup();
    renderMenu();
    await open(user);
    await user.keyboard('a');
    expect(
      screen.getByRole('menuitem', { name: /Assign to me/ })
    ).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
  });

  it('picks the highlighted match on Enter', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderMenu();
    await open(user);
    await user.keyboard('del{Enter}');
    expect(onSelect).toHaveBeenCalledWith('delete');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('matches an item by its textValue', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderMenu();
    await open(user);
    await user.keyboard('issue{Enter}');
    expect(onSelect).toHaveBeenCalledWith('archive');
  });

  it('moves between matches with the arrow keys', async () => {
    const user = userEvent.setup();
    renderMenu();
    await open(user);
    await user.keyboard('a{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toHaveFocus();
  });

  it('edits the filter with Backspace', async () => {
    const user = userEvent.setup();
    renderMenu();
    await open(user);
    await user.keyboard('cx');
    expect(screen.getByText('No matching items')).toBeVisible();
    await user.keyboard('{Backspace}');
    expect(screen.queryByText('No matching items')).not.toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Copy link' })).toHaveFocus();
    await user.keyboard('{Backspace}');
    expect(screen.getAllByRole('menuitem')).toHaveLength(4);
  });

  it('keeps typed letters away from page shortcuts', async () => {
    const user = userEvent.setup();
    const { onPageKey } = renderMenu();
    await open(user);
    await user.keyboard('c');
    expect(onPageKey).not.toHaveBeenCalledWith('c');
  });

  it('closes on Escape and starts fresh when reopened', async () => {
    const user = userEvent.setup();
    renderMenu();
    await open(user);
    await user.keyboard('co{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    await open(user);
    expect(screen.getAllByRole('menuitem')).toHaveLength(4);
  });
});

describe('ContextMenu typeahead', () => {
  it('filters the same way', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ContextMenu x={10} y={10} label="Row actions" onClose={vi.fn()}>
        <MenuItem
          onSelect={() => {
            onSelect('copy');
          }}
        >
          Copy link
        </MenuItem>
        <MenuItem
          onSelect={() => {
            onSelect('delete');
          }}
        >
          Delete
        </MenuItem>
      </ContextMenu>
    );
    await user.keyboard('de{Enter}');
    expect(onSelect).toHaveBeenCalledWith('delete');
  });
});
