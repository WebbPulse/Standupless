/**
 * The inline issue title. Covers that it is a borderless field with no pencil,
 * that Enter or leaving it saves a changed title once, that Escape puts the
 * saved title back without a request, that a blank or unchanged title saves
 * nothing, that a failed save reverts, that a reader gets a plain heading,
 * and that R puts the caret in the field with the title selected.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ShortcutProvider from '../shortcuts/ShortcutProvider';
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

describe('the rename key', () => {
  /** Renders the title inside the shortcut layer, beside a plain search box. */
  const renderWithKeys = (canEdit = true) => {
    const onSave = vi.fn(() => Promise.resolve(true));
    render(
      <ShortcutProvider>
        <input aria-label="Search" />
        <IssueTitle title="Cache the token" canEdit={canEdit} onSave={onSave} />
      </ShortcutProvider>
    );
    return { onSave, user: userEvent.setup() };
  };

  it('puts the caret in the title with the text selected on R', async () => {
    const { user } = renderWithKeys();
    const field = screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Issue title',
    });

    await user.keyboard('r');

    expect(field).toHaveFocus();
    expect(field).toHaveValue('Cache the token');
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe('Cache the token'.length);
  });

  it('saves on Enter and puts the title back on Escape after R', async () => {
    const { user, onSave } = renderWithKeys();
    const field = screen.getByRole('textbox', { name: 'Issue title' });

    await user.keyboard('r');
    await user.keyboard('Rotate the token{Escape}');
    expect(field).toHaveValue('Cache the token');
    expect(onSave).not.toHaveBeenCalled();

    await user.keyboard('r');
    await user.keyboard('Rotate the token{Enter}');
    expect(onSave).toHaveBeenCalledWith('Rotate the token');
  });

  it('stands down while typing in another field', async () => {
    const { user } = renderWithKeys();
    const search = screen.getByRole('textbox', { name: 'Search' });

    await user.click(search);
    await user.keyboard('r');

    expect(search).toHaveFocus();
    expect(search).toHaveValue('r');
  });

  it('does nothing for a reader', async () => {
    const { user } = renderWithKeys(false);

    await user.keyboard('r');

    expect(screen.queryByRole('textbox', { name: 'Issue title' })).toBeNull();
    expect(document.body).toHaveFocus();
  });
});
