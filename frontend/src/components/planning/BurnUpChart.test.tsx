/**
 * The burn-up chart. Covers that its y axis labels are whole numbers that
 * never repeat, that a one-issue cycle reads 0 and 1, and that a cycle whose
 * scope has been empty every day says so instead of drawing an axis.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BurnUpPoint } from '../../lib/planningModel';
import { BurnUpChart, axisTicks } from './BurnUpChart';

const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'];

/** One day of the series. */
const point = (
  date: string,
  scope: number,
  started = 0,
  completed = 0
): BurnUpPoint => ({ date, scope, started, completed });

/** The y axis labels the chart drew, top to bottom as rendered. */
const tickLabels = (): string[] =>
  screen.getAllByTestId('burn-up-tick').map((node) => node.textContent ?? '');

describe('axisTicks', () => {
  it('labels an empty or one-issue axis 0 and 1 only', () => {
    expect(axisTicks(0)).toEqual([0, 1]);
    expect(axisTicks(1)).toEqual([0, 1]);
  });

  it('adds a whole-number midpoint once there is room', () => {
    expect(axisTicks(2)).toEqual([0, 1, 2]);
    expect(axisTicks(3)).toEqual([0, 2, 3]);
    expect(axisTicks(10)).toEqual([0, 5, 10]);
  });

  it('rounds a fractional top up to a whole number', () => {
    expect(axisTicks(2.5)).toEqual([0, 2, 3]);
  });

  it('never repeats a tick', () => {
    for (let top = 0; top <= 50; top += 0.5) {
      const ticks = axisTicks(top);
      expect(new Set(ticks).size).toBe(ticks.length);
      expect(ticks.every((tick) => Number.isInteger(tick))).toBe(true);
    }
  });
});

describe('BurnUpChart', () => {
  it('says the cycle is empty rather than drawing an axis over nothing', () => {
    render(
      <BurnUpChart
        points={[point('2026-09-01', 0), point('2026-09-02', 0)]}
        days={days}
        emptyMessage="No issues in this cycle yet."
      />
    );

    expect(screen.getByTestId('burn-up-empty')).toHaveTextContent(
      'No issues in this cycle yet.'
    );
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('labels a one-issue cycle 0 and 1, each once', () => {
    render(
      <BurnUpChart
        points={[point('2026-09-01', 1), point('2026-09-02', 1, 1, 1)]}
        days={days}
      />
    );

    expect(
      screen.getByRole('img', { name: /^Burn-up chart/ })
    ).toBeInTheDocument();
    expect(tickLabels()).toEqual(['0', '1']);
  });

  it('labels a larger cycle with a whole-number midpoint', () => {
    render(
      <BurnUpChart
        points={[point('2026-09-01', 5), point('2026-09-02', 5, 2, 1)]}
        days={days}
      />
    );

    expect(tickLabels()).toEqual(['0', '3', '5']);
  });

  it('draws an axis for a cycle that has not started', () => {
    render(<BurnUpChart points={[]} days={days} />);

    expect(
      screen.getByRole('img', { name: /has not started yet/ })
    ).toBeInTheDocument();
    expect(tickLabels()).toEqual(['0', '1']);
  });
});
