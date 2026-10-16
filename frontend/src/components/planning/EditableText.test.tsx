/**
 * Editable text. Covers that a multiline field, such as a project's
 * description, takes the full height of its content with no inner scroll box,
 * both while it is read and while it is edited.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditableText } from './EditableText';

const CONTENT_HEIGHT = 640;

describe('EditableText', () => {
  beforeEach(() => {
    vi.spyOn(
      HTMLTextAreaElement.prototype,
      'scrollHeight',
      'get'
    ).mockReturnValue(CONTENT_HEIGHT);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a long description at full height, reading and editing', async () => {
    const user = userEvent.setup();
    render(
      <EditableText
        multiline
        label="Description"
        placeholder="Add a description"
        value={'A long description that wraps over many lines. '.repeat(40)}
        disabled={false}
        onSave={vi.fn()}
      />
    );

    const field = screen.getByRole('textbox', { name: 'Description' });
    expect(field.style.height).toBe(`${String(CONTENT_HEIGHT)}px`);
    expect(field.style.overflowY).toBe('hidden');

    await user.click(field);
    await user.type(field, ' More.');
    expect(field.style.height).toBe(`${String(CONTENT_HEIGHT)}px`);
    expect(field.style.overflowY).toBe('hidden');
  });
});
