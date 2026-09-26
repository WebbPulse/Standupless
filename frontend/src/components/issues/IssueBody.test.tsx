/**
 * The description editor. Covers that clicking the description edits it in
 * place with no preview pane, in the body font rather than monospace, that
 * Ctrl or Cmd Enter saves and Escape cancels, that an unchanged draft saves
 * nothing, that clicking a link follows it rather than editing, that pasted
 * files attach to the issue, and that a reader cannot edit at all.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueRead } from '../../types/Api';
import IssueBody from './IssueBody';

const updateIssue = vi.fn<(id: string, body: unknown) => Promise<IssueRead>>();

vi.mock('../../api/issues', () => ({
  updateIssue: (_w: string, id: string, body: unknown) => updateIssue(id, body),
}));

/** The issue under edit, with a Markdown body that holds a link. */
const issue: IssueRead = {
  id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: 'ENG-1',
  number: 1,
  title: 'Cache the token',
  body: 'Some **markdown** and [a link](https://example.com)',
  status_id: 'st-1',
  priority: 'high',
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
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
};

/** Renders the body with spies for the save and the attach. */
const renderBody = (canEdit = true) => {
  const onSaved = vi.fn();
  const onDropFiles = vi.fn();
  render(
    <IssueBody
      workspaceId="ws-1"
      issue={issue}
      canEdit={canEdit}
      onSaved={onSaved}
      onDropFiles={onDropFiles}
    />
  );
  return { onSaved, onDropFiles };
};

beforeEach(() => {
  updateIssue.mockReset();
  updateIssue.mockImplementation((_id, body) =>
    Promise.resolve({ ...issue, ...(body as Partial<IssueRead>) })
  );
});

describe('editing the description in place', () => {
  it('opens the editor on a click, focused, with no preview pane', async () => {
    const user = userEvent.setup();
    renderBody();

    await user.click(screen.getByText('markdown', { selector: 'strong' }));

    const field = screen.getByLabelText('Description');
    expect(field).toHaveValue(issue.body);
    expect(field).toHaveFocus();
    expect(field).not.toHaveClass('font-mono');
    expect(field).toHaveClass('resize-none');
    expect(screen.queryByText('Preview')).not.toBeInTheDocument();
    expect(
      screen.queryByText('markdown', { selector: 'strong' })
    ).not.toBeInTheDocument();
  });

  it('saves on Ctrl Enter', async () => {
    const user = userEvent.setup();
    const { onSaved } = renderBody();

    await user.click(screen.getByRole('button', { name: 'Edit description' }));
    await user.clear(screen.getByLabelText('Description'));
    await user.type(screen.getByLabelText('Description'), 'Rewritten');
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-1', { body: 'Rewritten' });
    });
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });
    expect(screen.queryByLabelText('Description')).not.toBeInTheDocument();
  });

  it('saves on Cmd Enter', async () => {
    const user = userEvent.setup();
    renderBody();

    await user.click(screen.getByRole('button', { name: 'Edit description' }));
    await user.type(screen.getByLabelText('Description'), '!');
    await user.keyboard('{Meta>}{Enter}{/Meta}');

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-1', {
        body: `${issue.body ?? ''}!`,
      });
    });
  });

  it('cancels on Escape without saving and drops the draft', async () => {
    const user = userEvent.setup();
    renderBody();

    await user.click(screen.getByRole('button', { name: 'Edit description' }));
    await user.type(screen.getByLabelText('Description'), ' more');
    await user.keyboard('{Escape}');

    expect(screen.queryByLabelText('Description')).not.toBeInTheDocument();
    expect(updateIssue).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Edit description' }));
    expect(screen.getByLabelText('Description')).toHaveValue(issue.body);
  });

  it('keeps the draft when the editor loses focus', async () => {
    const user = userEvent.setup();
    renderBody();

    await user.click(screen.getByRole('button', { name: 'Edit description' }));
    await user.type(screen.getByLabelText('Description'), ' more');
    await user.click(document.body);

    expect(screen.getByLabelText('Description')).toHaveValue(
      `${issue.body ?? ''} more`
    );
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it('closes an unchanged draft without a request', async () => {
    const user = userEvent.setup();
    renderBody();

    await user.click(screen.getByRole('button', { name: 'Edit description' }));
    await user.click(screen.getByRole('button', { name: 'Save description' }));

    expect(screen.queryByLabelText('Description')).not.toBeInTheDocument();
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it('follows a link rather than editing when the link is clicked', async () => {
    const user = userEvent.setup();
    renderBody();

    await user.click(screen.getByRole('link', { name: 'a link' }));

    expect(screen.queryByLabelText('Description')).not.toBeInTheDocument();
  });

  it('attaches pasted files to the issue rather than inserting them', async () => {
    const user = userEvent.setup();
    const { onDropFiles } = renderBody();

    await user.click(screen.getByRole('button', { name: 'Edit description' }));
    const file = new File(['png'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(screen.getByLabelText('Description'), {
      clipboardData: {
        files: [file],
        items: [{ kind: 'file', getAsFile: () => file }],
        types: ['Files'],
      },
    });

    expect(onDropFiles).toHaveBeenCalledWith([file]);
  });

  it('does not open the editor for a reader', async () => {
    const user = userEvent.setup();
    renderBody(false);

    await user.click(screen.getByText('markdown', { selector: 'strong' }));

    expect(screen.queryByLabelText('Description')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit description' })
    ).not.toBeInTheDocument();
  });
});
