/**
 * The bar that floats under selected text. Covers that the Comment button
 * shows beside Quote where the caller takes comments, hands on the selected
 * range, and that neither shows when the caller takes neither.
 */

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import SelectionQuote from './SelectionQuote';

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
});
