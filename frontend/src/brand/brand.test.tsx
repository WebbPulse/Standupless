/**
 * The brand components must stay usable wherever they are placed: a mark that
 * takes a size and a class, and an accessible name on the pair that is spoken
 * once rather than twice.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Logo, Wordmark } from './index';

describe('Logo', () => {
  it('renders a square svg with an accessible name', () => {
    render(<Logo />);
    const mark = screen.getByRole('img', { name: 'Standupless' });
    expect(mark).toBeInTheDocument();
    expect(mark).toHaveAttribute('width', '32');
    expect(mark).toHaveAttribute('height', '32');
    expect(mark).toHaveAttribute('viewBox', '0 0 32 32');
  });

  it('accepts a size and a className', () => {
    render(<Logo size={16} className="shrink-0" />);
    const mark = screen.getByRole('img', { name: 'Standupless' });
    expect(mark).toHaveAttribute('width', '16');
    expect(mark).toHaveAttribute('height', '16');
    expect(mark).toHaveClass('shrink-0');
  });

  it('takes a custom title', () => {
    render(<Logo title="Back to your workspaces" />);
    expect(
      screen.getByRole('img', { name: 'Back to your workspaces' })
    ).toBeInTheDocument();
  });

  it('hides itself when the title is null', () => {
    const { container } = render(<Logo title={null} />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(container.querySelector('svg')).toHaveAttribute(
      'aria-hidden',
      'true'
    );
  });
});

describe('Wordmark', () => {
  it('renders the product name once, with the mark hidden beside it', () => {
    const { container } = render(<Wordmark />);
    expect(screen.getByText('Standupless')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('accepts a size and a className', () => {
    const { container } = render(<Wordmark size={32} className="mb-4" />);
    expect(container.firstChild).toHaveClass('mb-4');
    expect(container.querySelector('svg')).toHaveAttribute('width', '32');
  });

  it('sets the name in the display stack', () => {
    render(<Wordmark />);
    expect(screen.getByText('Standupless')).toHaveStyle({
      fontFamily: 'var(--brand-font-display)',
    });
  });
});
