/**
 * A block of monospaced text a person is meant to copy, such as a shell
 * command or a config file, with a copy button in its corner. A copy
 * confirms in place with a check for a moment.
 */

import React from 'react';
import { LuCheck, LuCopy } from 'react-icons/lu';
import { useCopy } from '../../hooks/useCopy';
import { cn } from '../../lib/cn';
import { IconButton } from './button';

/** Props for CodeBlock: the text, and the name its copy button carries. */
export interface CodeBlockProps {
  /** The exact text shown and copied. */
  code: string;
  /** What the text is, read out as "Copy <label>". */
  label: string;
  /** Shows a `$` before each line, for shell commands, left out of the copy. */
  prompt?: boolean;
  className?: string;
}

/** Renders the text in a scrolling block with a copy button. */
export const CodeBlock: React.FC<CodeBlockProps> = ({
  code,
  label,
  prompt = false,
  className,
}) => {
  const { copied, copy } = useCopy();

  return (
    <div
      className={cn(
        'relative rounded-md border border-line bg-surface',
        className
      )}
    >
      <pre className="flex gap-2 overflow-x-auto py-2 pr-11 pl-3 font-mono text-xs leading-5 text-text">
        {prompt && (
          <span aria-hidden="true" className="text-text-faint select-none">
            {code
              .split('\n')
              .map(() => '$')
              .join('\n')}
          </span>
        )}
        <code>{code}</code>
      </pre>
      <div className="absolute top-1 right-1">
        <IconButton
          size="sm"
          label={copied ? 'Copied' : `Copy ${label}`}
          onClick={() => {
            copy(code);
          }}
        >
          {copied ? (
            <LuCheck aria-hidden="true" className="h-3.5 w-3.5 text-success" />
          ) : (
            <LuCopy aria-hidden="true" className="h-3.5 w-3.5" />
          )}
        </IconButton>
      </div>
    </div>
  );
};

export default CodeBlock;
