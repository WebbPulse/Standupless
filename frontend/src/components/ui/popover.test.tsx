/**
 * The floating panel every picker opens in. Covers that the trigger reports
 * its state, that Escape closes the panel without reaching an enclosing
 * dialog and hands focus back, that Escape still closes it once focus has
 * left the panel, that opening the command palette closes it, and that a click
 * outside closes it.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  CommandPaletteContext,
  useCommandPalette,
} from '../../hooks/useCommandPalette';
import { Popover } from './popover';

/** Holds the palette state the way the workspace shell does. */
const PaletteShell: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const palette = useCommandPalette();
  return (
    <CommandPaletteContext.Provider value={palette}>
      {children}
      {palette.open && <p>Palette open</p>}
    </CommandPaletteContext.Provider>
  );
};

const renderPopover = () =>
  render(
    <PaletteShell>
      <Popover
        label="Menu"
        trigger={(props) => (
          <button type="button" {...props}>
            Open
          </button>
        )}
      >
        {(close) => (
          <div>
            <input aria-label="Inside" autoFocus />
            <button type="button" onClick={close}>
              Done
            </button>
          </div>
        )}
      </Popover>
      <p>Outside</p>
      <button type="button">Elsewhere</button>
    </PaletteShell>
  );

describe('Popover', () => {
  it('opens on click and reports it on the trigger', async () => {
    const user = userEvent.setup();
    renderPopover();
    const trigger = screen.getByRole('button', { name: 'Open' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeInTheDocument();
  });

  it('closes on Escape, keeps it from the document and restores focus', async () => {
    const user = userEvent.setup();
    const onDocument = vi.fn();
    document.addEventListener('keydown', onDocument);
    renderPopover();
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('textbox', { name: 'Inside' })).toHaveFocus();
    await user.keyboard('{Escape}');
    document.removeEventListener('keydown', onDocument);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
    expect(
      onDocument.mock.calls.some(
        ([event]) => (event as KeyboardEvent).key === 'Escape'
      )
    ).toBe(false);
  });

  it('closes on Escape after focus has left the panel', async () => {
    const user = userEvent.setup();
    renderPopover();
    await user.click(screen.getByRole('button', { name: 'Open' }));
    screen.getByRole('button', { name: 'Elsewhere' }).focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus();
  });

  it('closes when the command palette opens', async () => {
    const user = userEvent.setup();
    renderPopover();
    await user.click(screen.getByRole('button', { name: 'Open' }));
    screen.getByRole('button', { name: 'Elsewhere' }).focus();
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.getByText('Palette open')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens from the keyboard with ArrowDown', async () => {
    const user = userEvent.setup();
    renderPopover();
    screen.getByRole('button', { name: 'Open' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeInTheDocument();
  });

  it('closes on a click outside and from the close callback', async () => {
    const user = userEvent.setup();
    renderPopover();
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByText('Outside'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
