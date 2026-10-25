/**
 * Offers a small Quote button under text selected inside a comment or the
 * issue description, as Linear does. Pressing it quotes only the selected
 * passage, read back into the Markdown that draws it so its mentions, issue
 * keys and links stay chips and links, and hands the blockquote on.
 *
 * Where the text may carry comment threads, as the description does, a Comment
 * button sits beside it and hands on the selected range, so the caller can pin
 * a new thread to that passage. Cmd or Ctrl Alt M does the same while the
 * selection is held, as in Linear, even with the caret in editable text, and
 * the shortcut registry lists it under Editor so help and the palette show it.
 *
 * Where the text sits on an issue that may take sub-issues, a Sub-issue button
 * hands the selected passage on as Markdown, and Ctrl or Cmd Shift O does the
 * same while the selection is held, ahead of the page's own binding.
 *
 * The button never takes focus or the selection from the text, so a
 * formatting toolbar over an editable selection keeps working beside it, and
 * it follows the selection as the page scrolls.
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LuListTree, LuMessageSquarePlus, LuTextQuote } from 'react-icons/lu';
import { displayKeys, useShortcut } from '../../hooks/useShortcuts';
import { cn } from '../../lib/cn';
import { quoteMarkdown, rangeMarkdown } from '../../lib/quote';

/** Props for SelectionQuote. */
export interface SelectionQuoteProps {
  /** Receives the selected passage as a Markdown blockquote; unset offers no quote. */
  onQuote?: ((markdown: string) => void) | undefined;
  /** Receives the selected range to comment on; unset offers no Comment button. */
  onComment?: ((range: Range) => void) | undefined;
  /** Receives the selected passage as Markdown to file sub-issues from; unset offers none. */
  onSubIssue?: ((markdown: string) => void) | undefined;
  /** Hears clicks inside the wrapped text, such as on a highlighted passage. */
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  className?: string;
  children: React.ReactNode;
}

/** Where the button sits, in viewport coordinates. */
interface Anchor {
  top: number;
  left: number;
}

/** The space between the selection and the button. */
const GAP = 6;

/** Where a range draws, or nowhere when the platform cannot measure it. */
const rangeBox = (range: Range): Anchor => {
  if (typeof range.getBoundingClientRect !== 'function') {
    return { top: 0, left: 0 };
  }
  const box = range.getBoundingClientRect();
  return { top: box.bottom + GAP, left: box.left + box.width / 2 };
};

/** The chord that comments on the selected passage, as in Linear. */
export const COMMENT_PASSAGE_KEYS = 'mod+alt+m';

/** True when a key event is Cmd or Ctrl Alt M, read by the physical key. */
const isCommentChord = (event: KeyboardEvent): boolean =>
  (event.metaKey || event.ctrlKey) &&
  event.altKey &&
  !event.shiftKey &&
  (event.code === 'KeyM' || event.key.toLowerCase() === 'm');

/** The look of each button on the bar. */
const BUTTON_CLASS =
  'inline-flex h-7 items-center gap-1.5 px-2 text-xs font-medium text-text-muted hover:bg-hover hover:text-text';

