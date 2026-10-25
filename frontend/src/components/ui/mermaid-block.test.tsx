/**
 * The diagram block in rendered Markdown. Covers that a `mermaid` fence opens
 * on its drawn diagram, that the toggle switches to the source and back, that
 * a diagram that does not parse shows its source and a short error, and that
 * any other fence stays an ordinary code block.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MermaidResult } from '../../lib/mermaid';
import Markdown from './markdown';

const renderMermaid = vi.hoisted(() =>
  vi.fn((_source: string, _dark: boolean): Promise<MermaidResult> =>
    Promise.resolve({ ok: true, svg: '<svg data-drawn="yes"></svg>' })
  )
);

vi.mock('../../lib/mermaid', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  renderMermaid,
}));

const SOURCE = '```mermaid\ngraph TD\n  A --> B\n```';

beforeEach(() => {
  renderMermaid.mockClear();
});

describe('MermaidBlock', () => {
  it('opens on the drawn diagram', async () => {
    const { container } = render(<Markdown source={SOURCE} />);

    await waitFor(() => {
      expect(container.querySelector('svg[data-drawn="yes"]')).not.toBeNull();
    });
    expect(renderMermaid).toHaveBeenCalledWith(
      'graph TD\n  A --> B',
      expect.any(Boolean)
    );
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible();
  });

  it('switches to the source and back', async () => {
    const { container } = render(<Markdown source={SOURCE} />);
    await waitFor(() => {
      expect(container.querySelector('svg[data-drawn="yes"]')).not.toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    expect(container.querySelector('svg[data-drawn="yes"]')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe(
      'graph TD\n  A --> B'
    );
    expect(screen.getByRole('button', { name: 'Code' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(
      screen.getByRole('button', { name: 'Copy code' })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => {
      expect(container.querySelector('svg[data-drawn="yes"]')).not.toBeNull();
    });
  });

  it('shows the source and a short error when the diagram does not parse', async () => {
    renderMermaid.mockResolvedValueOnce({
      ok: false,
      error: 'Parse error on line 1: boom',
    });
    const { container } = render(
      <Markdown source={'```mermaid\nnot a diagram\n```'} />
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Parse error on line 1: boom'
    );
    expect(container.querySelector('.mermaid-source')?.textContent).toBe(
      'not a diagram'
    );
  });

  it('leaves any other fence an ordinary code block', () => {
    render(<Markdown source={'```ts\nconst a = 1;\n```'} />);

    expect(renderMermaid).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'Diagram view' })).toBeNull();
  });
});
