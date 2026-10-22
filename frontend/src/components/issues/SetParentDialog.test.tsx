/**
 * The parent picker. Covers that it searches the targets' own team for top
 * level issues and leaves the targets out, that picking writes the parent and
 * closes, that "Remove parent" shows only while a target has a parent, and
 * that it offers no candidates when the targets span teams or one of them
 * already has sub-issues.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueRead } from '../../types/Api';
import SetParentDialog, { parentBlocker } from './SetParentDialog';

const listIssues =
  vi.fn<
    (
      workspaceId: string,
      query: Record<string, unknown>
    ) => Promise<{ issues: IssueRead[]; next_cursor: null }>
  >();

vi.mock('../../api/issues', () => ({
  listIssues: (workspaceId: string, query: Record<string, unknown>) =>
    listIssues(workspaceId, query),
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

/** An issue in team t-1 with the given overrides. */
const issue = (id: string, overrides: Partial<IssueRead> = {}): IssueRead => ({
  id,
  workspace_id: 'ws-1',
  team_id: 't-1',
  key: `ENG-${id}`,
  number: 1,
  title: `Issue ${id}`,
  body: null,
  status_id: 'st-1',
  priority: 'none',
  assignee_id: null,
  label_ids: [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: null,
  cycle_id: null,
  project_id: null,
  progress: { total: 0, completed: 0 },
  created_by: 'user-1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...overrides,
});

const onPick = vi.fn<(parentId: string | null) => void>();
const onClose = vi.fn<() => void>();

beforeEach(() => {
  listIssues.mockReset();
  onPick.mockReset();
  onClose.mockReset();
  listIssues.mockResolvedValue({
    issues: [issue('1'), issue('2'), issue('3')],
    next_cursor: null,
  });
});

describe('SetParentDialog', () => {
  it('searches the team for top level issues and leaves the target out', async () => {
    render(
      <SetParentDialog
        issues={[issue('1')]}
        onPick={onPick}
        onClose={onClose}
      />
    );

    expect(
      await screen.findByRole('option', { name: /Issue 2/ })
    ).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Issue 1/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /Remove parent/ })).toBeNull();
    expect(listIssues).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ team_id: 't-1', parent_id: 'none' })
    );
  });

  it('writes the picked parent and closes', async () => {
    render(
      <SetParentDialog
        issues={[issue('1')]}
        onPick={onPick}
        onClose={onClose}
      />
    );

    fireEvent.click(await screen.findByRole('option', { name: /Issue 3/ }));

    expect(onPick).toHaveBeenCalledWith('3');
    expect(onClose).toHaveBeenCalled();
  });

  it('sends the typed text to the server search', async () => {
    render(
      <SetParentDialog
        issues={[issue('1')]}
        onPick={onPick}
        onClose={onClose}
      />
    );

    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'Issue 2' },
    });

    await waitFor(() => {
      expect(listIssues).toHaveBeenCalledWith(
        'ws-1',
        expect.objectContaining({ q: 'Issue 2' })
      );
    });
  });

  it('offers to remove the parent while a target has one', async () => {
    render(
      <SetParentDialog
        issues={[issue('1', { parent_id: '2' }), issue('4')]}
        onPick={onPick}
        onClose={onClose}
      />
    );

    fireEvent.click(
      await screen.findByRole('option', { name: /Remove parent/ })
    );

    expect(onPick).toHaveBeenCalledWith(null);
  });

  it('offers no candidates for targets that span teams', () => {
    render(
      <SetParentDialog
        issues={[issue('1'), issue('4', { team_id: 't-2' })]}
        onPick={onPick}
        onClose={onClose}
      />
    );

    expect(screen.getByText(/share their parent/)).toBeInTheDocument();
    expect(listIssues).not.toHaveBeenCalled();
  });

  it('names a target that already has sub-issues', () => {
    expect(
      parentBlocker([issue('1', { progress: { total: 2, completed: 0 } })])
    ).toMatch(/ENG-1 has sub-issues/);
    expect(parentBlocker([issue('1'), issue('2')])).toBeNull();
  });
});
