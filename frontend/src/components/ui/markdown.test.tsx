/**
 * The static Markdown body. Covers that the `&nbsp;` lines older rich editor
 * saves stored render as nothing rather than as entity text, and that the
 * compact density sets comments and updates tighter than a description, and
 * that a fenced block is highlighted and carries a copy button, and that a
 * collapsible section renders as a native disclosure that starts closed.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

  it('highlights a fenced block in its language', async () => {
    const { container } = render(
      <Markdown source={'```ts\nconst a = 1;\n```'} />
    );

    expect(container.querySelector('code')).toHaveClass(
      'code-highlight',
      'language-ts'
    );
    await waitFor(() => {
      expect(container.querySelector('.hljs-keyword')).not.toBeNull();
    });
    expect(container.querySelector('code')?.textContent).toBe('const a = 1;');
  });

  it('copies a fenced block and confirms it', async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(<Markdown source={'```\nline one\nline two\n```'} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));

    expect(
      await screen.findByRole('button', { name: 'Copied' })
    ).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith('line one\nline two');
  });

  it('renders a collapsible section as a closed disclosure', () => {
    const { container } = render(
      <Markdown
        source={
          'before\n\n<details>\n<summary>Logs &amp; traces</summary>\n\n- one\n- two\n\n</details>'
        }
      />
    );

    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    expect(details?.querySelector('summary')?.textContent).toBe(
      'Logs & traces'
    );
    expect(details?.querySelectorAll('li')).toHaveLength(2);
    expect(container.textContent).not.toContain('<details>');
  });

  it('names a section with no summary', () => {
    const { container } = render(
      <Markdown source={'<details>\n\nbody\n\n</details>'} />
    );

    expect(container.querySelector('summary')?.textContent).toBe('Details');
    expect(container.querySelector('details p')?.textContent).toBe('body');
  });

  it('leaves an unclosed section as text', () => {
    const { container } = render(
      <Markdown source={'<details>\n<summary>Logs</summary>'} />
    );

    expect(container.querySelector('details')).toBeNull();
    expect(container.textContent).toContain('<details>');
  });
});
