/**
 * The accept popover's form: focus starts in the comment, Enter accepts into
 * the default status straight away, and a chosen status and comment travel
 * together, and a team that requires a priority holds the accept until one
 * is picked.
 */

import type React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { StatusRead } from '../../types/Api';
import { TriageAcceptForm } from './TriageAcceptForm';

const STATUSES: StatusRead[] = [
  { id: 'backlog', name: 'Backlog', category: 'backlog', position: 0 },
  { id: 'todo', name: 'Todo', category: 'unstarted', position: 1 },
  { id: 'doing', name: 'In Progress', category: 'started', position: 2 },
];

const renderForm = (
  extra: Partial<React.ComponentProps<typeof TriageAcceptForm>> = {}
) => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  render(
    <TriageAcceptForm
      issueKey="ENG-7"
      statuses={STATUSES}
      {...extra}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
  return { onSubmit, onCancel };
};

describe('TriageAcceptForm', () => {
  it('accepts into the default status on Enter with no comment', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    expect(screen.getByLabelText('Comment (optional)')).toHaveFocus();
    expect(screen.getByLabelText('Status')).toHaveValue('todo');
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith({
      statusId: 'todo',
      comment: '',
      priority: null,
    });
  });

  it('carries the chosen status and the trimmed comment', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await user.type(
      screen.getByLabelText('Comment (optional)'),
      '  Picked up  {Shift>}{Enter}{/Shift}today'
    );
    await user.selectOptions(screen.getByLabelText('Status'), 'doing');
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    expect(onSubmit).toHaveBeenCalledWith({
      statusId: 'doing',
      comment: 'Picked up  \ntoday',
      priority: null,
    });
  });

  it('cancels without accepting', async () => {
    const user = userEvent.setup();
    const { onSubmit, onCancel } = renderForm();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('asks for no priority when the team does not require one', () => {
    renderForm();
    expect(screen.queryByLabelText('Priority')).not.toBeInTheDocument();
  });

  it('asks for no priority when the issue already has one', () => {
    renderForm({ requirePriority: true, priority: 'high' });
    expect(screen.queryByLabelText('Priority')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeEnabled();
  });

  it('holds the accept until a required priority is picked', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm({ requirePriority: true });
    const accept = screen.getByRole('button', { name: 'Accept' });
    expect(accept).toBeDisabled();
    await user.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByLabelText('Priority'), 'urgent');
    expect(accept).toBeEnabled();
    await user.click(accept);
    expect(onSubmit).toHaveBeenCalledWith({
      statusId: 'todo',
      comment: '',
      priority: 'urgent',
    });
  });
});
