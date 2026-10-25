/**
 * MemberLink links a person to their member page inside a workspace and
 * renders plain content anywhere else, so components that name people keep
 * working in a preview or a test without a workspace.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import {
  WorkspaceContext,
  type WorkspaceContextType,
} from '../../contexts/WorkspaceContextDefinition';
import MemberLink from './MemberLink';

const context: WorkspaceContextType = {
  workspace: {
    id: 'ws-1',
    name: 'Mine',
    slug: 'mine',
    plan: 'free',
    created_at: '2026-09-17T00:00:00Z',
    role: 'member',
  },
  isLoading: false,
  notFound: false,
  error: null,
  refresh: vi.fn(() => Promise.resolve()),
};

describe('MemberLink', () => {
  it('links to the member page inside a workspace', () => {
    render(
      <MemoryRouter>
        <WorkspaceContext.Provider value={context}>
          <MemberLink userId="user-7">Riley</MemberLink>
        </WorkspaceContext.Provider>
      </MemoryRouter>
    );

    expect(screen.getByRole('link', { name: 'Riley' })).toHaveAttribute(
      'href',
      '/w/mine/members/user-7'
    );
  });

  it('renders plain content without a workspace', () => {
    render(
      <MemoryRouter>
        <MemberLink userId="user-7">Riley</MemberLink>
      </MemoryRouter>
    );

    expect(screen.getByText('Riley')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders plain content without a router', () => {
    render(
      <WorkspaceContext.Provider value={context}>
        <MemberLink userId="user-7">Riley</MemberLink>
      </WorkspaceContext.Provider>
    );

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders plain content with no person', () => {
    render(
      <MemoryRouter>
        <WorkspaceContext.Provider value={context}>
          <MemberLink userId={null}>No one</MemberLink>
        </WorkspaceContext.Provider>
      </MemoryRouter>
    );

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
