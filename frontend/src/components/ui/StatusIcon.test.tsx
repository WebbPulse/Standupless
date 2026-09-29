/**
 * The shared status glyph: it names itself only when asked, draws in the
 * status's own color and icon, and draws the unknown glyph with no status.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { STATUS_COLOR_VALUES, STATUS_ICONS } from '../../lib/statusAppearance';
import { StatusIcon } from './StatusIcon';

describe('StatusIcon', () => {
  it('is hidden from assistive technology unless named', () => {
    const { container } = render(
      <StatusIcon status={{ category: 'started' }} />
    );
    expect(container.querySelector('svg')).toHaveAttribute(
      'aria-hidden',
      'true'
    );
    render(<StatusIcon status={{ category: 'started' }} name="In Progress" />);
    expect(
      screen.getByRole('img', { name: 'In Progress' })
    ).toBeInTheDocument();
  });

  it('draws the stored color and icon', () => {
    const { container } = render(
      <StatusIcon
        status={{ category: 'started', color: 'pink', icon: 'paused' }}
      />
    );
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('data-status-icon', 'paused');
    expect(svg?.getAttribute('style')).toContain('color');
    expect(svg).toHaveStyle({ color: STATUS_COLOR_VALUES.pink });
  });

  it('draws the unknown glyph when the status is missing', () => {
    const { container } = render(<StatusIcon status={undefined} />);
    expect(container.querySelector('svg')).toHaveAttribute(
      'data-status-icon',
      'dashed'
    );
  });

  it('draws every variant', () => {
    for (const icon of STATUS_ICONS) {
      const { container, unmount } = render(
        <StatusIcon look={{ icon, color: 'red', fill: 0.5 }} />
      );
      expect(container.querySelector('svg')?.childElementCount).toBeGreaterThan(
        0
      );
      unmount();
    }
  });
});
