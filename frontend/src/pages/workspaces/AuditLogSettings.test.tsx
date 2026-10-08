/**
 * The workspace audit log page. An admin reads the events with their changes,
 * narrows them by actor and event type, pages on, and downloads the CSV; a plan
 * without the audit log points at the plans; anyone below admin is told they
 * cannot read it and nothing is fetched.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  AuditEventRead,
  AuditLogFilters,
  AuditLogRead,
  MemberRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import AuditLogSettings from './AuditLogSettings';

const listAuditLog =
  vi.fn<
    (
      filters: AuditLogFilters,
      cursor: string | undefined
    ) => Promise<AuditLogRead>
  >();
const exportAuditLogCsv =
  vi.fn<(filters: AuditLogFilters) => Promise<string>>();
const listMembers = vi.fn<() => Promise<MemberRead[]>>();
const downloadText = vi.fn<(text: string, name: string) => void>();

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
    isBusy: false,
    login: vi.fn(),
    logout: vi.fn(),
    checkAuthStatus: vi.fn(),
  }),
}));

vi.mock('../../api/workspaces', () => ({
  listAuditLog: (
    _workspaceId: string,
    filters: AuditLogFilters,
    cursor?: string
  ) => listAuditLog(filters, cursor),
  exportAuditLogCsv: (_workspaceId: string, filters: AuditLogFilters) =>
    exportAuditLogCsv(filters),
  listMembers: () => listMembers(),
}));

vi.mock('../../lib/download', () => ({
  downloadText: (text: string, name: string) => {
    downloadText(text, name);
  },
  todayStamp: () => '2026-10-07',
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

const useWorkspaceMock = vi.fn<() => WorkspaceContextType>();

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => useWorkspaceMock(),
}));

/** A resolved workspace context with the caller holding `role`. */
const resolved = (role: WorkspaceRole): WorkspaceContextType => {
  const workspace: WorkspaceRead = {
    id: 'ws-1',
    name: 'Engineering',
    slug: 'engineering',
    plan: 'business',
    created_at: '2026-09-17T00:00:00Z',
    role,
  };
  return {
    workspace,
    isLoading: false,
    notFound: false,
    error: null,
    refresh: vi.fn(() => Promise.resolve()),
  };
};

/** One audit event in the shape the contract answers with. */
const event = (over: Partial<AuditEventRead> = {}): AuditEventRead => ({
  audit_id: 'a1',
  event: 'member.role_changed',
  event_label: 'Member role changed',
  actor_id: 'user-1',
  actor_kind: 'user',
  actor_name: 'Olive Owner',
  source: 'web',
  ip: '203.0.113.7',
  amr: ['pwd'],
  target_type: 'member',
  target_id: 'user-2',
  target_label: 'Mo Member',
  before: { role: 'member' },
  after: { role: 'admin' },
  created_at: '2026-10-06T12:00:00Z',
  ...over,
});

/** One page of the log, on a plan that includes it unless told otherwise. */
const page = (over: Partial<AuditLogRead> = {}): AuditLogRead => ({
  events: [event()],
  next_cursor: null,
  available: true,
  event_types: [
    { key: 'member.role_changed', label: 'Member role changed' },
    { key: 'api_key.created', label: 'API key created' },
  ],
  ...over,
});

/** Mounts the page inside a router, which the shell and section nav require. */
const renderPage = () =>
  render(
    <MemoryRouter>
      <AuditLogSettings />
    </MemoryRouter>
  );

beforeEach(() => {
  listAuditLog.mockReset();
  exportAuditLogCsv.mockReset();
  listMembers.mockReset();
  downloadText.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('admin'));
  listMembers.mockResolvedValue([
    {
      user_id: 'user-1',
      email: 'owner@example.com',
      display_name: 'Olive Owner',
      role: 'owner',
      joined_at: '2026-09-17T00:00:00Z',
    },
  ]);
  listAuditLog.mockResolvedValue(page());
});

describe('the workspace audit log page', () => {
  it('shows who changed what, with the before and after', async () => {
    renderPage();

    expect(await screen.findByText('Mo Member')).toBeInTheDocument();
    const log = within(screen.getByRole('list', { name: 'Audit events' }));
    expect(log.getByText('Olive Owner')).toBeInTheDocument();
    expect(log.getByText('Member role changed')).toBeInTheDocument();
    expect(log.getByText('role: member to admin')).toBeInTheDocument();
    expect(log.getByText(/203\.0\.113\.7/)).toBeInTheDocument();
  });

  it('narrows the log by actor and event type', async () => {
    renderPage();
    await screen.findByText('Mo Member');

    await userEvent.selectOptions(
      await screen.findByLabelText('Event'),
      'api_key.created'
    );
    await waitFor(() => {
      expect(listAuditLog).toHaveBeenLastCalledWith(
        { event: 'api_key.created' },
        undefined
      );
    });

    await screen.findByRole('option', { name: 'Olive Owner' });
    await userEvent.selectOptions(screen.getByLabelText('Actor'), 'user-1');
    await waitFor(() => {
      expect(listAuditLog).toHaveBeenLastCalledWith(
        { actor_id: 'user-1', event: 'api_key.created' },
        undefined
      );
    });
  });

  it('loads the next page from the cursor', async () => {
    listAuditLog.mockImplementation((_filters, cursor) =>
      Promise.resolve(
        cursor === undefined
          ? page({ next_cursor: 'c1' })
          : page({
              events: [
                event({
                  audit_id: 'a2',
                  event: 'api_key.created',
                  event_label: 'API key created',
                  target_label: 'CI key',
                  before: null,
                  after: null,
                }),
              ],
            })
      )
    );
    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Load more' })
    );

    expect(await screen.findByText('CI key')).toBeInTheDocument();
    expect(listAuditLog).toHaveBeenCalledWith({}, 'c1');
  });

  it('downloads the filtered log as CSV', async () => {
    exportAuditLogCsv.mockResolvedValue('created_at,event\r\n');
    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Export CSV' })
    );

    await waitFor(() => {
      expect(downloadText).toHaveBeenCalledWith(
        'created_at,event\r\n',
        'audit-log-2026-10-07.csv'
      );
    });
  });

  it('points a plan without the audit log at the plans', async () => {
    listAuditLog.mockResolvedValue(page({ events: [], available: false }));
    renderPage();

    expect(
      await screen.findByRole('link', { name: 'View plans' })
    ).toHaveAttribute('href', '/w/engineering/settings/billing');
    expect(
      screen.queryByRole('button', { name: 'Export CSV' })
    ).not.toBeInTheDocument();
  });

  it('tells a member they cannot read it', () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    renderPage();

    expect(
      screen.getByText(
        'Only workspace owners and admins can read the audit log.'
      )
    ).toBeInTheDocument();
    expect(listAuditLog).not.toHaveBeenCalled();
  });
});
