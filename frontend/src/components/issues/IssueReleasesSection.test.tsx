/**
 * The issue rail's release line: it names the stage the newest release
 * reached and links to it, counts the other releases, and stays out of the
 * rail when the issue shipped in none or the read fails.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueReleaseListRead } from '../../types/Api';
import IssueReleasesSection from './IssueReleasesSection';

const listIssueReleases = vi.fn<() => Promise<IssueReleaseListRead>>();

vi.mock('../../api/releases', () => ({
  listIssueReleases: () => listIssueReleases(),
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

/** One stage reached, as the release read carries it. */
const reached = (name: string) => ({
  stage_id: name.toLowerCase(),
  name,
  reached_at: '2026-10-07T10:00:00Z',
  source: 'github_deployment',
});

const renderSection = () =>
  render(
    <MemoryRouter>
      <IssueReleasesSection
        workspaceId="ws-1"
        issueId="iss-1"
        slug="mine"
        teams={[{ id: 'team-1', key_prefix: 'ENG' }]}
      />
    </MemoryRouter>
  );

describe('IssueReleasesSection', () => {
  beforeEach(() => {
    listIssueReleases.mockReset();
  });

  it('links the newest release and counts the rest', async () => {
    listIssueReleases.mockResolvedValue({
      releases: [
        {
          release_id: 'rel-2',
          team_id: 'team-1',
          name: 'v1.3.0',
          current_stage: reached('Production'),
          created_at: '2026-10-07T10:00:00Z',
        },
        {
          release_id: 'rel-1',
          team_id: 'team-1',
          name: 'v1.2.0',
          current_stage: reached('Staging'),
          created_at: '2026-10-06T10:00:00Z',
        },
      ],
    });
    renderSection();

    const link = await screen.findByRole('link', {
      name: 'Released to Production in v1.3.0',
    });
    expect(link).toHaveAttribute('href', '/w/mine/team/ENG/releases/rel-2');
    expect(screen.getByText('+1 more')).toBeInTheDocument();
    expect(listIssueReleases).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when the issue shipped in no release', async () => {
    listIssueReleases.mockResolvedValue({ releases: [] });
    const { container } = renderSection();

    await waitFor(() => {
      expect(listIssueReleases).toHaveBeenCalled();
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the read fails', async () => {
    listIssueReleases.mockRejectedValue(new Error('down'));
    const { container } = renderSection();

    await waitFor(() => {
      expect(listIssueReleases).toHaveBeenCalled();
    });
    expect(container).toBeEmptyDOMElement();
  });
});
