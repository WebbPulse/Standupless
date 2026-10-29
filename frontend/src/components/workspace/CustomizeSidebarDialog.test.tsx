/**
 * The Customize sidebar dialog: it lists the items the caller's role has with
 * where each sits, saves a new place or badge style to the account at once,
 * and puts the last saved layout back when the save is refused.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRole } from '../../types/Api';
import CustomizeSidebarDialog from './CustomizeSidebarDialog';

const auth = vi.hoisted(() => {
  const user: Record<string, unknown> = {
    email: 'me@example.com',
    display_name: 'Me',
  };
  return { user, login: vi.fn<(user: Record<string, unknown>) => void>() };
});
const updatePreferences =
  vi.fn<(changes: Record<string, unknown>) => Promise<unknown>>();

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ user: auth.user, login: auth.login }),
}));

vi.mock('../../api/notifications', () => ({
  updatePreferences: (changes: Record<string, unknown>) =>
    updatePreferences(changes),
}));

vi.mock('@webbpulse/api-client/react', () => ({
  invalidateQueries: vi.fn(),
  useOnline: () => true,
}));

vi.mock('../../lib/toast', () => ({ showErrorToast: vi.fn() }));

/** Opens the dialog for someone holding `role`. */
const renderDialog = (role: WorkspaceRole = 'member') =>
  render(<CustomizeSidebarDialog open role={role} onClose={vi.fn()} />);

beforeEach(() => {
  auth.user = {
    email: 'me@example.com',
    display_name: 'Me',
    sidebar_items: { views: 'more', roadmap: 'hide' },
    sidebar_badge_style: 'count',
  };
  auth.login.mockReset();
  updatePreferences.mockReset();
  updatePreferences.mockImplementation((changes) =>
    Promise.resolve({ ...auth.user, ...changes })
  );
});

describe('the Customize sidebar dialog', () => {
  it('shows where each item sits, with unnamed items shown', () => {
    renderDialog();

    expect(screen.getByLabelText('Views')).toHaveValue('more');
    expect(screen.getByLabelText('Roadmap')).toHaveValue('hide');
    expect(screen.getByLabelText('Inbox')).toHaveValue('show');
    expect(screen.getByLabelText('Badge style')).toHaveValue('count');
  });

  it('leaves out the items a guest cannot open', () => {
    renderDialog('guest');

    expect(screen.queryByLabelText('Initiatives')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Customers')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Projects')).toBeInTheDocument();
  });

  it('saves a new place and the saved account replaces the shown one', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.selectOptions(screen.getByLabelText('Views'), 'show');

    expect(updatePreferences).toHaveBeenCalledWith({
      sidebar_items: { views: 'show' },
    });
    expect(auth.login.mock.calls[0]?.[0]['sidebar_items']).toMatchObject({
      views: 'show',
      roadmap: 'hide',
    });
    await waitFor(() => {
      expect(auth.login).toHaveBeenCalledTimes(2);
    });
  });

  it('saves the dot badge style', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.selectOptions(screen.getByLabelText('Badge style'), 'dot');

    expect(updatePreferences).toHaveBeenCalledWith({
      sidebar_badge_style: 'dot',
    });
  });

  it('puts the saved layout back when the save is refused', async () => {
    updatePreferences.mockRejectedValue(new Error('refused'));
    const user = userEvent.setup();
    const held = auth.user;
    renderDialog();

    await user.selectOptions(screen.getByLabelText('Roadmap'), 'show');

    await waitFor(() => {
      expect(auth.login).toHaveBeenLastCalledWith(held);
    });
  });
});
