/**
 * The team members section. Covers picking several people and granting each
 * one, the single notice that sums up a partly failed batch with the failures
 * left picked, the bulk bar's role and removal actions, and its refusal to
 * demote or remove every team owner.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToasts, currentToasts } from '../../lib/toast';
import type {
  MemberRead,
  TeamMemberRead,
  TeamMemberUpdate,
} from '../../types/Api';
import {
  LAST_OWNER_REASON,
  batchSummary,
  maskEmail,
  runBounded,
} from '../../lib/teamMemberBatch';
import TeamMembersSection from './TeamMembersSection';

const teamMember = (
  id: string,
  role: TeamMemberRead['role']
): TeamMemberRead => ({
  user_id: id,
  email: `${id}@example.com`,
  display_name: id,
  role,
  added_at: '2026-01-01T00:00:00Z',
});

const workspaceMember = (id: string): MemberRead => ({
  user_id: id,
  email: `${id}@example.com`,
  display_name: id,
  role: 'member',
  joined_at: '2026-01-01T00:00:00Z',
});

let teamMembers: TeamMemberRead[] = [];
let workspaceMembers: MemberRead[] = [];

const setTeamMember =
  vi.fn<(userId: string, body: TeamMemberUpdate) => Promise<TeamMemberRead>>();
const removeTeamMember = vi.fn<(userId: string) => Promise<void>>();

vi.mock('../../api/teams', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/teams')>('../../api/teams');
  return {
    ...actual,
    listTeamMembers: () => Promise.resolve(teamMembers),
    setTeamMember: (
      _w: string,
      _t: string,
      userId: string,
      body: TeamMemberUpdate
    ) => setTeamMember(userId, body),
    removeTeamMember: (_w: string, _t: string, userId: string) =>
      removeTeamMember(userId),
  };
});

vi.mock('../../api/workspaces', async () => {
  const actual = await vi.importActual<typeof import('../../api/workspaces')>(
    '../../api/workspaces'
  );
  return {
    ...actual,
    listMembers: () => Promise.resolve(workspaceMembers),
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

/** Renders the section as a team admin who may read the roster. */
const renderSection = () =>
  render(
    <MemoryRouter>
      <TeamMembersSection
        workspaceId="ws-1"
        teamId="team-1"
        canEdit={true}
        canReadWorkspaceMembers={true}
      />
    </MemoryRouter>
  );

/** The messages of every notice on screen. */
const toastMessages = (): string[] =>
  currentToasts().map((toast) => toast.message);

beforeEach(() => {
  clearToasts();
  setTeamMember.mockReset();
  removeTeamMember.mockReset();
  teamMembers = [teamMember('ada', 'admin')];
  workspaceMembers = ['ada', 'bo', 'cy', 'di'].map(workspaceMember);
  setTeamMember.mockImplementation((userId, body) =>
    Promise.resolve(teamMember(userId, body.role))
  );
  removeTeamMember.mockResolvedValue(undefined);
});

describe('helpers', () => {
  it('masks an email down to its first letter and domain', () => {
    expect(maskEmail('tyler@example.com')).toBe('t***@example.com');
    expect(maskEmail('nope')).toBe('***');
  });

  it('sums up a batch', () => {
    expect(batchSummary('Added', 5, 0)).toBe('Added 5');
    expect(batchSummary('Added', 6, 1)).toBe('Added 5, 1 failed');
    expect(batchSummary('Added', 2, 2)).toBe('2 failed');
  });

  it('keeps at most the limit in flight and answers the failures in order', async () => {
    let inFlight = 0;
    let peak = 0;
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    const failed = await runBounded(ids, 4, async (id) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      if (id === 'c' || id === 'g') throw new Error('nope');
    });
    expect(peak).toBe(4);
    expect(failed).toEqual(['c', 'g']);
  });
});

