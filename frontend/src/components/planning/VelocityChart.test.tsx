/**
 * The velocity chart. Covers that its y axis labels are whole numbers that
 * never repeat, so an empty or one-issue maximum reads 0 and 1 only, and
 * that a larger maximum gains a whole-number midpoint, and that hovering or
 * arrowing through the columns reads out each cycle.
 */

import { fireEvent, render, screen } from '@testing-library/react';
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

describe('VelocityChart readout', () => {
  const cycles = [cycle('1', 4, 10), cycle('2', 6, 8)];
  const slot = (640 - 28 - 8) / 2;

  it('reads the hovered cycle in place of an SVG title', () => {
    const { container } = render(
      <VelocityChart cycles={cycles} measure="issues" average={5} />
    );
    expect(container.querySelector('title')).toBeNull();

    fireEvent.mouseMove(screen.getByTestId('velocity-frame'), {
      clientX: 28 + slot * 0.5,
    });

    const readout = screen.getByTestId('velocity-readout');
    expect(readout).toHaveTextContent('Cycle 1');
    expect(readout).toHaveTextContent('Completed4');
    expect(readout).toHaveTextContent('Scope at close10');
    expect(readout.style.left).not.toBe('');
    expect(screen.getAllByTestId('velocity-bar')[0]).toHaveAttribute(
      'data-active',
      'true'
    );
    expect(screen.getByTestId('velocity-live')).toHaveTextContent(
      'Cycle 1: 4 of 10 issues completed.'
    );

    fireEvent.mouseLeave(screen.getByTestId('velocity-frame'));
    expect(screen.queryByTestId('velocity-readout')).toBeNull();
  });

  it('steps through cycles with the arrow keys once focused', () => {
    render(<VelocityChart cycles={cycles} measure="issues" average={5} />);
    const frame = screen.getByTestId('velocity-frame');

    fireEvent.focus(frame);
    const readout = screen.getByTestId('velocity-readout');
    expect(readout).toHaveTextContent('Cycle 2');
    expect(readout.style.right).not.toBe('');

    fireEvent.keyDown(frame, { key: 'ArrowLeft' });
    expect(screen.getByTestId('velocity-readout')).toHaveTextContent('Cycle 1');
  });
});
