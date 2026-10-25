/**
 * The swipe left quick menu: assign to me flips to unassign me on an issue
 * the viewer already holds, a snooze preset sets a reminder on the issue,
 * and a viewer who cannot edit sees only the snooze presets.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderedIssueRead } from '../../../api/issues';
import IssueQuickMenu from './IssueQuickMenu';

const views = vi.hoisted(() => ({ setReminder: vi.fn() }));

vi.mock('../../../api/views', () => ({ setReminder: views.setReminder }));

vi.mock('../../../lib/toast', () => ({
  showToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

/** An issue the quick menu acts on. */
const issue = (assignee: string | null): OrderedIssueRead =>
  ({
    id: 'issue-1',
    key: 'ENG-1',
    assignee_id: assignee,
  }) as OrderedIssueRead;

/** Mounts the menu with spies for its callbacks. */
const renderMenu = (
  overrides: Partial<React.ComponentProps<typeof IssueQuickMenu>> = {}
) => {
  const props = {
    x: 10,
    y: 10,
    issue: issue(null),
    workspaceId: 'ws-1',
    meId: 'user-1',
    canEdit: true,
    onAssignToMe: vi.fn(),
    onPriority: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<IssueQuickMenu {...props} />);
  return props;
};

describe('IssueQuickMenu', () => {
  beforeEach(() => {
    views.setReminder.mockReset();
    views.setReminder.mockResolvedValue({
      remind_at: '2026-10-26T09:00:00Z',
    });
  });

  it('offers assign to me, priority and snooze presets', () => {
    const props = renderMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to me' }));

    expect(props.onAssignToMe).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole('menuitem', { name: /Priority/ })
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole('menuitem', { name: /Snooze/ }).length
    ).toBeGreaterThan(0);
  });

  it('offers unassign me on an issue the viewer holds', () => {
    renderMenu({ issue: issue('user-1') });

    expect(
      screen.getByRole('menuitem', { name: 'Unassign me' })
    ).toBeInTheDocument();
  });

  it('sets a reminder on the issue from a snooze preset', async () => {
    renderMenu();

    fireEvent.click(
      screen.getByRole('menuitem', { name: /Snooze: Tomorrow morning/ })
    );

    await waitFor(() => {
      expect(views.setReminder).toHaveBeenCalledWith(
        'ws-1',
        'issue-1',
        expect.any(String)
      );
    });
  });

  it('shows only the snooze presets to a viewer who cannot edit', () => {
    renderMenu({ canEdit: false });

    expect(
      screen.queryByRole('menuitem', { name: 'Assign to me' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: /Priority/ })
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole('menuitem', { name: /Snooze/ }).length
    ).toBeGreaterThan(0);
  });
});
