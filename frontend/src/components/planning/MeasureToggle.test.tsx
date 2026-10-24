/**
 * The issues and points switch. Covers that it marks the measure shown,
 * reports a choice, and keeps an unavailable measure visible but inert with
 * its reason as the description.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import MeasureToggle from './MeasureToggle';

describe('MeasureToggle', () => {
  it('marks the measure shown and reports a choice', async () => {
    const onChange = vi.fn();
    render(<MeasureToggle value="issues" onChange={onChange} />);

    expect(screen.getByRole('button', { name: 'Issues' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Points' }));

    expect(onChange).toHaveBeenCalledWith('points');
  });

  it('keeps an unavailable measure inert and says why', async () => {
    const onChange = vi.fn();
    render(
      <MeasureToggle
        value="issues"
        onChange={onChange}
        unavailable={{ points: 'No estimates here.' }}
      />
    );

    const points = screen.getByRole('button', { name: 'Points' });
    expect(points).toHaveAttribute('aria-disabled', 'true');
    expect(points).toHaveAccessibleDescription('No estimates here.');
    expect(screen.getByRole('button', { name: 'Issues' })).not.toHaveAttribute(
      'aria-disabled'
    );

    await userEvent.click(points);

    expect(onChange).not.toHaveBeenCalled();
  });
});
