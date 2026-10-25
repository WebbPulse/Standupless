/**
 * The workspace provider: a route under a slug the workspace retired lands on
 * the same page under the current slug with the query and hash kept, and a
 * slug no workspace ever held still reads as not found.
 */

import { render, screen } from '@testing-library/react';
import type { FC } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { useWorkspace } from '../hooks/useWorkspace';
import type { WorkspaceRead } from '../types/Api';
import WorkspaceProvider from './WorkspaceContext';

const workspaces: WorkspaceRead[] = [
  {
    id: 'ws-1',
    name: 'Acme',
    slug: 'acme-labs',
    plan: 'free',
    created_at: '2026-10-01T00:00:00Z',
    role: 'admin',
    retired_slugs: ['acme'],
  },
];

vi.mock('@webbpulse/auth/react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useQueryAuth: () => ({}),
}));

vi.mock('@webbpulse/api-client/react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usePolledQuery: () => ({
    data: workspaces,
    error: null,
    isLoading: false,
    refetch: () => Promise.resolve(),
  }),
}));

vi.mock('../hooks/useWorkspaceAccent', () => ({
  useWorkspaceAccent: () => undefined,
}));

/** Prints where the router landed and what the provider resolved. */
const Where: FC = () => {
  const location = useLocation();
  const { workspace, notFound } = useWorkspace();
  const resolved = workspace?.slug ?? (notFound ? 'not-found' : 'none');
  return (
    <p>{`${location.pathname}${location.search}${location.hash}|${resolved}`}</p>
  );
};

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/w/:slug" element={<WorkspaceProvider />}>
          <Route path="*" element={<Where />} />
          <Route index element={<Where />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );

describe('WorkspaceProvider', () => {
  it('redirects a retired slug and keeps the path, query and hash', () => {
    renderAt('/w/acme/issue/ENG-1?tab=activity#comment-2');
    expect(
      screen.getByText(
        '/w/acme-labs/issue/ENG-1?tab=activity#comment-2|acme-labs'
      )
    ).toBeInTheDocument();
  });

  it('serves the current slug in place', () => {
    renderAt('/w/acme-labs/settings');
    expect(
      screen.getByText('/w/acme-labs/settings|acme-labs')
    ).toBeInTheDocument();
  });

  it('reads a slug no workspace held as not found', () => {
    renderAt('/w/nobody');
    expect(screen.getByText('/w/nobody|not-found')).toBeInTheDocument();
  });
});
