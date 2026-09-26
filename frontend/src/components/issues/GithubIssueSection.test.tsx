/**
 * The synced GitHub issue in the issue rail. Covers that it links to the
 * GitHub issue in a section of its own, and that it renders nothing when the
 * issue syncs with no GitHub issue.
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueSyncRead } from '../../types/Api';
import GithubIssueSection from './GithubIssueSection';

const getIssueSync = vi.fn<() => Promise<IssueSyncRead | null>>();

vi.mock('../../api/integrations', async () => {
  const actual = await vi.importActual<typeof import('../../api/integrations')>(
    '../../api/integrations'
  );
  return {
    ...actual,
    getIssueSync: () => getIssueSync(),
  };
});

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

beforeEach(() => {
  getIssueSync.mockReset();
  getIssueSync.mockResolvedValue(null);
});

describe('the synced GitHub issue', () => {
  it('links to the GitHub issue in its own section', async () => {
    getIssueSync.mockResolvedValue({
      issue_id: 'iss-1',
      repository_full_name: 'WebbPulse/standupless',
      number: 12,
      url: 'https://github.com/WebbPulse/standupless/issues/12',
      origin: 'github',
      synced_at: '2026-09-26T00:00:00Z',
    });
    render(<GithubIssueSection workspaceId="ws-1" issueId="iss-1" />);

    const link = await screen.findByRole('link', {
      name: 'Synced with WebbPulse/standupless#12',
    });
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/WebbPulse/standupless/issues/12'
    );
    expect(
      screen.getByRole('region', { name: 'GitHub issue' })
    ).toContainElement(link);
  });

  it('renders nothing when the issue syncs with no GitHub issue', async () => {
    const { container } = render(
      <GithubIssueSection workspaceId="ws-1" issueId="iss-1" />
    );

    await vi.waitFor(() => {
      expect(getIssueSync).toHaveBeenCalled();
    });
    expect(container).toBeEmptyDOMElement();
  });
});
