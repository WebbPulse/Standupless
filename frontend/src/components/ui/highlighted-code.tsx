/**
 * A fenced code block in rendered Markdown: highlighted in its fence language,
 * or by detection when it names none, with a copy button that shows on hover
 * or focus. It reads as plain text until the highlighter's chunk arrives. The
 * highlighted runs are React elements, never HTML, so a snippet cannot inject
 * markup.
 */

import React, { useMemo } from 'react';
import { LuCheck, LuCopy } from 'react-icons/lu';
import { useCopy } from '../../hooks/useCopy';
import { useHighlighter } from '../../hooks/useHighlighter';
import {
  highlightClasses,
  highlightCode,
  type HighlightNode,
} from '../../lib/highlight';
import './codeBlock.css';

/** Props for HighlightedCode: the fence language and the code. */
export interface HighlightedCodeProps {
  language: string;
  value: string;
}

/** Renders highlighted runs as spans carrying their token classes. */
const renderRuns = (
  nodes: HighlightNode[],
  prefix: string
): React.ReactNode[] =>
  nodes.map((node, index) => {
    const key = `${prefix}-${String(index)}`;
    if (node.type === 'text') {
      return <React.Fragment key={key}>{node.value}</React.Fragment>;
    }
    return (
      <span key={key} className={highlightClasses(node)}>
        {renderRuns(node.children, key)}
      </span>
    );
  });

/** Renders one fenced block with highlighting and a copy button. */
export const HighlightedCode: React.FC<HighlightedCodeProps> = ({
  language,
  value,
}) => {
  const highlighter = useHighlighter();
  const { copied, copy } = useCopy();
  const runs = useMemo(
    () =>
      highlighter === null ? null : highlightCode(highlighter, language, value),
    [highlighter, language, value]
  );
  const copyLabel = copied ? 'Copied' : 'Copy code';

  return (
    <div className="code-block">
      <pre className="overflow-x-auto rounded-md border border-line bg-surface px-3 py-2 font-mono text-xs leading-5 text-text">
        <code
          className={
            language === ''
              ? 'code-highlight'
              : `code-highlight language-${language}`
          }
        >
          {runs === null ? value : renderRuns(runs, 'h')}
        </code>
      </pre>
      <div className="absolute top-1 right-1 flex items-center">
        <button
          type="button"
          className="code-block-copy"
          aria-label={copyLabel}
          title={copyLabel}
          data-copied={String(copied)}
          onClick={() => {
            copy(value);
          }}
        >
          {copied ? (
            <LuCheck aria-hidden="true" />
          ) : (
            <LuCopy aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
};

export default HighlightedCode;
