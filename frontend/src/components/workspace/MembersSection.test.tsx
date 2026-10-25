/**
 * The Members settings section: suspended rows carry a badge, the filter and
 * sort come from and go back to the URL query, and the export downloads the
 * rows shown with their teams.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberRead, WorkspaceRead } from '../../types/Api';
import MembersSection from './MembersSection';

const listMemberDirectory = vi.fn<() => Promise<MemberRead[]>>();
const downloadText = vi.fn<(text: string, name: string) => void>();

vi.mock('../../api/workspaces', () => ({
  listMemberDirectory: () => listMemberDirectory(),
  updateMember: vi.fn(),
  removeMember: vi.fn(),
  revokeInvite: vi.fn(),
  suspendMember: vi.fn(),
  reactivateMember: vi.fn(),
}));

vi.mock('../../api/teams', () => ({
  listTeams: () => Promise.resolve([{ id: 't-1', name: 'Core' }]),
  listTeamMembers: () => Promise.resolve([{ user_id: 'ada' }]),
}));

vi.mock('../../lib/download', async () => {
  const actual =
    await vi.importActual<typeof import('../../lib/download')>(
      '../../lib/download'
    );
  return {
    ...actual,
    downloadText: (text: string, name: string) => downloadText(text, name),
  };
});

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'me' } }),
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

const workspace: WorkspaceRead = {
  id: 'ws-1',
  name: 'Acme',
  slug: 'acme',
  plan: 'free',
  created_at: '2026-09-01T00:00:00Z',
  role: 'owner',
};

const members: MemberRead[] = [
  {
    user_id: 'ada',
    email: 'ada@example.com',
    display_name: 'Ada',
    role: 'admin',
    joined_at: '2026-09-01T00:00:00Z',
    status: 'active',
  },
  {
    user_id: 'bob',
    email: 'bob@example.com',
    display_name: 'Bob',
    role: 'member',
    joined_at: '2026-09-02T00:00:00Z',
    status: 'suspended',
  },
];

/** Shows the current query string so a test can read what the section wrote. */
const Probe = () => {
  const location = useLocation();
  return <output data-testid="search">{location.search}</output>;
};

const renderAt = (search = '') =>
  render(
    <MemoryRouter initialEntries={[`/settings${search}`]}>
      <MembersSection workspace={workspace} />
      <Probe />
    </MemoryRouter>
  );

beforeEach(() => {
  listMemberDirectory.mockReset();
  listMemberDirectory.mockResolvedValue(members);
  downloadText.mockReset();
});

describe('MembersSection', () => {
  it('badges a suspended member and lists them after active members', async () => {
    renderAt();

    expect(await screen.findByText('Suspended')).toBeInTheDocument();
    const names = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent ?? '');
    expect(names[0]).toContain('Ada');
    expect(names[1]).toContain('Bob');
  });

  it('reads the status filter from the URL', async () => {
    renderAt('?member_status=suspended');

    expect(await screen.findByText('Bob')).toBeInTheDocument();
    expect(screen.queryByText('Ada')).not.toBeInTheDocument();
  });

  it('keeps the sort and search in the URL', async () => {
    const user = userEvent.setup();
    renderAt();

    await user.click(await screen.findByRole('button', { name: 'Email' }));
    expect(screen.getByTestId('search').textContent).toContain(
      'member_sort=email'
    );
    await user.click(screen.getByRole('button', { name: 'Email' }));
    expect(screen.getByTestId('search').textContent).toContain(
      'member_dir=desc'
    );

    await user.type(screen.getByLabelText('Search members'), 'bo');
    expect(screen.getByTestId('search').textContent).toContain('member_q=bo');
    expect(screen.queryByText('Ada')).not.toBeInTheDocument();
  });

  it('exports the rows shown with their teams', async () => {
    const user = userEvent.setup();
    renderAt('?member_status=active');

    await user.click(await screen.findByRole('button', { name: 'Export CSV' }));

    await waitFor(() => {
      expect(downloadText).toHaveBeenCalledOnce();
    });
    const [text, name] = downloadText.mock.calls[0] ?? ['', ''];
    expect(name).toMatch(/^acme-members-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(text).toBe(
      'Name,Email,Role,Status,Joined,Teams\r\nAda,ada@example.com,Admin,Active,2026-09-01,Core\r\n'
    );
  });
});
