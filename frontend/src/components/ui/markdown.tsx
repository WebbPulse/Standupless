/**
 * Renders Markdown written in a description or a comment as React elements,
 * from the tree {@link parseMarkdown} builds. Nothing is set as HTML, so a
 * comment cannot inject markup, and a link opens in a new tab without handing
 * the new page a reference back to this one. An issue key renders as a chip
 * with the issue's status and title, and a link to a project or document of
 * the workspace as a chip with its name. Embedded images and videos, and
 * links to attached files, load through the page's media tokens. Fenced code
 * is highlighted, once the highlighter loads, and carries a copy button.
 * A collapsible section is a native `<details>`, closed until it is opened,
 * so it toggles from the keyboard as well as the caret. A GitHub alert such
 * as `> [!NOTE]` is a callout in its kind's tone, as the editor draws it.
 */

import React, { useMemo } from 'react';
import { LuChevronRight } from 'react-icons/lu';
import { useMentionLabel } from '../../contexts/MentionDirectoryContextDefinition';
import { useLinkedReference } from '../../hooks/useLinkedReference';
import { cn } from '../../lib/cn';
import { isContentPath } from '../../lib/media';
import {
  parseMarkdown,
  type BlockNode,
  type InlineNode,
} from '../../lib/markdown';
import { AttachmentLink, MediaEmbed } from '../media/MediaEmbed';
import HighlightedCode from './highlighted-code';
import IssueChip from './IssueChip';
import MarkdownCallout from './markdown-callout';
import ReferenceChip from './ReferenceChip';

/**
 * How tightly a body sets. `comfortable` suits a description read as a
 * document; `compact` suits the short bodies of comments and project updates,
 * set as densely as Linear sets them.
 */
export type MarkdownDensity = 'comfortable' | 'compact';

/** The spacing and line height each density sets. */
const DENSITY_CLASS: Record<MarkdownDensity, string> = {
  comfortable: 'space-y-3 leading-6',
  compact: 'space-y-2 leading-5.5',
};

/** Props for Markdown: the source text and optional classes for the wrapper. */
export interface MarkdownProps {
  source: string;
  className?: string;
  /** How tightly the body sets. Defaults to comfortable. */
  density?: MarkdownDensity;
}

/** A mention, shown as the handle the person uses today. */
const Mention: React.FC<{ handle: string }> = ({ handle }) => {
  const label = useMentionLabel(handle);
  return (
    <span className="rounded-xs bg-accent-soft px-0.5 font-medium text-accent">
      @{label}
    </span>
  );
};

/**
 * A link, drawn as a chip when it points at a project or document of the open
 * workspace and as an ordinary link opening a new tab otherwise.
 */
const MarkdownLink: React.FC<{ href: string; children: React.ReactNode }> = ({
  href,
  children,
}) => {
  const target = useLinkedReference(href);
  if (target !== null) {
    return <ReferenceChip href={href}>{children}</ReferenceChip>;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
};

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
      case 'image':
      case 'video':
        return (
          <MediaEmbed
            key={key}
            kind={node.type}
            src={node.src}
            alt={node.alt}
          />
        );
      case 'link':
        if (isContentPath(node.href)) {
          return (
            <AttachmentLink key={key} href={node.href}>
              {renderInline(node.children, key)}
            </AttachmentLink>
          );
        }
        return (
          <MarkdownLink key={key} href={node.href}>
            {renderInline(node.children, key)}
          </MarkdownLink>
        );
      case 'mention':
        return <Mention key={key} handle={node.handle} />;
      case 'issue':
        return <IssueChip key={key} issueKeyText={node.key} />;
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
        <HighlightedCode
          key={key}
          language={block.language}
          value={block.value}
        />
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
    case 'callout':
      return (
        <MarkdownCallout key={key} kind={block.kind}>
          {block.children.map((child, index) =>
            renderBlock(child, `${key}-${String(index)}`)
          )}
        </MarkdownCallout>
      );
    case 'rule':
      return <hr key={key} className="border-line" />;
    case 'details':
      return (
        <details key={key} className="group">
          <summary className="flex cursor-pointer list-none items-start gap-1 rounded-xs font-medium text-text outline-none hover:bg-raised focus-visible:ring-1 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
            <LuChevronRight
              aria-hidden="true"
              className="mt-[0.3em] h-3.5 w-3.5 shrink-0 text-text-faint transition-transform group-open:rotate-90"
            />
            <span className="min-w-0">
              {block.summary === '' ? 'Details' : block.summary}
            </span>
          </summary>
          <div className="mt-2 space-y-2 pl-4.5">
            {block.children.map((child, index) =>
              renderBlock(child, `${key}-${String(index)}`)
            )}
          </div>
        </details>
      );
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
  density = 'comfortable',
}) => {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div
      className={cn(
        'text-sm break-words text-text',
        DENSITY_CLASS[density],
        className
      )}
    >
      {blocks.map((block, index) => renderBlock(block, `b${String(index)}`))}
    </div>
  );
};

export default Markdown;
