/**
 * The loading placeholders. Covers that a run of rows is announced as one
 * busy status with a spoken label, that the bars themselves stay out of the
 * accessibility tree, and that the count is the caller's to choose.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Skeleton, { SkeletonRows } from './skeleton';

describe('Skeleton', () => {
  it('draws a decorative bar that assistive technology skips', () => {
    const { container } = render(<Skeleton className="h-3 w-10" />);

    const bar = container.firstElementChild;
    expect(bar).toHaveAttribute('aria-hidden', 'true');
    expect(bar).toHaveClass('animate-pulse');
  });

  it('keeps the caller class list', () => {
    const { container } = render(<Skeleton className="w-10" />);

    expect(container.firstElementChild).toHaveClass('w-10');
  });
});

describe('SkeletonRows', () => {
  it('announces the wait once, as a status', () => {
    render(<SkeletonRows label="Loading issues" />);

    const status = screen.getByRole('status', { name: 'Loading issues' });
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading issues')).toHaveClass('sr-only');
  });

  it('draws the number of rows asked for', () => {
    render(<SkeletonRows count={3} />);

    const rows = screen.getByRole('status').querySelectorAll('.h-row');
    expect(rows).toHaveLength(3);
  });

  it('draws rows at the list row height without being asked', () => {
    render(<SkeletonRows />);

    expect(
      screen.getByRole('status').querySelectorAll('.h-row').length
    ).toBeGreaterThan(0);
  });

  it('hides every bar it draws from assistive technology', () => {
    render(<SkeletonRows count={2} />);

    const bars = screen.getByRole('status').querySelectorAll('.animate-pulse');
    expect(bars.length).toBeGreaterThan(0);
    bars.forEach((bar) => {
      expect(bar).toHaveAttribute('aria-hidden', 'true');
    });
  });
});
