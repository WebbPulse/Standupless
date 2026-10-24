/**
 * The cues that tie a sub-issue to its parent in a list or on a board: tree
 * connectors drawn in a nested title's indent, a done/total chip on a parent,
 * and a muted parent reference on a sub-issue shown apart from its parent.
 * Indentation alone reads like any other row once the parent scrolls away, so
 * each cue names or draws the relationship outright.
 */

import React from 'react';
import { LuChevronRight, LuCornerLeftUp } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { cn } from '../../../lib/cn';
import { progressPercent } from '../../../lib/issueDisplay';
import type { ParentRef, TreeGuide } from '../../../lib/issueTree';
import { issuePath } from '../../../lib/paths';
import ProgressRing from '../../planning/ProgressRing';

/** Where a guide line sits inside one level of indent, in pixels. */
const GUIDE_INSET = 7;

/** The gap left between an elbow's end and the title text, in pixels. */
const ELBOW_GAP = 4;

/** Props for TreeGuides. */
export interface TreeGuidesProps {
  depth: number;
  /** The width one level of nesting indents a title by, in pixels. */
  indent: number;
  guide: TreeGuide | undefined;
  /** True on an unfolded parent, which drops a stub toward its first child. */
  opensBelow: boolean;
}

/**
 * The connector lines of one row, drawn in a zero-width slot ahead of the
 * title so they overlay the title's indent without moving anything: a guide
 * for every ancestor that has more children below, an elbow into this row, and
 * on an unfolded parent a stub that runs down to its first sub-issue.
 */
export const TreeGuides: React.FC<TreeGuidesProps> = ({
  depth,
  indent,
  guide,
  opensBelow,
}) => {
  const at = (level: number): number => (level - 1) * indent + GUIDE_INSET;
  return (
    <span
      aria-hidden="true"
      data-slot="tree"
      className="pointer-events-none relative -mr-2 w-0 shrink-0 self-stretch"
    >
      {guide?.continues.map((more, index) =>
        more ? (
          <span
            key={index}
            data-guide="through"
            className="absolute inset-y-0 w-px bg-line-strong"
            style={{ left: at(index + 1) }}
          />
        ) : null
      )}
      {depth > 0 && guide !== undefined && !guide.last && (
        <span
          data-guide="through"
          className="absolute inset-y-0 w-px bg-line-strong"
          style={{ left: at(depth) }}
        />
      )}
      {depth > 0 && (
        <span
          data-guide="elbow"
          className="absolute top-0 h-1/2 rounded-bl-md border-b border-l border-line-strong"
          style={{
            left: at(depth),
            width: depth * indent - at(depth) - ELBOW_GAP,
          }}
        />
      )}
      {opensBelow && (
        <span
          data-guide="stub"
          className="absolute bottom-0 w-px bg-line-strong"
          style={{ left: at(depth + 1), top: 'calc(50% + 0.625rem)' }}
        />
      )}
    </span>
  );
};

/** Props for SubIssueProgressChip. */
export interface SubIssueProgressChipProps {
  progress: { total: number; completed: number };
  className?: string | undefined;
}

/** A parent's sub-issue progress as a ring and a done/total count. */
export const SubIssueProgressChip: React.FC<SubIssueProgressChipProps> = ({
  progress,
  className,
}) => {
  const done = progress.total > 0 && progress.completed >= progress.total;
  return (
    <span
      title={`Sub-issues done: ${String(progress.completed)} of ${String(progress.total)}`}
      data-chip="sub-issues"
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-line px-1.5 text-2xs whitespace-nowrap tabular-nums',
        done ? 'text-text' : 'text-text-muted',
        className
      )}
    >
      <ProgressRing percent={progressPercent(progress)} size={12} />
      <span>
        {progress.completed}/{progress.total}
      </span>
      <span className="sr-only">sub-issues done</span>
    </span>
  );
};

/** Props for ParentPrefix. */
export interface ParentPrefixProps {
  slug: string;
  parent: ParentRef;
  className?: string | undefined;
}

/**
 * A sub-issue's parent as a muted link ahead of its title, for a row listed
 * apart from its parent. Raised above the row's stretched link so a click
 * opens the parent rather than the row.
 */
export const ParentPrefix: React.FC<ParentPrefixProps> = ({
  slug,
  parent,
  className,
}) => (
  <Link
    to={issuePath(slug, parent.key)}
    data-slot="parent"
    aria-label={`Parent issue ${parent.key}${parent.title ? ` ${parent.title}` : ''}`}
    title={parent.title ? `${parent.key} ${parent.title}` : parent.key}
    className={cn(
      'relative z-10 flex max-w-[40%] min-w-0 shrink items-center gap-1 rounded-xs text-xs text-text-faint transition-colors duration-100 hover:text-text-muted focus-visible:outline-2 focus-visible:outline-accent',
      className
    )}
  >
    <span className="shrink-0 font-mono">{parent.key}</span>
    {parent.title && (
      <span className="hidden min-w-0 truncate sm:inline">{parent.title}</span>
    )}
    <LuChevronRight aria-hidden="true" className="h-3 w-3 shrink-0" />
  </Link>
);

/** Props for CardParentRef. */
export interface CardParentRefProps {
  slug: string;
  parent: ParentRef;
}

/**
 * A board card's line naming its parent, with the parent's sub-issue count
 * when the parent is loaded, so a card says whose step it is and how far the
 * whole is along.
 */
export const CardParentRef: React.FC<CardParentRefProps> = ({
  slug,
  parent,
}) => (
  <Link
    to={issuePath(slug, parent.key)}
    draggable={false}
    data-slot="parent"
    aria-label={`Parent issue ${parent.key}${parent.title ? ` ${parent.title}` : ''}`}
    title={parent.title ? `${parent.key} ${parent.title}` : parent.key}
    className="relative z-10 -mb-0.5 flex min-w-0 items-center gap-1 self-start rounded-xs text-2xs text-text-faint transition-colors duration-100 hover:text-text-muted focus-visible:outline-2 focus-visible:outline-accent"
  >
    <LuCornerLeftUp aria-hidden="true" className="h-3 w-3 shrink-0" />
    <span className="shrink-0 font-mono">{parent.key}</span>
    {parent.title && <span className="min-w-0 truncate">{parent.title}</span>}
    {parent.progress !== undefined && parent.progress.total > 0 && (
      <span className="shrink-0 tabular-nums">
        · {parent.progress.completed}/{parent.progress.total}
        <span className="sr-only"> sub-issues done</span>
      </span>
    )}
  </Link>
);
