/**
 * Renders Markdown written in a description or a comment as React elements,
 * from the tree {@link parseMarkdown} builds. Nothing is set as HTML, so a
 * comment cannot inject markup, and a link opens in a new tab without handing
 * the new page a reference back to this one.
 */

import React, { useMemo } from 'react';
import { cn } from '../../lib/cn';
import {
  parseMarkdown,
  type BlockNode,
  type InlineNode,
} from '../../lib/markdown';

/** Props for Markdown: the source text and optional classes for the wrapper. */
export interface MarkdownProps {
  source: string;
  className?: string;
}

/** Renders a run of inline nodes. */
const renderInline = (nodes: InlineNode[], prefix: string): React.ReactNode[] =>
  nodes.map((node, index) => {
    const key = `${prefix}-${String(index)}`;
    switch (node.type) {
      case 'text':
        return <React.Fragment key={key}>{node.value}</React.Fragment>;
      case 'break':
        return <br key={key} />;
      case 'code':
        return (
          <code
            key={key}
            className="rounded-xs bg-raised px-1 py-px font-mono text-[0.85em] text-text"
          >
            {node.value}
          </code>
        );
      case 'strong':
        return (
          <strong key={key} className="font-semibold text-text">
            {renderInline(node.children, key)}
          </strong>
        );
      case 'em':
        return <em key={key}>{renderInline(node.children, key)}</em>;
      case 'del':
        return (
          <del key={key} className="text-text-muted">
            {renderInline(node.children, key)}
          </del>
        );
      case 'link':
        return (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline-offset-2 hover:underline"
          >
            {renderInline(node.children, key)}
          </a>
        );
      case 'mention':
        return (
          <span
            key={key}
            className="rounded-xs bg-accent-soft px-0.5 font-medium text-accent"
          >
            @{node.handle}
          </span>
        );
    }
  });

/** Renders one block. */
const renderBlock = (block: BlockNode, key: string): React.ReactNode => {
  switch (block.type) {
    case 'paragraph':
      return <p key={key}>{renderInline(block.children, key)}</p>;
    case 'heading': {
      const size =
        block.level === 1
          ? 'text-lg'
          : block.level === 2
            ? 'text-base'
            : 'text-sm';
      return React.createElement(
        `h${String(Math.min(block.level + 1, 6))}`,
        { key, className: cn('font-semibold text-text', size) },
        renderInline(block.children, key)
      );
    }
    case 'code':
      return (
        <pre
          key={key}
          className="overflow-x-auto rounded-md border border-line bg-surface px-3 py-2 font-mono text-xs leading-5 text-text"
        >
          <code>{block.value}</code>
        </pre>
      );
    case 'quote':
      return (
        <blockquote
          key={key}
          className="space-y-2 border-l-2 border-line-strong pl-3 text-text-muted"
        >
          {block.children.map((child, index) =>
            renderBlock(child, `${key}-${String(index)}`)
          )}
        </blockquote>
      );
    case 'rule':
      return <hr key={key} className="border-line" />;
    case 'list': {
      const items = block.items.map((item, index) => {
        const itemKey = `${key}-${String(index)}`;
        if (item.checked === null) {
          return <li key={itemKey}>{renderInline(item.children, itemKey)}</li>;
        }
        return (
          <li key={itemKey} className="flex list-none items-start gap-2">
            <input
              type="checkbox"
              checked={item.checked}
              readOnly
              disabled
              aria-label={item.checked ? 'Done' : 'Not done'}
              className="mt-1.5 h-3.5 w-3.5 shrink-0 accent-[var(--color-accent)]"
            />
            <span
              className={item.checked ? 'text-text-muted line-through' : ''}
            >
              {renderInline(item.children, itemKey)}
            </span>
          </li>
        );
      });
      const tasks = block.items.every((item) => item.checked !== null);
      return block.ordered ? (
        <ol
          key={key}
          start={block.start}
          className="list-decimal space-y-1 pl-5 marker:text-text-faint"
        >
          {items}
        </ol>
      ) : (
        <ul
          key={key}
          className={cn(
            'space-y-1',
            tasks ? 'pl-0' : 'list-disc pl-5 marker:text-text-faint'
          )}
        >
          {items}
        </ul>
      );
    }
  }
};

/** Renders Markdown as prose. */
export const Markdown: React.FC<MarkdownProps> = ({
  source,
  className = '',
}) => {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div
      className={cn(
        'space-y-3 text-sm leading-6 break-words text-text',
        className
      )}
    >
      {blocks.map((block, index) => renderBlock(block, `b${String(index)}`))}
    </div>
  );
};

export default Markdown;
