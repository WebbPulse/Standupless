/**
 * The sub-issues rail section. Covers changing a child's status from its row,
 * the header count following that change before the rollup lands, filing
 * children one after another from the inline row, Escape leaving it, a failed
 * create giving the title back, and a read only caller seeing no controls.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueRead, StatusRead } from '../../types/Api';
import { clearToasts } from '../../lib/toast';
import SubIssues, { type SubIssuesProps } from './SubIssues';

const updateIssue = vi.fn<(id: string, body: unknown) => Promise<IssueRead>>();
const createIssue = vi.fn<(body: unknown) => Promise<IssueRead>>();

vi.mock('../../api/issues', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/issues')>(
      '../../api/issues'
    );
  return {
    ...actual,
    updateIssue: (_w: string, id: string, body: unknown) =>
      updateIssue(id, body),
    createIssue: (_w: string, body: unknown) => createIssue(body),
  };
});

const statuses: StatusRead[] = [
  { id: 'st-1', name: 'Backlog', category: 'backlog', position: 0 },
  { id: 'st-2', name: 'Todo', category: 'unstarted', position: 1 },
  { id: 'st-3', name: 'Doing', category: 'started', position: 2 },
  { id: 'st-4', name: 'Done', category: 'completed', position: 3 },
];

const child = (id: string, title: string, statusId = 'st-2'): IssueRead => ({
  id,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: `ENG-${id}`,
  number: 1,
  title,
  body: '',
  status_id: statusId,
  priority: 'none',
  assignee_id: null,
  label_ids: [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: 'p-1',
  cycle_id: null,
  project_id: null,
  progress: { total: 0, completed: 0 },
  created_by: 'user-1',
  created_at: '2026-10-24T00:00:00Z',
  updated_at: '2026-10-24T00:00:00Z',
});

const renderSection = (props: Partial<SubIssuesProps> = {}) =>
  render(
    <MemoryRouter>
      <SubIssues
        workspaceId="ws-1"
        slug="mine"
        parent={{ id: 'p-1', team_id: 'team-1' }}
        rows={[]}
        isLoading={false}
        error={null}
        progress={{ total: 0, completed: 0 }}
        statuses={statuses}
        people={[]}
        canEdit
        {...props}
      />
    </MemoryRouter>
  );

beforeEach(() => {
  updateIssue.mockReset();
  createIssue.mockReset();
  clearToasts();
});

describe('changing a sub-issue status', () => {
  it('writes the status picked on the row and counts it at once', async () => {
    const row = child('2', 'A child');
    updateIssue.mockResolvedValue({
      ...row,
      status_id: 'st-4',
      updated_at: '2026-10-24T00:00:01Z',
    });
    const user = userEvent.setup();
    renderSection({ rows: [row], progress: { total: 1, completed: 0 } });

    const section = screen.getByRole('region', { name: 'Sub-issues' });
    expect(within(section).getByText('0/1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Status: Todo' }));
    await user.keyboard('4');

    expect(updateIssue).toHaveBeenCalledWith('2', { status_id: 'st-4' });
    expect(
      screen.getByRole('button', { name: 'Status: Done' })
    ).toBeInTheDocument();
    expect(within(section).getByText('1/1')).toBeInTheDocument();
    expect(screen.getByText('A child').closest('a')).toHaveAttribute(
      'href',
      '/w/mine/issues/ENG-2'
    );
  });

  it('keeps the rollup count while some children are not loaded', () => {
    renderSection({
      rows: [child('2', 'A child', 'st-4')],
      progress: { total: 4, completed: 2 },
    });

    expect(screen.getByText('2/4')).toBeInTheDocument();
  });
});

describe('adding sub-issues inline', () => {
  it('files a child per Enter in the parent team and stays for the next', async () => {
    createIssue
      .mockResolvedValueOnce(child('5', 'First'))
      .mockResolvedValueOnce(child('6', 'Second'));
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: 'Add sub-issue' }));
    const input = screen.getByRole('textbox', { name: 'New sub-issue title' });
    expect(input).toHaveFocus();

    await user.type(input, 'First{Enter}');

    expect(createIssue).toHaveBeenCalledWith({
      team_id: 'team-1',
      title: 'First',
      parent_id: 'p-1',
    });
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    expect(await screen.findByText('First')).toBeInTheDocument();
    expect(screen.getByText('0/1')).toBeInTheDocument();

    await user.type(input, 'Second{Enter}');

    expect(createIssue).toHaveBeenLastCalledWith({
      team_id: 'team-1',
      title: 'Second',
      parent_id: 'p-1',
    });
    expect(await screen.findByText('Second')).toBeInTheDocument();
    expect(screen.getByText('0/2')).toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it('leaves the row on Escape without filing anything', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: 'Add sub-issue' }));
    await user.type(
      screen.getByRole('textbox', { name: 'New sub-issue title' }),
      'Half typed{Escape}'
    );

    expect(
      screen.queryByRole('textbox', { name: 'New sub-issue title' })
    ).not.toBeInTheDocument();
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('gives the title back when the create fails', async () => {
    createIssue.mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: 'Add sub-issue' }));
    const input = screen.getByRole('textbox', { name: 'New sub-issue title' });
    await user.type(input, 'Lost{Enter}');

    await waitFor(() => {
      expect(input).toHaveValue('Lost');
    });
  });
});

describe('a read only caller', () => {
  it('sees the rows without the status pickers or the add row', () => {
    renderSection({ rows: [child('2', 'A child')], canEdit: false });

    expect(screen.getByRole('button', { name: 'Status: Todo' })).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Add sub-issue' })
    ).not.toBeInTheDocument();
  });
});
