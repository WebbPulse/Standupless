/**
 * A milestone row's menu: Copy link copies the address the section was given
 * for that milestone and confirms it with a toast, and the item is absent
 * when the section has no address to give.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MilestoneRead } from '../../types/Api';
import MilestonesSection from './MilestonesSection';

const showToast = vi.fn();

vi.mock('../../lib/toast', () => ({
  showToast: (message: string) => {
    showToast(message);
  },
  showErrorToast: vi.fn(),
}));

/** Rollup counts with one of two issues done. */
const counts = { todo: 1, in_progress: 0, done: 1, cancelled: 0, total: 2 };

/** One milestone with half its issues done. */
const milestone: MilestoneRead = {
  milestone_id: 'ms-1',
  project_id: 'prj-1',
  workspace_id: 'ws-1',
  name: 'Beta',
  description: null,
  target_date: null,
  sort_order: 'a0',
  counts,
  created_by: 'user-1',
  created_at: '2026-10-20T00:00:00Z',
  updated_at: '2026-10-20T00:00:00Z',
};

/** Renders the section with one milestone and the given address builder. */
const renderSection = (
  milestoneUrl?: (milestoneId: string) => string
): void => {
  render(
    <MilestonesSection
      milestones={[milestone]}
      isLoading={false}
      canEdit={false}
      onCreate={() => Promise.resolve()}
      onUpdate={vi.fn()}
      onDelete={vi.fn()}
      onOpenIssues={vi.fn()}
      {...(milestoneUrl === undefined ? {} : { milestoneUrl })}
    />
  );
};

beforeEach(() => {
  showToast.mockReset();
});

describe('milestone Copy link', () => {
  it('copies the address that opens the project on the milestone', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderSection(
      (milestoneId) =>
        `https://standupless.test/acme/projects/prj-1?tab=issues&f=milestone.is%3A${milestoneId}`
    );

    await user.click(screen.getByRole('button', { name: 'Beta actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Copy link' }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('Link to the milestone copied');
    });
    expect(writeText).toHaveBeenCalledWith(
      'https://standupless.test/acme/projects/prj-1?tab=issues&f=milestone.is%3Ams-1'
    );
  });

  it('offers no Copy link without an address', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: 'Beta actions' }));

    expect(screen.getByRole('menuitem', { name: 'View issues' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Copy link' })).toBeNull();
  });
});
