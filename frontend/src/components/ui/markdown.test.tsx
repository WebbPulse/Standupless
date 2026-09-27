/**
 * The static Markdown body. Covers that the `&nbsp;` lines older rich editor
 * saves stored render as nothing rather than as entity text, and that the
 * compact density sets comments and updates tighter than a description.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Markdown from './markdown';

describe('Markdown', () => {
  it('shows no entity text for stored &nbsp; lines', () => {
    const { container } = render(
      <Markdown source={'first\n\nsecond\n\n\n\n&nbsp;\n\n&nbsp;\n\nthird'} />
    );

    expect(container.textContent).not.toContain('&nbsp;');
    expect(container.querySelectorAll('p')).toHaveLength(3);
    expect(screen.getByText('third')).toBeInTheDocument();
  });

  it('sets a description comfortably by default', () => {
    const { container } = render(<Markdown source="body" />);

    expect(container.firstElementChild).toHaveClass('space-y-3', 'leading-6');
  });

  it('sets a compact body tighter', () => {
    const { container } = render(<Markdown source="body" density="compact" />);

    expect(container.firstElementChild).toHaveClass('space-y-2', 'leading-5.5');
    expect(container.firstElementChild).not.toHaveClass('space-y-3');
  });
});
