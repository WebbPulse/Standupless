/**
 * The accent picker: a preset saves and paints at once, a custom hex saves on
 * Enter, an invalid hex is never sent, reset sends null, and a failed save
 * puts the saved accent back.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCENT_ATTRIBUTE, paintAccent } from '../../lib/accent';
import type { WorkspaceRead } from '../../types/Api';
import AccentColorSection from './AccentColorSection';

const updateWorkspace =
  vi.fn<(id: string, body: unknown) => Promise<unknown>>();
const refresh = vi.fn(() => Promise.resolve());

vi.mock('../../api/workspaces', () => ({
  updateWorkspace: (id: string, body: unknown) => updateWorkspace(id, body),
}));

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => ({ refresh }),
}));

const workspace = (accent: string | null = null): WorkspaceRead => ({
  id: 'ws-1',
  name: 'Acme',
  slug: 'acme',
  plan: 'free',
  created_at: '2026-10-01T00:00:00Z',
  role: 'admin',
  accent_color: accent,
});

const painted = (): string | null =>
  document.documentElement.getAttribute(ACCENT_ATTRIBUTE);

beforeEach(() => {
  updateWorkspace.mockReset();
  updateWorkspace.mockResolvedValue({});
  refresh.mockClear();
});

afterEach(() => {
  paintAccent(null);
});

describe('AccentColorSection', () => {
  it('marks the default preset and disables reset when no accent is set', () => {
    render(<AccentColorSection workspace={workspace()} />);
    expect(
      screen.getByRole('radio', { name: 'Standupless orange' })
    ).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.getByRole('button', { name: 'Reset to default' })
    ).toBeDisabled();
  });

  it('saves and paints a preset', async () => {
    const user = userEvent.setup();
    render(<AccentColorSection workspace={workspace()} />);
    await user.click(screen.getByRole('radio', { name: 'Blue' }));
    expect(painted()).toBe('#1f7ae0');
    await waitFor(() => {
      expect(updateWorkspace).toHaveBeenCalledWith('ws-1', {
        accent_color: '#1f7ae0',
      });
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('saves a custom hex on Enter and never sends an invalid one', async () => {
    const user = userEvent.setup();
    render(<AccentColorSection workspace={workspace()} />);
    const field = screen.getByLabelText('Custom');
    await user.clear(field);
    await user.type(field, '#12{Enter}');
    expect(updateWorkspace).not.toHaveBeenCalled();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    await user.clear(field);
    await user.type(field, '5A3FC0{Enter}');
    await waitFor(() => {
      expect(updateWorkspace).toHaveBeenCalledWith('ws-1', {
        accent_color: '#5a3fc0',
      });
    });
  });

  it('resets to the default with null', async () => {
    const user = userEvent.setup();
    paintAccent('#1f7ae0');
    render(<AccentColorSection workspace={workspace('#1f7ae0')} />);
    await user.click(screen.getByRole('button', { name: 'Reset to default' }));
    expect(painted()).toBeNull();
    await waitFor(() => {
      expect(updateWorkspace).toHaveBeenCalledWith('ws-1', {
        accent_color: null,
      });
    });
  });

  it('puts the saved accent back when the save fails', async () => {
    const user = userEvent.setup();
    updateWorkspace.mockRejectedValue(new Error('nope'));
    render(<AccentColorSection workspace={workspace('#2f9e44')} />);
    await user.click(screen.getByRole('radio', { name: 'Pink' }));
    await waitFor(() => {
      expect(painted()).toBe('#2f9e44');
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('notes when a pick was adjusted for contrast', async () => {
    const user = userEvent.setup();
    render(<AccentColorSection workspace={workspace()} />);
    const field = screen.getByLabelText('Custom');
    await user.clear(field);
    await user.type(field, '#ffd400{Enter}');
    expect(
      await screen.findByText('Darkened in light mode to stay readable.')
    ).toBeInTheDocument();
  });
});