/** Wraps quotable text and floats a Quote button under a selection inside it. */
export const SelectionQuote: React.FC<SelectionQuoteProps> = ({
  onQuote,
  onComment,
  onSubIssue,
  onClick,
  className,
  children,
}) => {
  const box = useRef<HTMLDivElement>(null);
  const selected = useRef<Range | null>(null);
  const handler = useRef(onQuote);
  handler.current = onQuote;
  const commenter = useRef(onComment);
  commenter.current = onComment;
  const subIssuer = useRef(onSubIssue);
  subIssuer.current = onSubIssue;
  const subIssueRef = useRef<() => void>(() => undefined);
  const commentRef = useRef<() => void>(() => undefined);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const enabled =
    onQuote !== undefined ||
    onComment !== undefined ||
    onSubIssue !== undefined;

  useEffect(() => {
    if (!enabled) return;
    const read = (): void => {
      const selection = document.getSelection();
      const node = box.current;
      if (
        selection === null ||
        node === null ||
        selection.isCollapsed ||
        selection.rangeCount === 0
      ) {
        selected.current = null;
        setAnchor(null);
        return;
      }
      const range = selection.getRangeAt(0);
      if (
        !node.contains(range.commonAncestorContainer) ||
        selection.toString().trim() === ''
      ) {
        selected.current = null;
        setAnchor(null);
        return;
      }
      selected.current = range.cloneRange();
      setAnchor(rangeBox(range));
    };
    const press = (event: KeyboardEvent): void => {
      if (
        commenter.current !== undefined &&
        selected.current !== null &&
        isCommentChord(event)
      ) {
        event.preventDefault();
        event.stopPropagation();
        commentRef.current();
        return;
      }
      if (
        commenter.current !== undefined &&
        isCommentChord(event) &&
        event.target instanceof Node &&
        box.current?.contains(event.target) === true
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (
        subIssuer.current === undefined ||
        selected.current === null ||
        !(event.metaKey || event.ctrlKey) ||
        !event.shiftKey ||
        event.altKey ||
        event.key.toLowerCase() !== 'o'
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      subIssueRef.current();
    };
    document.addEventListener('selectionchange', read);
    document.addEventListener('keydown', press, true);
    window.addEventListener('scroll', read, true);
    window.addEventListener('resize', read);
    return () => {
      document.removeEventListener('selectionchange', read);
      document.removeEventListener('keydown', press, true);
      window.removeEventListener('scroll', read, true);
      window.removeEventListener('resize', read);
    };
  }, [enabled]);

  const quote = (): void => {
    const range = selected.current;
    selected.current = null;
    setAnchor(null);
    if (range === null) return;
    const markdown = quoteMarkdown(rangeMarkdown(range));
    document.getSelection()?.removeAllRanges();
    if (markdown !== '') handler.current?.(markdown);
  };

  const comment = (): void => {
    const range = selected.current;
    selected.current = null;
    setAnchor(null);
    if (range === null) return;
    commenter.current?.(range);
  };
  commentRef.current = comment;

  useShortcut({
    keys: COMMENT_PASSAGE_KEYS,
    label: 'Comment on the selected passage',
    group: 'Editor',
    enabled: onComment !== undefined,
    handler: comment,
  });

  const subIssue = (): void => {
    const range = selected.current;
    selected.current = null;
    setAnchor(null);
    if (range === null) return;
    const markdown = rangeMarkdown(range);
    document.getSelection()?.removeAllRanges();
    if (markdown !== '') subIssuer.current?.(markdown);
  };
  subIssueRef.current = subIssue;

  const keepSelection = (event: React.MouseEvent): void => {
    event.preventDefault();
  };

  return (
    <div ref={box} className={cn(className)} onClick={onClick}>
      {children}
      {enabled &&
        anchor !== null &&
        createPortal(
          <div
            style={{ top: anchor.top, left: anchor.left }}
            className="fixed z-60 inline-flex -translate-x-1/2 divide-x divide-line overflow-hidden rounded-md border border-line bg-overlay shadow-overlay"
          >
            {onComment !== undefined && (
              <button
                type="button"
                aria-label="Comment on selection"
                title={`Comment (${displayKeys(COMMENT_PASSAGE_KEYS)[0] ?? ''})`}
                className={BUTTON_CLASS}
                onMouseDown={keepSelection}
                onClick={comment}
              >
                <LuMessageSquarePlus
                  aria-hidden="true"
                  className="h-3.5 w-3.5"
                />
                Comment
              </button>
            )}
            {onQuote !== undefined && (
              <button
                type="button"
                aria-label="Quote selection"
                className={BUTTON_CLASS}
                onMouseDown={keepSelection}
                onClick={quote}
              >
                <LuTextQuote aria-hidden="true" className="h-3.5 w-3.5" />
                Quote
              </button>
            )}
            {onSubIssue !== undefined && (
              <button
                type="button"
                aria-label="Create sub-issue from selection"
                className={BUTTON_CLASS}
                onMouseDown={keepSelection}
                onClick={subIssue}
              >
                <LuListTree aria-hidden="true" className="h-3.5 w-3.5" />
                Sub-issue
              </button>
            )}
          </div>,
          document.body
        )}
    </div>
  );
};

export default SelectionQuote;
