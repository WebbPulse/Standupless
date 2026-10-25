/**
 * The accept popover's form: focus starts in the comment, Enter accepts into
 * the default status straight away, and a chosen status and comment travel
 * together, a priority picker preselects the current priority and takes a
 * digit per priority, and a team that requires a priority holds the accept
 * until one is picked.
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

  it('preselects the current priority and sends none when it is unchanged', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm({ priority: 'high' });
    expect(screen.getByRole('radio', { name: 'High' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.queryByText(/No priority yet/)).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith({
      statusId: 'todo',
      comment: '',
      priority: null,
    });
  });

  it('nudges for a priority without holding the accept', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    expect(screen.getByRole('radio', { name: 'No priority' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(
      screen.getByText('No priority yet. Press 1 to 4 to set one.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeEnabled();
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith({
      statusId: 'todo',
      comment: '',
      priority: null,
    });
  });

  it('picks a priority with a number key while the comment is empty', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await user.keyboard('2');
    expect(screen.getByLabelText('Comment (optional)')).toHaveValue('');
    expect(screen.getByRole('radio', { name: 'High' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.queryByText(/No priority yet/)).not.toBeInTheDocument();
    await user.keyboard('4');
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith({
      statusId: 'todo',
      comment: '',
      priority: 'low',
    });
  });

  it('types digits into a comment already started', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await user.type(screen.getByLabelText('Comment (optional)'), 'Fix 2');
    expect(screen.getByLabelText('Comment (optional)')).toHaveValue('Fix 2');
    expect(screen.getByRole('radio', { name: 'No priority' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await user.keyboard('{Alt>}1{/Alt}{Enter}');
    expect(onSubmit).toHaveBeenCalledWith({
      statusId: 'todo',
      comment: 'Fix 2',
      priority: 'urgent',
    });
  });

  it('picks a priority by clicking it', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm({ priority: 'low' });
    await user.click(screen.getByRole('radio', { name: 'Medium' }));
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    expect(onSubmit).toHaveBeenCalledWith({
      statusId: 'todo',
      comment: '',
      priority: 'medium',
    });
  });

  it('holds the accept until a required priority is picked', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm({ requirePriority: true });
    const accept = screen.getByRole('button', { name: 'Accept' });
    expect(accept).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'No priority' })).toBeDisabled();
    expect(
      screen.getByText(
        'This team needs a priority before an issue leaves triage.'
      )
    ).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByRole('radio', { name: 'Urgent' }));
    expect(accept).toBeEnabled();
    await user.keyboard('0');
    expect(screen.getByRole('radio', { name: 'Urgent' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await user.click(accept);
    expect(onSubmit).toHaveBeenCalledWith({
      statusId: 'todo',
      comment: '',
      priority: 'urgent',
    });
  });

  it('does not hold the accept when the issue already has a priority', () => {
    renderForm({ requirePriority: true, priority: 'high' });
    expect(screen.getByRole('button', { name: 'Accept' })).toBeEnabled();
    expect(
      screen.queryByText(
        'This team needs a priority before an issue leaves triage.'
      )
    ).not.toBeInTheDocument();
  });
});
