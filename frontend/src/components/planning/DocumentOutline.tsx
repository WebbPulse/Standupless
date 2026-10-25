/**
 * The outline rail beside a document: its H1 to H3 headings, indented by
 * level, each scrolling the page to that heading. It reads the headings from
 * the Markdown and finds the rendered heading by its position inside
 * `container`, and it hides on narrow screens where there is no room beside
 * the text.
 */

import React, { useMemo } from 'react';
import { cn } from '../../lib/cn';
import { outlineOf } from '../../lib/documentOutline';

/** Props for DocumentOutline. */
export interface DocumentOutlineProps {
  markdown: string;
  /** The element the document's rendered headings sit in. */
  container: React.RefObject<HTMLElement | null>;
  className?: string;
}

/** How far each level sits in from the first. */
const INDENT: Record<number, string> = {
  1: 'pl-2',
  2: 'pl-5',
  3: 'pl-8',
};

/** The rail, or nothing when the document has no headings. */
export const DocumentOutline: React.FC<DocumentOutlineProps> = ({
  markdown,
  container,
  className = '',
}) => {
  const entries = useMemo(() => outlineOf(markdown), [markdown]);
  if (entries.length === 0) return null;

  const scrollTo = (index: number): void => {
    const headings = container.current?.querySelectorAll('h1, h2, h3');
    const target = headings?.[index];
    if (target === undefined) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <nav aria-label="Outline" className={cn('text-xs', className)}>
      <ul className="space-y-0.5 border-l border-line">
        {entries.map((entry) => (
          <li key={`${String(entry.index)}-${entry.text}`}>
            <button
              type="button"
              className={cn(
                '-ml-px block w-full truncate border-l border-transparent py-1 pr-2 text-left text-text-muted transition-colors duration-100 hover:border-text-faint hover:text-text focus-visible:text-text focus-visible:outline-none',
                INDENT[entry.level],
                entry.level === 1 && 'font-medium'
              )}
              title={entry.text}
              onClick={() => {
                scrollTo(entry.index);
              }}
            >
              {entry.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
};

export default DocumentOutline;
