/**
 * The velocity chart. Covers that its y axis labels are whole numbers that
 * never repeat, so an empty or one-issue maximum reads 0 and 1 only, and
 * that a larger maximum gains a whole-number midpoint.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { VelocityCycleRead } from '../../types/Api';
import { VelocityChart } from './VelocityChart';

/** One closed cycle with the given completed and scope issue counts. */
const cycle = (
  id: string,
  completed: number,
  scope: number
): VelocityCycleRead => ({
  cycle_id: id,
  name: `Cycle ${id}`,
  start_date: '2026-09-01',
  end_date: '2026-09-14',
  completed_issues: completed,
  completed_points: 0,
  scope_issues: scope,
  scope_points: 0,
  carried_out: 0,
  carried_out_points: 0,
});

/** The y axis labels the chart drew, in render order. */
const tickLabels = (): string[] =>
  screen.getAllByTestId('velocity-tick').map((node) => node.textContent ?? '');

describe('VelocityChart', () => {
  it('labels a maximum of 0 with 0 and 1 only', () => {
    render(
      <VelocityChart cycles={[cycle('1', 0, 0)]} measure="issues" average={0} />
    );
    expect(tickLabels()).toEqual(['0', '1']);
  });

  it('labels a maximum of 1 with 0 and 1 only', () => {
    render(
      <VelocityChart cycles={[cycle('1', 0, 1)]} measure="issues" average={0} />
    );
    expect(tickLabels()).toEqual(['0', '1']);
  });

  it('adds a whole-number midpoint for a larger maximum', () => {
    render(
      <VelocityChart
        cycles={[cycle('1', 4, 10), cycle('2', 6, 8)]}
        measure="issues"
        average={5}
      />
    );
    expect(tickLabels()).toEqual(['0', '5', '10']);
  });

  it('labels an empty chart with 0 and 1 only', () => {
    render(<VelocityChart cycles={[]} measure="issues" average={0} />);
    expect(tickLabels()).toEqual(['0', '1']);
  });
});
