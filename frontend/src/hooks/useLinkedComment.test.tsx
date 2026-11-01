/**
 * Landing on a linked comment: the hash parsed into a comment id, the comment
 * scrolled to and highlighted for a moment once it renders, a comment that
 * arrives later still found, and the highlight cleared on unmount.
 */

import { act, render } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMMENT_HIGHLIGHT_ATTRIBUTE,
  COMMENT_HIGHLIGHT_MS,
  linkedCommentId,
  useLinkedComment,
} from './useLinkedComment';

/** A thread rendering one article per comment id, landing on the hash. */
const Thread: React.FC<{ ids: string[] }> = ({ ids }) => {
  useLinkedComment(ids);
  return (
    <>
      {ids.map((id) => (
        <article key={id} id={`comment-${id}`} />
      ))}
    </>
  );
};

const scrollIntoView = vi.fn();

/** Renders the thread at a path carrying the hash given. */
const renderAt = (path: string, ids: string[]) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Thread ids={ids} />
    </MemoryRouter>
  );

beforeEach(() => {
  vi.useFakeTimers();
  scrollIntoView.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('linkedCommentId', () => {
  it('reads the comment id from a comment hash', () => {
    expect(linkedCommentId('#comment-c-1')).toBe('c-1');
  });

  it('reads nothing from another hash or a bare prefix', () => {
    expect(linkedCommentId('#settings')).toBeNull();
    expect(linkedCommentId('#comment-')).toBeNull();
    expect(linkedCommentId('')).toBeNull();
  });
});

describe('useLinkedComment', () => {
  it('scrolls to the linked comment and highlights it for a moment', () => {
    renderAt('/issue#comment-c-2', ['c-1', 'c-2']);

    const target = document.getElementById('comment-c-2');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(target).toHaveAttribute(COMMENT_HIGHLIGHT_ATTRIBUTE);
    expect(document.getElementById('comment-c-1')).not.toHaveAttribute(
      COMMENT_HIGHLIGHT_ATTRIBUTE
    );

    act(() => {
      vi.advanceTimersByTime(COMMENT_HIGHLIGHT_MS);
    });

    expect(target).not.toHaveAttribute(COMMENT_HIGHLIGHT_ATTRIBUTE);
  });

  it('lands on a comment that renders after the first pass, once', () => {
    const view = renderAt('/issue#comment-c-2', ['c-1']);
    expect(scrollIntoView).not.toHaveBeenCalled();

    view.rerender(
      <MemoryRouter initialEntries={['/issue#comment-c-2']}>
        <Thread ids={['c-1', 'c-2']} />
      </MemoryRouter>
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(document.getElementById('comment-c-2')).toHaveAttribute(
      COMMENT_HIGHLIGHT_ATTRIBUTE
    );

    view.rerender(
      <MemoryRouter initialEntries={['/issue#comment-c-2']}>
        <Thread ids={['c-1', 'c-2', 'c-3']} />
      </MemoryRouter>
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a comment hash', () => {
    renderAt('/issue', ['c-1']);

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.getElementById('comment-c-1')).not.toHaveAttribute(
      COMMENT_HIGHLIGHT_ATTRIBUTE
    );
  });
});
