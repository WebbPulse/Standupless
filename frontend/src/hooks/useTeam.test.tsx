/**
 * Resolving a key prefix to its team: that a match is found in the workspace
 * list, that a prefix with no match reports as not found rather than as still
 * loading, and that asking for no prefix still hands back the whole list.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamRead } from '../types/Api';
import { useTeam } from './useTeam';

const listTeams = vi.fn<() => Promise<TeamRead[]>>();

vi.mock('../api/teams', () => ({
  listTeams: () => listTeams(),
}));

vi.mock('./useWorkspace', () => ({
  useWorkspace: () => ({ workspace: { id: 'ws-1', slug: 'mine' } }),
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

/** One team row as the team list route answers it. */
const engine: TeamRead = {
  id: 'team-1',
  workspace_id: 'ws-1',
  name: 'Engine',
  key_prefix: 'ENG',
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'admin',
};

/** A second team, so a test can tell a match from the rest of the list. */
const design: TeamRead = {
  ...engine,
  id: 'team-2',
  name: 'Design',
  key_prefix: 'DES',
};

/** Renders what the hook resolved, so a test can read it off the screen. */
const Probe: React.FC<{ keyPrefix?: string }> = ({ keyPrefix }) => {
  const { team, teams, isLoading, notFound } = useTeam(keyPrefix);
  return (
    <div>
      <span data-testid="name">{team?.name ?? 'none'}</span>
      <span data-testid="count">{String(teams.length)}</span>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="not-found">{String(notFound)}</span>
    </div>
  );
};

describe('useTeam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves the key prefix to its team', async () => {
    listTeams.mockResolvedValue([engine, design]);
    render(<Probe keyPrefix="DES" />);

    await waitFor(() => {
      expect(screen.getByTestId('name')).toHaveTextContent('Design');
    });
    expect(screen.getByTestId('not-found')).toHaveTextContent('false');
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
  });

  it('reports not found when the list holds no team with that prefix', async () => {
    listTeams.mockResolvedValue([engine]);
    render(<Probe keyPrefix="NOPE" />);

    await waitFor(() => {
      expect(screen.getByTestId('not-found')).toHaveTextContent('true');
    });
    expect(screen.getByTestId('name')).toHaveTextContent('none');
  });

  it('hands back the whole list when no prefix is asked for', async () => {
    listTeams.mockResolvedValue([engine, design]);
    render(<Probe />);

    await waitFor(() => {
      expect(screen.getByTestId('count')).toHaveTextContent('2');
    });
    expect(screen.getByTestId('name')).toHaveTextContent('none');
    expect(screen.getByTestId('not-found')).toHaveTextContent('false');
  });

  it('is loading until the list arrives', () => {
    listTeams.mockReturnValue(new Promise(() => undefined));
    render(<Probe keyPrefix="ENG" />);

    expect(screen.getByTestId('loading')).toHaveTextContent('true');
    expect(screen.getByTestId('not-found')).toHaveTextContent('false');
  });
});
