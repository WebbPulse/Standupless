/**
 * The workspace URL field: a bad or reserved slug is refused before the
 * server is asked, a free slug is checked then saved and the workspace is
 * re-read, a taken slug cannot be saved, and the retired slugs are listed.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlugAvailabilityRead, WorkspaceRead } from '../../types/Api';
import WorkspaceUrlSection from './WorkspaceUrlSection';

const updateWorkspace =
  vi.fn<(id: string, body: unknown) => Promise<unknown>>();
const checkSlugAvailability =
  vi.fn<(id: string, slug: string) => Promise<SlugAvailabilityRead>>();
const refresh = vi.fn(() => Promise.resolve());

vi.mock('../../api/workspaces', () => ({
  updateWorkspace: (id: string, body: unknown) => updateWorkspace(id, body),
  checkSlugAvailability: (id: string, slug: string) =>
    checkSlugAvailability(id, slug),
}));

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => ({ refresh }),
}));

const workspace = (retired: string[] = []): WorkspaceRead => ({
  id: 'ws-1',
  name: 'Acme',
  slug: 'acme',
  plan: 'free',
  created_at: '2026-10-01T00:00:00Z',
  role: 'admin',
  retired_slugs: retired,
});

beforeEach(() => {
  updateWorkspace.mockReset();
  updateWorkspace.mockResolvedValue({});
  checkSlugAvailability.mockReset();
  refresh.mockClear();
});

describe('WorkspaceUrlSection', () => {
  it('refuses a reserved or malformed slug without asking the server', async () => {
    const user = userEvent.setup();
    render(<WorkspaceUrlSection workspace={workspace()} />);
    const field = screen.getByLabelText('Workspace URL');
    await user.clear(field);
    await user.type(field, 'settings');
    expect(
      screen.getByText('That URL is reserved. Pick another.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change URL' })).toBeDisabled();
    expect(checkSlugAvailability).not.toHaveBeenCalled();
  });

  it('checks a free slug, saves it and re-reads the workspace', async () => {
    checkSlugAvailability.mockResolvedValue({
      slug: 'acme-labs',
      available: true,
      reason: null,
    });
    const user = userEvent.setup();
    render(<WorkspaceUrlSection workspace={workspace()} />);
    const field = screen.getByLabelText('Workspace URL');
    await user.clear(field);
    await user.type(field, 'acme-labs');
    const save = screen.getByRole('button', { name: 'Change URL' });
    await waitFor(() => {
      expect(save).toBeEnabled();
    });
    expect(checkSlugAvailability).toHaveBeenLastCalledWith('ws-1', 'acme-labs');
    await user.click(save);
    await waitFor(() => {
      expect(updateWorkspace).toHaveBeenCalledWith('ws-1', {
        slug: 'acme-labs',
      });
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('cannot save a slug the server says is taken', async () => {
    checkSlugAvailability.mockResolvedValue({
      slug: 'other',
      available: false,
      reason: 'taken',
    });
    const user = userEvent.setup();
    render(<WorkspaceUrlSection workspace={workspace()} />);
    const field = screen.getByLabelText('Workspace URL');
    await user.clear(field);
    await user.type(field, 'other');
    expect(await screen.findByText('That URL is taken.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change URL' })).toBeDisabled();
  });

  it('lists the slugs that redirect here', () => {
    render(<WorkspaceUrlSection workspace={workspace(['old-acme'])} />);
    expect(
      screen.getByText('Redirecting here: /w/old-acme')
    ).toBeInTheDocument();
  });
});
