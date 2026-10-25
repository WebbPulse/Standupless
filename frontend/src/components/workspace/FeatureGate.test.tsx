/**
 * The gate around an optional area's routes: the page renders while the area
 * is on or the workspace does not say, and a page saying an admin turned it
 * off renders in its place while it is off, with a link to the switch for an
 * admin only.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  WorkspaceFeature,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import FeatureGate from './FeatureGate';

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
    isBusy: false,
    login: vi.fn(),
    logout: vi.fn(),
    checkAuthStatus: vi.fn(),
  }),
}));

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

const useWorkspaceMock = vi.fn<() => WorkspaceContextType>();

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => useWorkspaceMock(),
}));

/** A resolved workspace context with the caller holding `role`. */
const resolved = (
  role: WorkspaceRole,
  features?: WorkspaceRead['features']
): WorkspaceContextType => ({
  workspace: {
    id: 'ws-1',
    name: 'Engineering',
    slug: 'mine',
    plan: 'free',
    created_at: '2026-09-17T00:00:00Z',
    role,
    ...(features === undefined ? {} : { features }),
  },
  isLoading: false,
  notFound: false,
  error: null,
  refresh: () => Promise.resolve(),
});

/** Mounts a page for `feature` behind the gate at its route. */
const renderGate = (feature: WorkspaceFeature) =>
  render(
    <MemoryRouter initialEntries={['/w/mine/area']}>
      <Routes>
        <Route path="/w/:slug" element={<FeatureGate feature={feature} />}>
          <Route path="area" element={<p>The area page</p>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );

const AREAS = [
  ['initiatives', 'Initiatives'],
  ['customers', 'Customers'],
  ['releases', 'Releases'],
  ['documents', 'Documents'],
  ['pulse', 'Pulse'],
] as const;

beforeEach(() => {
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('admin'));
});

describe('FeatureGate', () => {
  it.each(AREAS)('renders the %s page while the area is on', (feature) => {
    renderGate(feature);

    expect(screen.getByText('The area page')).toBeInTheDocument();
  });

  it.each(AREAS)(
    'says an admin turned %s off while it is off, rather than a 404',
    (feature, label) => {
      useWorkspaceMock.mockReturnValue(resolved('admin', { [feature]: false }));
      renderGate(feature);

      expect(screen.queryByText('The area page')).toBeNull();
      expect(
        screen.getByText(
          `${label} is turned off by an admin for this workspace. Everything in it is kept and comes back when it is turned on again.`
        )
      ).toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: 'Open feature settings' })
      ).toHaveAttribute('href', '/w/mine/settings/features');
    }
  );

  it('keeps the area page while a different area is off', () => {
    useWorkspaceMock.mockReturnValue(resolved('admin', { pulse: false }));
    renderGate('releases');

    expect(screen.getByText('The area page')).toBeInTheDocument();
  });

  it('offers a member no link to the switch', () => {
    useWorkspaceMock.mockReturnValue(resolved('member', { releases: false }));
    renderGate('releases');

    expect(screen.getByText(/Releases is turned off/)).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Open feature settings' })
    ).toBeNull();
  });
});
