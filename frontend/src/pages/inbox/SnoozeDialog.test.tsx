/**
 * The inbox snooze dialog. Covers that the next month preset snoozes a month
 * out, that a custom moment in the past or beyond the 90 day bound is refused
 * inline before anything is sent, that a valid custom moment is sent as picked,
 * and that only a snoozed row offers to unsnooze.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fromLocalInput, toLocalInput } from '../../lib/reminders';
import SnoozeDialog from './SnoozeDialog';

const DAY = 24 * 60 * 60 * 1000;

/** Renders the dialog open with spies for every callback. */
const renderDialog = (snoozed = false) => {
  const onSnooze = vi.fn<(until: Date) => void>();
  const onUnsnooze = vi.fn<() => void>();
  const onClose = vi.fn<() => void>();
  render(
    <SnoozeDialog
      open
      subject="ENG-1"
      snoozed={snoozed}
      onSnooze={onSnooze}
      onUnsnooze={onUnsnooze}
      onClose={onClose}
    />
  );
  return { onSnooze, onUnsnooze, onClose };
};

/** Types a custom moment and leaves the field. */
const typeCustom = (moment: Date) => {
  const field = screen.getByLabelText('Custom date and time');
  const value = toLocalInput(moment);
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
  return value;
};

const submitButton = () =>
  screen.getByRole<HTMLButtonElement>('button', { name: 'Snooze' });

describe('SnoozeDialog', () => {
  it('snoozes a month out from the next month preset', () => {
    const { onSnooze } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: /Next month/ }));

    expect(onSnooze).toHaveBeenCalledTimes(1);
    const until = onSnooze.mock.calls[0]?.[0];
    expect(until?.getTime()).toBeGreaterThan(Date.now() + 27 * DAY);
    expect(until?.getTime()).toBeLessThan(Date.now() + 32 * DAY);
  });

  it('refuses a custom moment in the past', () => {
    const { onSnooze } = renderDialog();

    typeCustom(new Date(Date.now() - 60 * 60 * 1000));

    expect(screen.getByText('Pick a time in the future.')).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
    fireEvent.submit(submitButton());
    expect(onSnooze).not.toHaveBeenCalled();
  });

  it('refuses a custom moment beyond 90 days', () => {
    const { onSnooze } = renderDialog();

    typeCustom(new Date(Date.now() + 120 * DAY));

    expect(
      screen.getByText('Pick a time within the next 90 days.')
    ).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
    fireEvent.submit(submitButton());
    expect(onSnooze).not.toHaveBeenCalled();
  });

  it('sends a valid custom moment as picked', () => {
    const { onSnooze } = renderDialog();

    const value = typeCustom(new Date(Date.now() + 45 * DAY));
    fireEvent.click(submitButton());

    expect(onSnooze).toHaveBeenCalledTimes(1);
    expect(onSnooze.mock.calls[0]?.[0].getTime()).toBe(
      fromLocalInput(value)?.getTime()
    );
  });

  it('offers to unsnooze only a snoozed row', () => {
    const { onUnsnooze } = renderDialog(true);

    fireEvent.click(screen.getByRole('button', { name: 'Unsnooze now' }));

    expect(onUnsnooze).toHaveBeenCalledTimes(1);
  });

  it('offers no unsnooze for a row that is not snoozed', () => {
    renderDialog();

    expect(
      screen.queryByRole('button', { name: 'Unsnooze now' })
    ).not.toBeInTheDocument();
  });
});