describe('TeamMembersSection', () => {
  it('adds every picked person with one grant each', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(
      await screen.findByRole('button', { name: /Add members: Choose people/ })
    );
    const list = screen.getByRole('listbox', { name: 'Add members' });
    expect(within(list).queryByText('ada')).toBeNull();
    expect(within(list).getByText('b***@example.com')).toBeInTheDocument();
    await user.click(within(list).getByText('bo'));
    await user.click(within(list).getByText('cy'));
    await user.click(within(list).getByText('di'));

    await user.click(screen.getByRole('button', { name: 'Add 3 to team' }));

    await waitFor(() => {
      expect(toastMessages()).toContain('Added 3');
    });
    expect(setTeamMember).toHaveBeenCalledTimes(3);
    expect(setTeamMember).toHaveBeenCalledWith('bo', { role: 'member' });
    expect(setTeamMember).toHaveBeenCalledWith('cy', { role: 'member' });
    expect(setTeamMember).toHaveBeenCalledWith('di', { role: 'member' });
  });

  it('sums up a partial failure and leaves the failures picked', async () => {
    setTeamMember.mockImplementation((userId, body) =>
      userId === 'cy'
        ? Promise.reject(new Error('nope'))
        : Promise.resolve(teamMember(userId, body.role))
    );
    const user = userEvent.setup();
    renderSection();

    await user.click(
      await screen.findByRole('button', { name: /Add members: Choose people/ })
    );
    const list = screen.getByRole('listbox', { name: 'Add members' });
    await user.click(within(list).getByText('bo'));
    await user.click(within(list).getByText('cy'));
    await user.click(within(list).getByText('di'));
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Add 3 to team' }));

    await waitFor(() => {
      expect(toastMessages()).toContain('Added 2, 1 failed');
    });
    expect(
      await screen.findByRole('button', { name: 'Add 1 to team' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Add members: cy' })
    ).toBeInTheDocument();
  });

  it('changes the role of every checked member from the bulk bar', async () => {
    teamMembers = [
      teamMember('ada', 'admin'),
      teamMember('bo', 'member'),
      teamMember('cy', 'member'),
    ];
    const user = userEvent.setup();
    renderSection();

    await user.click(
      await screen.findByRole('checkbox', { name: 'Select bo' })
    );
    await user.click(screen.getByRole('checkbox', { name: 'Select cy' }));
    const bar = screen.getByRole('toolbar', { name: 'Selected team members' });
    await user.click(
      within(bar).getByRole('button', { name: 'Make team owner' })
    );

    await waitFor(() => {
      expect(toastMessages()).toContain('Updated 2');
    });
    expect(setTeamMember).toHaveBeenCalledWith('bo', { role: 'admin' });
    expect(setTeamMember).toHaveBeenCalledWith('cy', { role: 'admin' });
  });

  it('removes every checked member from the bulk bar', async () => {
    teamMembers = [
      teamMember('ada', 'admin'),
      teamMember('bo', 'member'),
      teamMember('cy', 'member'),
    ];
    const user = userEvent.setup();
    renderSection();

    await user.click(
      await screen.findByRole('checkbox', { name: 'Select bo' })
    );
    await user.click(screen.getByRole('checkbox', { name: 'Select cy' }));
    const bar = screen.getByRole('toolbar', { name: 'Selected team members' });
    await user.click(
      within(bar).getByRole('button', { name: 'Remove from team' })
    );

    await waitFor(() => {
      expect(toastMessages()).toContain('Removed 2');
    });
    expect(removeTeamMember).toHaveBeenCalledTimes(2);
  });

  it('refuses to demote or remove the last team owner', async () => {
    teamMembers = [teamMember('ada', 'admin'), teamMember('bo', 'member')];
    const user = userEvent.setup();
    renderSection();

    await user.click(
      await screen.findByRole('checkbox', { name: 'Select all team members' })
    );
    const bar = screen.getByRole('toolbar', { name: 'Selected team members' });
    expect(
      within(bar).getByRole('button', { name: 'Make member' })
    ).toBeDisabled();
    expect(
      within(bar).getByRole('button', { name: 'Remove from team' })
    ).toBeDisabled();
    expect(within(bar).getByText(LAST_OWNER_REASON)).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Select ada' }));
    expect(
      within(bar).getByRole('button', { name: 'Remove from team' })
    ).toBeEnabled();
    expect(within(bar).queryByText(LAST_OWNER_REASON)).toBeNull();
  });
});
