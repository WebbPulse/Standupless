/**
 * The "Remind me" dialog. Covers that a preset sets the reminder and closes,
 * that a custom moment in the past is refused before anything is sent, that a
 * valid custom moment is sent as given, and that a pending reminder shows with
 * a way to cancel it.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { IssueReminder } from '../../hooks/useIssueReminder';
import { fromLocalInput, toLocalInput } from '../../lib/reminders';
import type { IssueReminderRead } from '../../types/Api';
import RemindMeDialog from './RemindMeDialog';

/** A reminder handle whose set and cancel are spies. */
const handle = (
  pending: IssueReminderRead | null = null
): IssueReminder & {
  set: Mock<(moment: Date) => Promise<boolean>>;
  cancel: Mock<() => void>;
} => ({
  reminder: pending,
  set: vi.fn<(moment: Date) => Promise<boolean>>(() => Promise.resolve(true)),
  cancel: vi.fn<() => void>(),
});

const PENDING: IssueReminderRead = {
  issue_id: 'i-1',
  issue_key: 'ENG-1',
  issue_title: 'Follow up',
  team_id: 't-1',
  remind_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  created_at: new Date().toISOString(),
};

describe('RemindMeDialog', () => {
  it('sets the reminder from a preset and closes', async () => {
    const reminder = handle();
    const onClose = vi.fn();
    render(
      <RemindMeDialog
        open
        issueKey="ENG-1"
        reminder={reminder}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Tomorrow morning/ }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(reminder.set).toHaveBeenCalledTimes(1);
    const moment = reminder.set.mock.calls[0]?.[0];
    expect(moment?.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a custom moment in the past', () => {
    const reminder = handle();
    render(
      <RemindMeDialog
        open
        issueKey="ENG-1"
        reminder={reminder}
        onClose={vi.fn()}
      />
    );

    const field = screen.getByLabelText('Custom date and time');
    fireEvent.change(field, {
      target: { value: toLocalInput(new Date(Date.now() - 60 * 60 * 1000)) },
    });
    fireEvent.blur(field);

    expect(screen.getByText('Pick a time in the future.')).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Set reminder',
      }).disabled
    ).toBe(true);
    expect(reminder.set).not.toHaveBeenCalled();
  });

  it('sends a valid custom moment as picked', async () => {
    const reminder = handle();
    const onClose = vi.fn();
    render(
      <RemindMeDialog
        open
        issueKey="ENG-1"
        reminder={reminder}
        onClose={onClose}
      />
    );
    const value = toLocalInput(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000));

    fireEvent.change(screen.getByLabelText('Custom date and time'), {
      target: { value },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set reminder' }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(reminder.set.mock.calls[0]?.[0].getTime()).toBe(
      fromLocalInput(value)?.getTime()
    );
  });

  it('shows a pending reminder and cancels it', () => {
    const reminder = handle(PENDING);
    const onClose = vi.fn();
    render(
      <RemindMeDialog
        open
        issueKey="ENG-1"
        reminder={reminder}
        onClose={onClose}
      />
    );

    expect(screen.getByText(/Reminder set for/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Cancel reminder/ }));

    expect(reminder.cancel).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });
});
