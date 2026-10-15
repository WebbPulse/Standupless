/**
 * The issue rail's releases section: one linked row per release with its
 * stage, state and date, carried releases marked as included in their
 * promotion, a toggle past five rows, and nothing in the rail when the issue
 * shipped in none or the read fails.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fullTimestamp } from '../../lib/relativeTime';
import type {
  IssueReleaseListRead,
  IssueReleaseRead,
  ReleaseStageRead,
} from '../../types/Api';
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

/** A timestamp this many days before now. */
const daysAgo = (days: number): string =>
  new Date(Date.now() - days * 86400000).toISOString();

/** One stage reached, as the release read carries it. */
const reached = (name: string, at: string = daysAgo(3)): ReleaseStageRead => ({
  stage_id: name.toLowerCase(),
  name,
  reached_at: at,
  source: 'github_deployment',
});

/** One release carrying the issue. */
const release = (
  id: string,
  name: string,
  extra: Partial<IssueReleaseRead> = {}
): IssueReleaseRead => ({
  release_id: id,
  team_id: 'team-1',
  name,
  current_stage: reached('Production'),
  created_at: daysAgo(4),
  ...extra,
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

  it('lists every release as its own linked row with its date', async () => {
    const promotedAt = reached('Production').reached_at;
    listIssueReleases.mockResolvedValue({
      releases: [
        release('rel-2', 'v1.3.0'),
        release('rel-1', 'v1.2.0', {
          current_stage: reached('Staging', daysAgo(5)),
          included_in: 'rel-2',
          included_in_name: 'v1.3.0',
        }),
      ],
    });
    renderSection();

    const newest = await screen.findByRole('link', {
      name: `v1.3.0, Production, released, ${fullTimestamp(promotedAt)}`,
    });
    expect(newest).toHaveAttribute('href', '/w/mine/team/ENG/releases/rel-2');
    expect(newest).toHaveAttribute('title', 'v1.3.0');
    const carried = screen.getByRole('link', { name: /^v1\.2\.0, / });
    expect(carried).toHaveAttribute('href', '/w/mine/team/ENG/releases/rel-1');
    expect(screen.getByText('Staging, included in v1.3.0')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('3d ago')).toHaveAttribute('dateTime', promotedAt);
    expect(screen.getByText('5d ago')).toBeInTheDocument();
    expect(screen.queryByText(/more$/)).not.toBeInTheDocument();
    expect(listIssueReleases).toHaveBeenCalledTimes(1);
  });

  it('shows five rows and a toggle for the rest', async () => {
    listIssueReleases.mockResolvedValue({
      releases: Array.from({ length: 7 }, (_, index) =>
        release(`rel-${String(7 - index)}`, `v1.${String(7 - index)}.0`)
      ),
    });
    renderSection();

    await screen.findByRole('link', { name: /^v1\.7\.0, / });
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText('7')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show all 7' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(7);

    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
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
