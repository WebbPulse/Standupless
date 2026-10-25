/**
 * Offers a small Quote button under text selected inside a comment or the
 * issue description, as Linear does. Pressing it quotes only the selected
 * passage, read back into the Markdown that draws it so its mentions, issue
 * keys and links stay chips and links, and hands the blockquote on.
 *
 * The button never takes focus or the selection from the text, so a
 * formatting toolbar over an editable selection keeps working beside it, and
 * it follows the selection as the page scrolls.
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LuTextQuote } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { quoteMarkdown, rangeMarkdown } from '../../lib/quote';

/** Props for SelectionQuote. */
export interface SelectionQuoteProps {
  /** Receives the selected passage as a Markdown blockquote; unset offers no quote. */
  onQuote?: ((markdown: string) => void) | undefined;
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

/** Wraps quotable text and floats a Quote button under a selection inside it. */
export const SelectionQuote: React.FC<SelectionQuoteProps> = ({
  onQuote,
  className,
  children,
}) => {
  const box = useRef<HTMLDivElement>(null);
  const selected = useRef<Range | null>(null);
  const handler = useRef(onQuote);
  handler.current = onQuote;
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const enabled = onQuote !== undefined;

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
    document.addEventListener('selectionchange', read);
    window.addEventListener('scroll', read, true);
    window.addEventListener('resize', read);
    return () => {
      document.removeEventListener('selectionchange', read);
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

  return (
    <div ref={box} className={cn(className)}>
      {children}
      {enabled &&
        anchor !== null &&
        createPortal(
          <button
            type="button"
            aria-label="Quote selection"
            style={{ top: anchor.top, left: anchor.left }}
            className="fixed z-60 inline-flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-md border border-line bg-overlay px-2 text-xs font-medium text-text-muted shadow-overlay hover:bg-hover hover:text-text"
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={quote}
          >
            <LuTextQuote aria-hidden="true" className="h-3.5 w-3.5" />
            Quote
          </button>,
          document.body
        )}
    </div>
  );
};

export default SelectionQuote;
