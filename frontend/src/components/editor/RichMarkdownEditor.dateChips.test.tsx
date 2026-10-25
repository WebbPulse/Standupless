/**
 * Date chips and the table shortcut inside a live surface. Text after an `@`
 * that reads as a date offers a Date group after the people, `/date` opens a
 * picker of quick picks, a typed day and a calendar, and `|--` on an empty
 * line starts a table. Each pick stores the day as `<YYYY-MM-DD>`.
 */

import type { Editor } from '@tiptap/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Assignable } from '../../lib/issuePeople';
import { RichMarkdownEditor } from './RichMarkdownEditor';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 25, 12));
});

afterEach(() => {
  vi.useRealTimers();
});

/** The Tiptap editor behind a surface. */
const editorOf = (surface: HTMLElement): Editor =>
  (surface as HTMLElement & { editor: Editor }).editor;

/** Feeds text through the editor's own text input path, as typing does. */
const typeText = (editor: Editor, text: string): void => {
  act(() => {
    for (const char of text) {
      const { from, to } = editor.state.selection;
      const handled = editor.view.someProp('handleTextInput', (handle) =>
        handle(editor.view, from, to, char, () =>
          editor.state.tr.insertText(char)
        )
      );
      if (handled !== true) {
        editor.view.dispatch(editor.state.tr.insertText(char, from, to));
      }
    }
  });
};

const TYLER: Assignable = {
  user_id: 'usr-1',
  email: 'tyler@example.com',
  display_name: 'tyler',
  avatar_url: null,
};

/** Renders an editable surface and answers its editor and change spy. */
const renderSurface = (
  mentionPeople?: Assignable[]
): {
  surface: HTMLElement;
  editor: Editor;
  onChange: ReturnType<typeof vi.fn>;
} => {
  const onChange = vi.fn();
  render(
    <RichMarkdownEditor
      value=""
      editable
      ariaLabel="Description"
      onCommit={() => true}
      onChange={onChange}
      {...(mentionPeople === undefined ? {} : { mentionPeople })}
    />
  );
  const surface = screen.getByRole('textbox', { name: 'Description' });
  const editor = editorOf(surface);
  act(() => {
    editor.commands.focus();
  });
  return { surface, editor, onChange };
};

/** The last Markdown the surface reported, without a trailing space. */
const lastMarkdown = (onChange: ReturnType<typeof vi.fn>): string =>
  String(onChange.mock.calls.at(-1)?.[0] ?? '').trimEnd();

/** Presses a key on an element. */
const press = (element: HTMLElement, key: string): void => {
  act(() => {
    fireEvent.keyDown(element, { key });
  });
};

describe('the Date group of the @ menu', () => {
  it('offers a typed day even where no one can be mentioned', () => {
    const { surface, editor, onChange } = renderSurface();
    typeText(editor, 'Due @tomorrow');
    const menu = screen.getByRole('listbox', { name: 'Insert a date' });
    expect(within(menu).getByText('Date')).toBeTruthy();
    expect(within(menu).getAllByRole('option')).toHaveLength(1);
    press(surface, 'Enter');
    expect(screen.queryByRole('listbox', { name: 'Insert a date' })).toBeNull();
    expect(lastMarkdown(onChange)).toBe('Due <2026-10-26>');
  });

  it('reads a day written with a space and lists it after the people', () => {
    const { editor } = renderSurface([TYLER]);
    typeText(editor, '@t');
    const people = screen.getByRole('listbox', { name: 'Mention someone' });
    expect(within(people).getAllByRole('option')).toHaveLength(1);
    typeText(editor, 'oday');
    expect(screen.getByRole('listbox', { name: 'Insert a date' })).toBeTruthy();
    typeText(editor, ' ');
    expect(screen.queryByRole('listbox')).toBeNull();
    typeText(editor, 'is');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('inserts a day typed as month and day', () => {
    const { surface, editor, onChange } = renderSurface([TYLER]);
    typeText(editor, '@Nov 12');
    press(surface, 'Enter');
    expect(lastMarkdown(onChange)).toBe('<2026-11-12>');
  });

  it('stays shut for text that is not a day', () => {
    const { editor } = renderSurface();
    typeText(editor, '@someone');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('the /date picker', () => {
  /** Opens the picker from the slash menu. */
  const openPicker = (): {
    editor: Editor;
    onChange: ReturnType<typeof vi.fn>;
    picker: HTMLElement;
  } => {
    const { surface, editor, onChange } = renderSurface();
    typeText(editor, '/date');
    press(surface, 'Enter');
    return {
      editor,
      onChange,
      picker: screen.getByRole('dialog', { name: 'Pick a date' }),
    };
  };

  it('offers Today, Tomorrow and Next week and inserts the one clicked', () => {
    const { onChange, picker } = openPicker();
    const labels = within(picker)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(labels).toHaveLength(3);
    ['Today', 'Tomorrow', 'Next week'].forEach((name, index) => {
      expect(labels[index]?.startsWith(name)).toBe(true);
    });
    act(() => {
      fireEvent.click(within(picker).getByRole('option', { name: /Tomorrow/ }));
    });
    expect(screen.queryByRole('dialog', { name: 'Pick a date' })).toBeNull();
    expect(lastMarkdown(onChange)).toBe('<2026-10-26>');
  });

  it('reads a typed day and inserts it on Enter', () => {
    const { onChange, picker } = openPicker();
    const field = within(picker).getByRole('textbox', { name: 'Date' });
    act(() => {
      fireEvent.change(field, { target: { value: 'nov 12' } });
    });
    expect(within(picker).getAllByRole('option')).toHaveLength(1);
    press(field, 'Enter');
    expect(lastMarkdown(onChange)).toBe('<2026-11-12>');
  });

  it('inserts a day clicked in the calendar', () => {
    const { onChange, picker } = openPicker();
    const days = within(picker)
      .getAllByRole('button')
      .filter((button) => button.textContent === '30');
    const thirtieth = days.at(-1);
    if (thirtieth === undefined) throw new Error('no 30th in the grid');
    act(() => {
      fireEvent.click(thirtieth);
    });
    expect(lastMarkdown(onChange)).toBe('<2026-10-30>');
  });

  it('closes on Escape without writing anything', () => {
    const { editor, picker } = openPicker();
    press(within(picker).getByRole('textbox', { name: 'Date' }), 'Escape');
    expect(screen.queryByRole('dialog', { name: 'Pick a date' })).toBeNull();
    expect(editor.getText()).toBe('');
  });
});

describe('the |-- table shortcut', () => {
  it('turns |-- on an empty line into a table with a header row', () => {
    const { editor } = renderSurface();
    typeText(editor, '|--');
    const table = editor.state.doc.firstChild;
    expect(table?.type.name).toBe('table');
    expect(table?.firstChild?.firstChild?.type.name).toBe('tableHeader');
    expect(editor.state.selection.$from.node(-1).type.name).toBe('tableHeader');
  });

  it('leaves |-- after other text as typed', () => {
    const { editor } = renderSurface();
    typeText(editor, 'a |--');
    expect(editor.state.doc.firstChild?.type.name).toBe('paragraph');
    expect(editor.getText()).toBe('a |--');
  });
});
