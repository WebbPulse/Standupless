/**
 * The project and initiative date picker: a coarse tab stores the period's
 * edge beside its resolution, a coarse value reads as its period and reopens
 * on its own tab, and the day tab still sets an exact day.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PlanningDatePicker from './PlanningDatePicker';

describe('PlanningDatePicker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores a quarter target at the last day of the quarter', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PlanningDatePicker
        field="Target date"
        edge="end"
        value="2027-02-10"
        resolution="day"
        onChange={onChange}
      />
    );
    await user.click(screen.getByRole('button', { name: /Target date/ }));
    await user.click(screen.getByRole('tab', { name: 'Quarter' }));
    await user.click(screen.getByRole('button', { name: 'Q3 2027' }));
    expect(onChange).toHaveBeenCalledWith('2027-09-30', 'quarter');
  });

  it('stores a month start at the first day of the month', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PlanningDatePicker
        field="Start date"
        edge="start"
        value="2026-11-20"
        resolution={null}
        onChange={onChange}
      />
    );
    await user.click(screen.getByRole('button', { name: /Start date/ }));
    await user.click(screen.getByRole('tab', { name: 'Month' }));
    await user.click(screen.getByRole('button', { name: 'Nov 2026' }));
    expect(onChange).toHaveBeenCalledWith('2026-11-01', 'month');
  });

  it('reads a coarse value as its period and reopens on its tab', async () => {
    const user = userEvent.setup();
    render(
      <PlanningDatePicker
        field="Target date"
        edge="end"
        value="2027-12-31"
        resolution="half"
        onChange={vi.fn()}
      />
    );
    const trigger = screen.getByRole('button', {
      name: 'Target date: H2 2027',
    });
    await user.click(trigger);
    expect(screen.getByRole('tab', { name: 'Half' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('button', { name: 'H2 2027' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('disables a period that ends before the start date', async () => {
    const user = userEvent.setup();
    render(
      <PlanningDatePicker
        field="Target date"
        edge="end"
        value="2030-12-31"
        resolution="year"
        min="2030-05-01"
        onChange={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button', { name: /Target date/ }));
    await user.click(screen.getByRole('button', { name: 'Earlier years' }));
    expect(screen.getByRole('button', { name: '2029' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Later years' }));
    expect(screen.getByRole('button', { name: '2030' })).toBeEnabled();
  });

  it('clears a coarse date from the day tab', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PlanningDatePicker
        field="Target date"
        edge="end"
        value="2027-12-31"
        resolution="year"
        onChange={onChange}
      />
    );
    await user.click(screen.getByRole('button', { name: /Target date/ }));
    await user.click(screen.getByRole('tab', { name: 'Day' }));
    await user.click(screen.getByRole('option', { name: /Clear date/ }));
    expect(onChange).toHaveBeenCalledWith(null, null);
  });

  it('lists two presets that share a day without a duplicate key', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 29, 12));
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(
      <PlanningDatePicker
        field="Target date"
        edge="end"
        value={null}
        resolution={null}
        onChange={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button', { name: /Target date/ }));
    const tomorrow = screen.getByRole('option', { name: /Tomorrow/ });
    const weekEnd = screen.getByRole('option', { name: /End of this week/ });
    const duplicateKey = errors.mock.calls.some((call) =>
      call.some((part) => String(part).includes('same key'))
    );
    errors.mockRestore();

    expect(String(tomorrow.textContent).replace('Tomorrow', '')).toBe(
      String(weekEnd.textContent).replace('End of this week', '')
    );
    expect(duplicateKey).toBe(false);
  });
});
