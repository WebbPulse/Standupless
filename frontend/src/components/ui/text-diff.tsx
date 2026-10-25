/**
 * A line diff of a kept version against the current text, shared by the issue
 * description history and the document history so both read the same way.
 */

import React from 'react';
import { hasChanges, type DiffLine } from '../../lib/textDiff';

/** Props for TextDiff. */
export interface TextDiffProps {
  lines: DiffLine[];
  /** What the current text is called, such as "description" or "document". */
  subject: string;
}

/** The class one diff line is drawn with. */
const lineClass = (kind: DiffLine['kind']): string => {
  if (kind === 'added') return 'bg-success-soft text-text';
  if (kind === 'removed') return 'bg-danger-soft text-text';
  return 'text-text-muted';
};

/** The marker in front of one diff line. */
const lineMarker = (kind: DiffLine['kind']): string => {
  if (kind === 'added') return '+';
  if (kind === 'removed') return '-';
  return ' ';
};

/** The selected version against the current text, line by line. */
export const TextDiff: React.FC<TextDiffProps> = ({ lines, subject }) => {
  if (!hasChanges(lines)) {
    return (
      <p className="text-sm text-text-muted">
        This version matches the current {subject}.
      </p>
    );
  }
  return (
    <pre
      aria-label={`Changes against the current ${subject}`}
      className="overflow-x-auto rounded-md border border-line font-mono text-xs leading-5"
    >
      {lines.map((line, index) => (
        <div
          key={index}
          className={`flex gap-2 px-2 whitespace-pre-wrap ${lineClass(line.kind)}`}
        >
          <span aria-hidden="true" className="w-3 shrink-0 select-none">
            {lineMarker(line.kind)}
          </span>
          <span className="sr-only">
            {line.kind === 'same'
              ? ''
              : line.kind === 'added'
                ? 'In this version: '
                : `In the current ${subject}: `}
          </span>
          <span className="min-w-0 break-words">{line.text || ' '}</span>
        </div>
      ))}
    </pre>
  );
};

export default TextDiff;
