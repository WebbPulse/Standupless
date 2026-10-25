/**
 * The "Set status" dialog: a preset fills every field, saving sends the end
 * the "Clear after" choice works out, an empty status cannot be saved, and a
 * status that is set can be cleared.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { MyStatus } from '../../hooks/useMyStatus';
import type { UserStatusRead } from '../../types/Api';
import UserStatusDialog from './UserStatusDialog';

/** A status control whose writes succeed, holding `status`. */
const control = (status: UserStatusRead | null = null): MyStatus => ({
  status,
  saving: false,
  error: null,
  save: vi.fn<MyStatus['save']>(() => Promise.resolve(true)),
  clear: vi.fn<MyStatus['clear']>(() => Promise.resolve(true)),
});

describe('UserStatusDialog', () => {
  it('fills the fields from a preset and saves with its end', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const status = control();
    render(<UserStatusDialog open control={status} onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: /Out sick/ }));

    expect(screen.getByLabelText('Emoji')).toHaveValue('🤒');
    expect(screen.getByLabelText('Status')).toHaveValue('Out sick');
    expect(screen.getByLabelText('Mark me as away')).toBeChecked();
    expect(screen.getByLabelText('Clear after')).toHaveValue('today');

    await user.click(screen.getByRole('button', { name: 'Save status' }));

    expect(status.save).toHaveBeenCalledWith(
      expect.objectContaining({
        emoji: '🤒',
        text: 'Out sick',
        away: true,
        until: expect.any(String) as unknown,
      })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('saves a status that never clears with no end, and refuses an empty one', async () => {
    const user = userEvent.setup();
    const status = control();
    render(<UserStatusDialog open control={status} onClose={vi.fn()} />);

    const save = screen.getByRole('button', { name: 'Save status' });
    expect(save).toBeDisabled();

    await user.type(screen.getByLabelText('Status'), 'Heads down');
    await user.click(save);

    expect(status.save).toHaveBeenCalledWith({
      emoji: '',
      text: 'Heads down',
      away: false,
      until: null,
    });
  });

  it('starts from the current status and clears it', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const status = control({
      emoji: '🎯',
      text: 'Focusing',
      away: false,
      until: null,
      set_at: '2026-10-20T00:00:00Z',
    });
    render(<UserStatusDialog open control={status} onClose={onClose} />);

    expect(screen.getByLabelText('Status')).toHaveValue('Focusing');
    await user.click(screen.getByRole('button', { name: 'Clear status' }));

    expect(status.clear).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('offers no clear when nothing is set', () => {
    render(<UserStatusDialog open control={control()} onClose={vi.fn()} />);

    expect(
      screen.queryByRole('button', { name: 'Clear status' })
    ).not.toBeInTheDocument();
  });
});
