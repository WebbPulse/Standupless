/**
 * The Duplicate issue confirmation. Covers that it names the sub-issues, that
 * confirming with the toggle off or on duplicates with that choice and hands
 * the copy on, and that a refusal keeps the dialog open.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToasts } from '../../lib/toast';
import type { IssueRead } from '../../types/Api';
import DuplicateIssueDialog from './DuplicateIssueDialog';

const duplicateIssue =
  vi.fn<
    (
      workspaceId: string,
      issueId: string,
      includeSubIssues?: boolean
    ) => Promise<IssueRead>
  >();

vi.mock('../../api/issues', () => ({
  duplicateIssue: (
    workspaceId: string,
    issueId: string,
    includeSubIssues?: boolean
  ) => duplicateIssue(workspaceId, issueId, includeSubIssues),
}));

const issue = (id: string, overrides: Partial<IssueRead> = {}): IssueRead => ({
  id,
  workspace_id: 'ws-1',
  team_id: 't-1',
  key: `ENG-${id}`,
  number: Number(id),
  title: 'Checklist',
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
  progress: { total: 3, completed: 1 },
  created_by: 'user-1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...overrides,
});

beforeEach(() => {
  duplicateIssue.mockReset();
});

afterEach(() => {
  clearToasts();
});

describe('DuplicateIssueDialog', () => {
  it('names the sub-issues and offers the toggle, off by default', () => {
    render(
      <DuplicateIssueDialog
        workspaceId="ws-1"
        issue={issue('1')}
        onClose={vi.fn()}
        onDuplicated={vi.fn()}
      />
    );

    expect(screen.getByText(/ENG-1 has 3 sub-issues/)).toBeInTheDocument();
    expect(screen.getByLabelText('Include sub-issues')).not.toBeChecked();
  });

  it('duplicates only the issue when the toggle stays off', async () => {
    duplicateIssue.mockResolvedValue(issue('7'));
    const onClose = vi.fn();
    const onDuplicated = vi.fn();
    render(
      <DuplicateIssueDialog
        workspaceId="ws-1"
        issue={issue('1')}
        onClose={onClose}
        onDuplicated={onDuplicated}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));

    await waitFor(() => {
      expect(onDuplicated).toHaveBeenCalled();
    });
    expect(duplicateIssue).toHaveBeenCalledWith('ws-1', '1', false);
    expect(onClose).toHaveBeenCalled();
  });

  it('copies the sub-issues when the toggle is on', async () => {
    duplicateIssue.mockResolvedValue(issue('7'));
    const onDuplicated = vi.fn();
    render(
      <DuplicateIssueDialog
        workspaceId="ws-1"
        issue={issue('1')}
        onClose={vi.fn()}
        onDuplicated={onDuplicated}
      />
    );

    fireEvent.click(screen.getByLabelText('Include sub-issues'));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));

    await waitFor(() => {
      expect(onDuplicated).toHaveBeenCalled();
    });
    expect(duplicateIssue).toHaveBeenCalledWith('ws-1', '1', true);
  });

  it('stays open when the duplicate is refused', async () => {
    duplicateIssue.mockRejectedValue(new Error('boom'));
    const onClose = vi.fn();
    render(
      <DuplicateIssueDialog
        workspaceId="ws-1"
        issue={issue('1')}
        onClose={onClose}
        onDuplicated={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Duplicate' })).toBeEnabled();
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
