/**
 * The burn-up chart. Covers that its y axis labels are whole numbers that
 * never repeat, that a one-issue cycle reads 0 and 1, that a cycle whose
 * scope has been empty every day says so instead of drawing an axis, that a
 * loading chart shows a placeholder, that it draws at a fixed height, and
 * that hovering or arrowing through it reads out each day, projected on days
 * still to come.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BurnUpPoint } from '../../lib/planningModel';
import { BurnUpChart, axisTicks, readingAt } from './BurnUpChart';

const SLOT = (640 - 28 - 8) / 4;

/** The pointer offset over the middle of day `index` of a four-day chart. */
const overDay = (index: number): number => 28 + SLOT * (index + 0.5);

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
  it('shows a placeholder instead of the empty message while loading', () => {
    render(
      <BurnUpChart
        points={[point('2026-09-01', 0)]}
        days={days}
        emptyMessage="No issues in this cycle yet."
        isLoading
      />
    );

    expect(screen.getByTestId('burn-up-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('burn-up-empty')).toBeNull();
  });

  it('draws at a fixed height with small axis text', () => {
    render(<BurnUpChart points={[point('2026-09-01', 4, 2, 1)]} days={days} />);

    const svg = screen.getByRole('img', { name: /^Burn-up chart/ });
    expect(svg).toHaveAttribute('height', '160');
    for (const tick of screen.getAllByTestId('burn-up-tick')) {
      expect(tick).toHaveAttribute('font-size', '11');
    }
  });

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

  it('draws a project forecast and target marker without the target pace', () => {
    render(
      <BurnUpChart
        points={[point('2026-09-01', 4, 1, 1), point('2026-09-02', 4, 2, 2)]}
        days={days}
        forecast={{ date: '2026-09-04', value: 4 }}
        targetDate="2026-09-03"
        showPace={false}
      />
    );

    expect(screen.getByTestId('burn-up-forecast')).toBeInTheDocument();
    expect(screen.getByTestId('burn-up-target')).toBeInTheDocument();
    expect(screen.queryByText('Target pace')).toBeNull();
    expect(screen.getByText('Target date')).toBeInTheDocument();
    expect(
      screen.getByRole('img', {
        name: /Projected to complete 4 by 2026-09-04/,
      })
    ).toBeInTheDocument();
  });

  it('skips a forecast or target that falls outside the drawn days', () => {
    render(
      <BurnUpChart
        points={[point('2026-09-01', 4, 1, 1)]}
        days={days}
        forecast={{ date: '2026-10-01', value: 4 }}
        targetDate="2026-08-01"
      />
    );

    expect(screen.queryByTestId('burn-up-forecast')).toBeNull();
    expect(screen.queryByTestId('burn-up-target')).toBeNull();
    expect(screen.getByText('Target pace')).toBeInTheDocument();
  });
});

describe('readingAt', () => {
  const points = [point('2026-09-01', 4, 1, 0), point('2026-09-02', 4, 2, 1)];

  it('reads a recorded day with the target pace', () => {
    expect(
      readingAt(1, {
        points,
        days,
        projection: null,
        forecast: null,
        showPace: true,
      })
    ).toEqual({
      date: '2026-09-02',
      scope: 4,
      started: 2,
      completed: 1,
      target: 2,
      projected: false,
    });
  });

  it('reads a day still to come off the projection', () => {
    const reading = readingAt(3, {
      points,
      days,
      projection: 3,
      forecast: null,
      showPace: false,
    });
    expect(reading).toMatchObject({
      date: '2026-09-04',
      scope: 4,
      completed: 3,
      started: 3,
      target: null,
      projected: true,
    });
    expect(
      readingAt(2, {
        points,
        days,
        projection: 3,
        forecast: null,
        showPace: false,
      }).completed
    ).toBe(2);
  });

  it('reads a day still to come off a forecast and holds it after', () => {
    const input = {
      points,
      days,
      projection: null,
      forecast: { date: '2026-09-03', value: 4 },
      showPace: false,
    };
    expect(readingAt(2, input).completed).toBe(4);
    expect(readingAt(3, input).completed).toBe(4);
  });

  it('has no values for a day still to come without a projection', () => {
    expect(
      readingAt(3, {
        points,
        days,
        projection: null,
        forecast: null,
        showPace: false,
      })
    ).toMatchObject({ completed: null, scope: null, projected: false });
  });
});

describe('BurnUpChart readout', () => {
  const points = [point('2026-09-01', 4, 1, 0), point('2026-09-02', 4, 2, 1)];

  it('snaps a guide to the hovered day and reads its values', () => {
    render(<BurnUpChart points={points} days={days} />);
    const frame = screen.getByTestId('burn-up-frame');

    fireEvent.mouseMove(frame, { clientX: overDay(1) + 20 });

    expect(screen.getByTestId('burn-up-guide')).toBeInTheDocument();
    const readout = screen.getByTestId('burn-up-readout');
    expect(readout).toHaveTextContent('Sep 2');
    expect(readout).toHaveTextContent('In issues');
    expect(readout).toHaveTextContent('Scope4');
    expect(readout).toHaveTextContent('Started2');
    expect(readout).toHaveTextContent('Completed1');
    expect(readout).toHaveTextContent('Target2');
    expect(readout.style.left).not.toBe('');
    expect(screen.getByTestId('burn-up-live')).toHaveTextContent(
      'Sep 2: scope 4, started 2, completed 1 issues, target 2.'
    );

    fireEvent.mouseLeave(frame);
    expect(screen.queryByTestId('burn-up-readout')).toBeNull();
    expect(screen.getByTestId('burn-up-live')).toBeEmptyDOMElement();
  });

  it('labels a projected day and keeps the readout inside the chart', () => {
    render(
      <BurnUpChart points={points} days={days} projection={3} unit="points" />
    );

    fireEvent.mouseMove(screen.getByTestId('burn-up-frame'), {
      clientX: overDay(3),
    });

    const readout = screen.getByTestId('burn-up-readout');
    expect(readout).toHaveTextContent('Projected, in points');
    expect(readout).toHaveTextContent('Completed3');
    expect(readout.style.right).not.toBe('');
    expect(readout.style.left).toBe('');
    expect(screen.getByTestId('burn-up-live')).toHaveTextContent(
      'Sep 4, projected: scope 4, started 3, completed 3 points'
    );
  });

  it('steps through days with the arrow keys once focused', () => {
    render(<BurnUpChart points={points} days={days} showPace={false} />);
    const frame = screen.getByTestId('burn-up-frame');

    expect(frame).toHaveAttribute('tabindex', '0');
    fireEvent.focus(frame);
    expect(screen.getByTestId('burn-up-readout')).toHaveTextContent('Sep 2');

    fireEvent.keyDown(frame, { key: 'ArrowLeft' });
    expect(screen.getByTestId('burn-up-readout')).toHaveTextContent('Sep 1');
    fireEvent.keyDown(frame, { key: 'ArrowLeft' });
    expect(screen.getByTestId('burn-up-readout')).toHaveTextContent('Sep 1');

    fireEvent.keyDown(frame, { key: 'End' });
    expect(screen.getByTestId('burn-up-readout')).toHaveTextContent(
      'Not reached yet'
    );
    expect(screen.getByTestId('burn-up-readout')).not.toHaveTextContent(
      'Target'
    );

    fireEvent.blur(frame);
    expect(screen.queryByTestId('burn-up-readout')).toBeNull();
  });
});
