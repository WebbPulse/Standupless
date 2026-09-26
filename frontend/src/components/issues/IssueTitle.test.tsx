/**
 * The inline issue title. Covers that it is a borderless field with no pencil,
 * that Enter or leaving it saves a changed title once, that Escape puts the
 * saved title back without a request, that a blank or unchanged title saves
 * nothing, that a failed save reverts, and that a reader gets a plain heading.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import IssueTitle from './IssueTitle';

/** Renders an editable title with a save that succeeds unless told not to. */
const renderTitle = (saves = true) => {
  const onSave = vi.fn(() => Promise.resolve(saves));
  render(<IssueTitle title="Cache the token" canEdit onSave={onSave} />);
  return {
    onSave,
    field: screen.getByRole('textbox', { name: 'Issue title' }),
  };
};

describe('the inline title', () => {
  it('is a field showing the title, with no pencil', () => {
    const { field } = renderTitle();

    expect(field).toHaveValue('Cache the token');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('saves on Enter', async () => {
    const user = userEvent.setup();
    const { onSave, field } = renderTitle();

    await user.click(field);
    await user.type(field, ' today{Enter}');

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('Cache the token today');
    expect(field).not.toHaveFocus();
  });

  it('saves when focus leaves it', async () => {
    const user = userEvent.setup();
    const { onSave, field } = renderTitle();

    await user.type(field, '!');
    await user.click(document.body);

    expect(onSave).toHaveBeenCalledWith('Cache the token!');
  });

  it('puts the saved title back on Escape without saving', async () => {
    const user = userEvent.setup();
    const { onSave, field } = renderTitle();

    await user.type(field, ' later{Escape}');

    expect(field).toHaveValue('Cache the token');
    expect(field).not.toHaveFocus();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves nothing for a blank or unchanged title', async () => {
    const user = userEvent.setup();
    const { onSave, field } = renderTitle();

    await user.click(field);
    await user.keyboard('{Enter}');
    await user.clear(field);
    await user.keyboard('{Enter}');

    expect(onSave).not.toHaveBeenCalled();
    expect(field).toHaveValue('Cache the token');
  });

  it('reverts when the save fails', async () => {
    const user = userEvent.setup();
    const { field } = renderTitle(false);

    await user.type(field, ' today{Enter}');

    await waitFor(() => {
      expect(field).toHaveValue('Cache the token');
    });
  });

  it('is a plain heading for a reader', () => {
    render(
      <IssueTitle title="Cache the token" canEdit={false} onSave={vi.fn()} />
    );

    expect(
      screen.getByRole('heading', { name: 'Cache the token' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
