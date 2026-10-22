/**
 * The Convert to project confirmation. Covers that it says what will happen,
 * that confirming converts, closes and hands the result on, that cancelling
 * converts nothing, and that a refusal keeps the dialog open with a notice.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToasts, currentToasts } from '../../lib/toast';
import type { IssueConversionRead, IssueRead } from '../../types/Api';
import ConvertToProjectDialog from './ConvertToProjectDialog';

const convertIssueToProject =
  vi.fn<
    (workspaceId: string, issueId: string) => Promise<IssueConversionRead>
  >();

vi.mock('../../api/issues', () => ({
  convertIssueToProject: (workspaceId: string, issueId: string) =>
    convertIssueToProject(workspaceId, issueId),
}));

const issue: IssueRead = {
  id: 'i-1',
  workspace_id: 'ws-1',
  team_id: 't-1',
  key: 'ENG-1',
  number: 1,
  title: 'Rebuild onboarding',
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
  progress: { total: 2, completed: 0 },
  created_by: 'user-1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
};

const result = {
  project: { project_id: 'p-1', name: 'Rebuild onboarding' },
  issue: { ...issue, project_id: 'p-1' },
  moved_issue_ids: ['i-2', 'i-3'],
} as unknown as IssueConversionRead;

const onClose = vi.fn<() => void>();
const onConverted = vi.fn<(converted: IssueConversionRead) => void>();

beforeEach(() => {
  convertIssueToProject.mockReset();
  onClose.mockReset();
  onConverted.mockReset();
});

afterEach(() => {
  clearToasts();
});

/** Renders the dialog on the shared issue. */
const open = (): void => {
  render(
    <ConvertToProjectDialog
      workspaceId="ws-1"
      issue={issue}
      onClose={onClose}
      onConverted={onConverted}
    />
  );
};

describe('ConvertToProjectDialog', () => {
  it('says what the conversion will do', () => {
    open();

    expect(
      screen.getByText(
        'A project named "Rebuild onboarding" is created from ENG-1. Its 2 sub-issues move into the project. ENG-1 is linked to the project and closed.'
      )
    ).toBeInTheDocument();
  });

  it('converts, closes and hands the result on', async () => {
    convertIssueToProject.mockResolvedValue(result);
    open();

    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));

    await waitFor(() => {
      expect(onConverted).toHaveBeenCalledWith(result);
    });
    expect(convertIssueToProject).toHaveBeenCalledWith('ws-1', 'i-1');
    expect(onClose).toHaveBeenCalled();
    expect(currentToasts().map((toast) => toast.message)).toEqual([
      'Converted ENG-1 into Rebuild onboarding',
    ]);
  });

  it('converts nothing when cancelled', () => {
    open();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalled();
    expect(convertIssueToProject).not.toHaveBeenCalled();
  });

  it('stays open with a notice when the conversion is refused', async () => {
    convertIssueToProject.mockRejectedValue(new Error('refused'));
    open();

    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));

    await waitFor(() => {
      expect(currentToasts().map((toast) => toast.tone)).toEqual(['error']);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(onConverted).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Convert' })).toBeEnabled();
  });
});
