/**
 * The workspace frame keeps its page body positioned, so a visually hidden
 * label or input deep in a long page scrolls inside the body rather than
 * stretching the shell or the document below the viewport.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import WorkspaceShell from './WorkspaceShell';

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => ({
    workspace: { id: 'w1', name: 'Acme', slug: 'acme', role: 'owner' },
    isLoading: false,
    notFound: false,
    error: null,
  }),
}));

vi.mock('./Sidebar', () => ({
  default: () => <nav data-testid="sidebar" />,
}));

vi.mock('./PeekPane', () => ({
  PeekPane: () => null,
}));

/** Mounts the shell around a page body with the given flush setting. */
const renderShell = (flush: boolean) =>
  render(
    <MemoryRouter>
      <WorkspaceShell title="Settings" flush={flush}>
        <p>page body</p>
      </WorkspaceShell>
    </MemoryRouter>
  );

describe('WorkspaceShell', () => {
  it('positions the scrolling body so hidden content scrolls with it', () => {
    renderShell(false);
    const body = screen.getByText('page body').parentElement;
    expect(body).toHaveClass('relative', 'min-h-0', 'overflow-y-auto');
  });

  it('positions a flush body too', () => {
    renderShell(true);
    const body = screen.getByText('page body').parentElement;
    expect(body).toHaveClass('relative', 'min-h-0', 'overflow-hidden');
  });
});
