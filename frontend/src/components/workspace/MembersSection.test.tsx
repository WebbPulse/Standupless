/**
 * The Members settings section: suspended rows carry a badge, the filter and
 * sort come from and go back to the URL query, and the export downloads the
 * rows shown with their teams. Rows can be selected, one at a time, in a
 * Shift click run or all at once, and the bulk bar sends one request and
 * reports who was skipped and why.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MemberBulkRead,
  MemberBulkUpdate,
  MemberRead,
  WorkspaceRead,
} from '../../types/Api';
import MembersSection from './MembersSection';

const listMemberDirectory = vi.fn<() => Promise<MemberRead[]>>();
const downloadText = vi.fn<(text: string, name: string) => void>();
const bulkUpdateMembers =
  vi.fn<
    (workspaceId: string, payload: MemberBulkUpdate) => Promise<MemberBulkRead>
  >();

vi.mock('../../api/workspaces', () => ({
  listMemberDirectory: () => listMemberDirectory(),
  updateMember: vi.fn(),
  removeMember: vi.fn(),
  revokeInvite: vi.fn(),
  suspendMember: vi.fn(),
  reactivateMember: vi.fn(),
  bulkUpdateMembers: (workspaceId: string, payload: MemberBulkUpdate) =>
    bulkUpdateMembers(workspaceId, payload),
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
  bulkUpdateMembers.mockReset();
});

const crew: MemberRead[] = [
  {
    user_id: 'me',
    email: 'me@example.com',
    display_name: 'Me',
    role: 'owner',
    joined_at: '2026-09-01T00:00:00Z',
    status: 'active',
  },
  {
    user_id: 'ada',
    email: 'ada@example.com',
    display_name: 'Ada',
    role: 'admin',
    joined_at: '2026-09-02T00:00:00Z',
    status: 'active',
  },
  {
    user_id: 'cy',
    email: 'cy@example.com',
    display_name: 'Cy',
    role: 'member',
    joined_at: '2026-09-03T00:00:00Z',
    status: 'active',
  },
  {
    user_id: 'dee',
    email: 'dee@example.com',
    display_name: 'Dee',
    role: 'member',
    joined_at: '2026-09-04T00:00:00Z',
    status: 'active',
  },
  {
    user_id: 'inv-1',
    email: 'new@example.com',
    display_name: null,
    role: 'member',
    joined_at: '2026-09-05T00:00:00Z',
    status: 'invited',
    invite_id: 'inv-1',
  },
];

describe('MembersSection bulk actions', () => {
  beforeEach(() => {
    listMemberDirectory.mockResolvedValue(crew);
  });

  it('leaves the caller and invites unselectable', async () => {
    renderAt();

    expect(await screen.findByLabelText('Select Ada')).toBeInTheDocument();
    expect(screen.queryByLabelText('Select Me')).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText('Select new@example.com')
    ).not.toBeInTheDocument();
  });

  it('selects a run with a Shift click and every row shown from the header', async () => {
    const user = userEvent.setup();
    renderAt();

    await user.click(await screen.findByLabelText('Select Ada'));
    fireEvent.click(screen.getByLabelText('Select Dee'), { shiftKey: true });
    expect(screen.getByLabelText('Select Cy')).toBeChecked();
    expect(
      screen.getByRole('toolbar', { name: 'Selected members' })
    ).toHaveTextContent('3 selected');

    await user.click(screen.getByLabelText('Select all members shown'));
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Search members'), 'cy');
    await user.click(screen.getByLabelText('Select all members shown'));
    expect(screen.getByRole('toolbar')).toHaveTextContent('1 selected');
  });

  it('confirms a suspension with the count and reports who was skipped', async () => {
    bulkUpdateMembers.mockResolvedValue({
      results: [
        {
          user_id: 'ada',
          outcome: 'skipped',
          error_code: 'CONFLICT',
          message: 'A workspace must keep one owner',
        },
        { user_id: 'cy', outcome: 'changed' },
      ],
      changed: 1,
      unchanged: 0,
      skipped: 1,
    });
    const user = userEvent.setup();
    renderAt();

    await user.click(await screen.findByLabelText('Select Ada'));
    await user.click(screen.getByLabelText('Select Cy'));
    await user.click(screen.getByRole('button', { name: 'Suspend' }));
    await user.click(
      await screen.findByRole('button', { name: 'Suspend 2 members' })
    );

    await waitFor(() => {
      expect(bulkUpdateMembers).toHaveBeenCalledWith('ws-1', {
        action: 'suspend',
        user_ids: ['ada', 'cy'],
      });
    });
    const report = await screen.findByRole('status', {
      name: 'Bulk change result',
    });
    expect(report).toHaveTextContent('Suspended 1 member. 1 member skipped.');
    expect(report).toHaveTextContent(
      '1 member skipped: A workspace must keep one owner. Ada'
    );
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });

  it('adds the selection to a team picked from the list', async () => {
    bulkUpdateMembers.mockResolvedValue({
      results: [{ user_id: 'cy', outcome: 'changed' }],
      changed: 1,
      unchanged: 0,
      skipped: 0,
    });
    const user = userEvent.setup();
    renderAt();

    await user.click(await screen.findByLabelText('Select Cy'));
    await user.click(screen.getByRole('button', { name: 'Add to team' }));
    await user.click(await screen.findByRole('button', { name: /Core/ }));

    await waitFor(() => {
      expect(bulkUpdateMembers).toHaveBeenCalledWith('ws-1', {
        action: 'add_to_team',
        user_ids: ['cy'],
        team_id: 't-1',
      });
    });
  });

  it('changes the role of the selection in one request', async () => {
    bulkUpdateMembers.mockResolvedValue({
      results: [{ user_id: 'dee', outcome: 'changed' }],
      changed: 1,
      unchanged: 0,
      skipped: 0,
    });
    const user = userEvent.setup();
    renderAt();

    await user.click(await screen.findByLabelText('Select Dee'));
    await user.click(screen.getByRole('button', { name: 'Change role' }));
    await user.click(await screen.findByRole('button', { name: 'Guest' }));

    await waitFor(() => {
      expect(bulkUpdateMembers).toHaveBeenCalledWith('ws-1', {
        action: 'change_role',
        user_ids: ['dee'],
        role: 'guest',
      });
    });
  });
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

describe('MembersSection last active column', () => {
  it('shows an admin when each member was last active, and Never for one never seen', async () => {
    listMemberDirectory.mockResolvedValue([
      { ...members[0]!, last_active_at: '2026-09-10T12:00:00Z' },
      { ...members[1]!, last_active_at: null },
    ]);
    renderAt();

    expect(
      await screen.findByRole('columnheader', { name: 'Last active' })
    ).toBeInTheDocument();
    expect(screen.getByText('Never')).toBeInTheDocument();
    expect(
      document.querySelector('time[datetime="2026-09-10T12:00:00Z"]')
    ).not.toBeNull();
  });

  it('sorts by last active from the column header', async () => {
    const user = userEvent.setup();
    listMemberDirectory.mockResolvedValue([
      { ...members[0]!, last_active_at: '2026-09-10T12:00:00Z' },
      { ...members[1]!, last_active_at: null },
    ]);
    renderAt();

    await user.click(
      await screen.findByRole('button', { name: 'Last active' })
    );
    expect(screen.getByTestId('search')).toHaveTextContent(
      'member_sort=active'
    );
  });

  it('leaves the column out for a member who is not an admin', async () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <MembersSection workspace={{ ...workspace, role: 'member' }} />
      </MemoryRouter>
    );

    expect(await screen.findByText('Ada')).toBeInTheDocument();
    expect(
      screen.queryByRole('columnheader', { name: 'Last active' })
    ).not.toBeInTheDocument();
  });
});
