/**
 * The floating panel every picker opens in. Covers that the trigger reports
 * its state, that Escape closes the panel without reaching an enclosing
 * dialog and hands focus back, and that a click outside closes it.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Popover } from './popover';

const renderPopover = () =>
  render(
    <div>
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
    </div>
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
