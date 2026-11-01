/**
 * The landing a `#comment-` link makes on an issue or document thread: once
 * the comment it names has rendered, scroll to it and highlight it for a
 * moment, as Linear does, so the eye finds the comment that was linked. A
 * resolved thread holding the comment opens itself, through
 * `linkedCommentId`, so a reply link has an element to land on.
 */

import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

/** How long a linked comment stays highlighted, in milliseconds. */
export const COMMENT_HIGHLIGHT_MS = 2000;

/** The attribute a linked comment carries while it is highlighted. */
export const COMMENT_HIGHLIGHT_ATTRIBUTE = 'data-comment-highlight';

const PREFIX = '#comment-';

/** The comment id a location hash links to, or null when it names none. */
export const linkedCommentId = (hash: string): string | null =>
  hash.startsWith(PREFIX) && hash.length > PREFIX.length
    ? hash.slice(PREFIX.length)
    : null;

/** Whether the location links to this comment or to one of its replies. */
export const useLinksIntoThread = (
  commentId: string,
  replyIds: readonly string[]
): boolean => {
  const linked = linkedCommentId(useLocation().hash);
  return linked !== null && (linked === commentId || replyIds.includes(linked));
};

/**
 * Scrolls to and highlights the comment the location's hash names, once per
 * hash. `rows` is whatever the thread renders from, so a comment that arrives
 * on a later page is still found when it lands.
 */
export const useLinkedComment = (rows: unknown): void => {
  const { hash } = useLocation();
  const landed = useRef<string | null>(null);
  const shown = useRef<{ target: HTMLElement; timer: number } | null>(null);

  useEffect(() => {
    if (linkedCommentId(hash) === null || landed.current === hash) return;
    const target = document.getElementById(hash.slice(1));
    if (target === null) return;
    landed.current = hash;
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'start' });
    }
    if (shown.current !== null) {
      window.clearTimeout(shown.current.timer);
      shown.current.target.removeAttribute(COMMENT_HIGHLIGHT_ATTRIBUTE);
    }
    target.setAttribute(COMMENT_HIGHLIGHT_ATTRIBUTE, '');
    const timer = window.setTimeout(() => {
      target.removeAttribute(COMMENT_HIGHLIGHT_ATTRIBUTE);
      shown.current = null;
    }, COMMENT_HIGHLIGHT_MS);
    shown.current = { target, timer };
  }, [hash, rows]);

  useEffect(
    () => () => {
      if (shown.current === null) return;
      window.clearTimeout(shown.current.timer);
      shown.current.target.removeAttribute(COMMENT_HIGHLIGHT_ATTRIBUTE);
    },
    []
  );
};
