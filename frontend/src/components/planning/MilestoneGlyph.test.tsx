/**
 * The milestone glyph. Covers its four states, no issues, none done, some
 * done and all done, the sentence its tooltip and label read, the points
 * measure, a marker from a server that sends no counts, and the decorative
 * form that leaves naming to its host.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RollupCounts } from '../../types/Api';
import { MilestoneGlyph } from './MilestoneGlyph';

const counts = (over: Partial<RollupCounts>): RollupCounts => ({
  todo: 0,
  in_progress: 0,
  done: 0,
  cancelled: 0,
  total: 0,
  ...over,
});

describe('MilestoneGlyph', () => {
  it('draws a milestone with no issues as an empty dashed diamond', () => {
    render(<MilestoneGlyph milestone={{ name: 'Beta', counts: counts({}) }} />);

    const glyph = screen.getByRole('img', {
      name: 'Beta, 0% of 0 issues complete',
    });
    expect(glyph).toHaveAttribute('data-milestone-glyph', 'none');
    expect(glyph).toHaveAttribute('title', 'Beta, 0% of 0 issues complete');
    expect(glyph.querySelector('rect')).toBeNull();
  });

  it('draws a milestone with nothing done as an empty outline', () => {
    render(
      <MilestoneGlyph
        milestone={{ name: 'Beta', counts: counts({ todo: 3, total: 3 }) }}
      />
    );

    const glyph = screen.getByRole('img', {
      name: 'Beta, 0% of 3 issues complete',
    });
    expect(glyph).toHaveAttribute('data-milestone-glyph', 'empty');
    expect(glyph.querySelector('rect')).toBeNull();
  });

  it('fills a partly done milestone by its share', () => {
    render(
      <MilestoneGlyph
        milestone={{
          name: 'Beta',
          counts: counts({ todo: 2, done: 1, cancelled: 1, total: 4 }),
        }}
      />
    );

    const glyph = screen.getByRole('img', {
      name: 'Beta, 33% of 3 issues complete',
    });
    expect(glyph).toHaveAttribute('data-milestone-glyph', 'partial');
    expect(glyph).toHaveAttribute('data-percent', '33');
    expect(glyph.querySelector('rect')).not.toBeNull();
  });

  it('never rounds a partly done milestone up to complete', () => {
    render(
      <MilestoneGlyph
        milestone={{
          name: 'Beta',
          counts: counts({ todo: 1, done: 299, total: 300 }),
        }}
      />
    );

    const glyph = screen.getByRole('img', {
      name: 'Beta, 99% of 300 issues complete',
    });
    expect(glyph).toHaveAttribute('data-milestone-glyph', 'partial');
  });

  it('fills and checks a complete milestone', () => {
    render(
      <MilestoneGlyph
        milestone={{ name: 'Beta', counts: counts({ done: 1, total: 1 }) }}
      />
    );

    const glyph = screen.getByRole('img', {
      name: 'Beta, 100% of 1 issue complete',
    });
    expect(glyph).toHaveAttribute('data-milestone-glyph', 'complete');
    expect(glyph.querySelectorAll('path')).toHaveLength(3);
  });

  it('reads in points when the project estimates', () => {
    render(
      <MilestoneGlyph
        milestone={{
          name: 'Beta',
          counts: counts({ todo: 1, done: 1, total: 2 }),
          measure: 'points',
          progress: counts({ todo: 3, done: 5, total: 8 }),
        }}
      />
    );

    expect(
      screen.getByRole('img', { name: 'Beta, 63% of 8 points complete' })
    ).toHaveAttribute('data-milestone-glyph', 'partial');
  });

  it('falls back on the completed flag when a marker carries no counts', () => {
    render(<MilestoneGlyph milestone={{ name: 'GA', completed: true }} />);

    expect(
      screen.getByRole('img', { name: 'GA, 100% complete' })
    ).toHaveAttribute('data-milestone-glyph', 'complete');
  });

  it('hides a decorative glyph but keeps its tooltip', () => {
    const { container } = render(
      <MilestoneGlyph
        milestone={{ name: 'Beta', counts: counts({ todo: 1, total: 1 }) }}
        decorative
      />
    );

    expect(screen.queryByRole('img')).toBeNull();
    const glyph = container.querySelector('[data-milestone-glyph]');
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
    expect(glyph).toHaveAttribute('title', 'Beta, 0% of 1 issue complete');
  });
});
