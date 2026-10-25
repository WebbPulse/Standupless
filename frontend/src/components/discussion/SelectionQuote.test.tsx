/**
 * The bar that floats under selected text. Covers that the Comment button
 * shows beside Quote where the caller takes comments, hands on the selected
 * range, and that neither shows when the caller takes neither, and that Cmd
 * or Ctrl Alt M comments on a held selection, does nothing without one, and
 * is listed in the shortcut registry under Editor.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  createShortcutRegistry,
  ShortcutRegistryContext,
} from '../../hooks/useShortcuts';
import SelectionQuote from './SelectionQuote';

/** Presses Cmd Alt M the way a Mac reports it, Option turning M into µ. */
const pressCommentChord = (target: Document | Element = document): boolean =>
  fireEvent.keyDown(target, {
    key: 'µ',
    code: 'KeyM',
    metaKey: true,
    altKey: true,
  });

/** Selects `words` inside the paragraph that holds them. */
const selectWords = (words: string): void => {
  const holder = screen.getByText(
    (_, node) =>
      node?.tagName === 'P' && (node.textContent ?? '').includes(words)
  );
  const text = holder.firstChild;
  if (text === null) throw new Error('no text to select');
  const start = (text.textContent ?? '').indexOf(words);
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, start + words.length);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  act(() => {
    document.dispatchEvent(new Event('selectionchange'));
  });
};

describe('the selection bar', () => {
  it('hands the selected range to Comment', async () => {
    const user = userEvent.setup();
    const onComment = vi.fn<(range: Range) => void>();
    render(
      <SelectionQuote onQuote={() => undefined} onComment={onComment}>
        <p>Cache the board query today</p>
      </SelectionQuote>
    );

    selectWords('board query');
    expect(
      screen.getByRole('button', { name: 'Quote selection' })
    ).toBeTruthy();
    await user.click(
      screen.getByRole('button', { name: 'Comment on selection' })
    );

    expect(onComment).toHaveBeenCalledTimes(1);
    expect(onComment.mock.calls[0]?.[0].toString()).toBe('board query');
    expect(
      screen.queryByRole('button', { name: 'Comment on selection' })
    ).toBeNull();
  });

  it('offers Comment alone where nothing takes a quote', () => {
    render(
      <SelectionQuote onComment={() => undefined}>
        <p>Cache the board query today</p>
      </SelectionQuote>
    );

    selectWords('board');

    expect(
      screen.getByRole('button', { name: 'Comment on selection' })
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Quote selection' })
    ).toBeNull();
  });

  it('offers nothing where the caller takes neither', () => {
    render(
      <SelectionQuote>
        <p>Cache the board query today</p>
      </SelectionQuote>
    );

    selectWords('board');

    expect(
      screen.queryByRole('button', { name: 'Comment on selection' })
    ).toBeNull();
  });

  it('comments on the held selection on Cmd or Ctrl Alt M', () => {
    const onComment = vi.fn<(range: Range) => void>();
    render(
      <SelectionQuote onComment={onComment}>
        <p>Cache the board query today</p>
      </SelectionQuote>
    );

    selectWords('board query');
    const passed = pressCommentChord();

    expect(passed).toBe(false);
    expect(onComment).toHaveBeenCalledTimes(1);
    expect(onComment.mock.calls[0]?.[0].toString()).toBe('board query');
  });

  it('takes Ctrl Alt M too', () => {
    const onComment = vi.fn<(range: Range) => void>();
    render(
      <SelectionQuote onComment={onComment}>
        <p>Cache the board query today</p>
      </SelectionQuote>
    );

    selectWords('board');
    fireEvent.keyDown(document, {
      key: 'm',
      code: 'KeyM',
      ctrlKey: true,
      altKey: true,
    });

    expect(onComment).toHaveBeenCalledTimes(1);
  });

  it('does nothing on the chord without a selection', () => {
    const onComment = vi.fn<(range: Range) => void>();
    render(
      <SelectionQuote onComment={onComment}>
        <p>Cache the board query today</p>
      </SelectionQuote>
    );

    document.getSelection()?.removeAllRanges();
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    pressCommentChord();

    expect(onComment).not.toHaveBeenCalled();
  });

  it('keeps the chord inside the text from falling through', () => {
    const outside = vi.fn();
    document.addEventListener('keydown', outside);
    render(
      <SelectionQuote onComment={() => undefined}>
        <p>Cache the board query today</p>
      </SelectionQuote>
    );

    const passed = pressCommentChord(screen.getByText(/board query/));
    document.removeEventListener('keydown', outside);

    expect(passed).toBe(false);
    expect(outside).not.toHaveBeenCalled();
  });

  it('ignores the chord where the text takes no comments', () => {
    const onQuote = vi.fn();
    render(
      <SelectionQuote onQuote={onQuote}>
        <p>Cache the board query today</p>
      </SelectionQuote>
    );

    selectWords('board');
    const passed = pressCommentChord();

    expect(passed).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Quote selection' })
    ).toBeTruthy();
  });

  it('lists the chord under Editor and shows it on the button', () => {
    const registry = createShortcutRegistry();
    const onComment = vi.fn<(range: Range) => void>();
    render(
      <ShortcutRegistryContext.Provider value={registry}>
        <SelectionQuote onComment={onComment}>
          <p>Cache the board query today</p>
        </SelectionQuote>
      </ShortcutRegistryContext.Provider>
    );

    const listed = registry
      .list()
      .find((shortcut) => shortcut.keys === 'mod+alt+m');
    expect(listed?.group).toBe('Editor');
    expect(listed?.label).toBe('Comment on the selected passage');

    selectWords('board');
    expect(
      screen
        .getByRole('button', { name: 'Comment on selection' })
        .getAttribute('title')
    ).toMatch(/^Comment \(.+M\)$/);
  });

  it('leaves the chord out of the registry where comments are off', () => {
    const registry = createShortcutRegistry();
    render(
      <ShortcutRegistryContext.Provider value={registry}>
        <SelectionQuote onQuote={() => undefined}>
          <p>Cache the board query today</p>
        </SelectionQuote>
      </ShortcutRegistryContext.Provider>
    );

    expect(
      registry.list().some((shortcut) => shortcut.keys === 'mod+alt+m')
    ).toBe(false);
  });
});
