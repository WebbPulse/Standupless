/**
 * The blocked and blocking flags a list row, board card, peek or issue page
 * shows beside an issue, each with its count beside it, a count of one
 * included, the way sub-issue counts read. The server keeps both counts on the
 * issue itself, so a page of rows draws them without asking for any relations:
 * `blocked_by_open_count` counts open blockers only, so a completed or
 * cancelled blocker drops out, and `blocking_count` counts the open issues this
 * one holds up and is zero once the issue itself is finished.
 *
 * Hovering a flag reads that one issue's links once and names the issues in
 * the tooltip, key and title, the way Linear lists them on hover. The flag
 * sits above the row's stretched link so a pointer can reach it, and lets taps
 * through on touch screens, where there is no hover to give.
 */

import React, { useCallback, useRef, useState } from 'react';
import { listLinks } from '../../api/issues';
import { cn } from '../../lib/cn';
import type { LinkRead, LinkTypeRead } from '../../types/Api';
import { Tooltip } from '../ui/tooltip';
import {
  BLOCKED_TONE,
  BLOCKING_TONE,
  BlockedGlyph,
  BlockingGlyph,
} from './RelationGlyphs';

/** The longest title a tooltip line carries before it is cut short. */
const TITLE_LIMIT = 60;

/** The most issues a tooltip names before it counts the rest. */
const LINE_LIMIT = 8;

/** Props for BlockedMarker: the issue's open blocker count and where it lives. */
export interface BlockedMarkerProps {
  count: number | undefined;
  /** The workspace and issue whose links the tooltip reads on hover. */
  workspaceId?: string;
  issueId?: string;
  className?: string;
}

/** Props for BlockingMarker: how many issues this one blocks, and where it lives. */
export type BlockingMarkerProps = BlockedMarkerProps;

/** How the blocked mark is named to a screen reader. */
const blockedLabel = (count: number): string =>
  count === 1
    ? 'Blocked by 1 open issue'
    : `Blocked by ${String(count)} open issues`;

/** How the blocking mark is named to a screen reader. */
const blockingLabel = (count: number): string =>
  count === 1 ? 'Blocking 1 issue' : `Blocking ${String(count)} issues`;

/** A title cut to the tooltip's width, ending in an ellipsis when cut. */
const clip = (title: string): string =>
  title.length > TITLE_LIMIT ? `${title.slice(0, TITLE_LIMIT - 1)}…` : title;

/** Whether a link's far side is completed or cancelled. */
const resolved = (link: LinkRead): boolean => {
  const category = link.target_status?.category;
  return category === 'completed' || category === 'cancelled';
};

/**
 * The tooltip lines for the links of one type, open blockers only on the
 * blocked side, at most `LINE_LIMIT` of them with the rest counted.
 */
export const relationLines = (
  links: LinkRead[],
  type: LinkTypeRead
): string[] => {
  const rows = links.filter(
    (link) => link.type === type && (type !== 'blocked_by' || !resolved(link))
  );
  const lines = rows
    .slice(0, LINE_LIMIT)
    .map((link) => `${link.target_key}  ${clip(link.target_title)}`);
  if (rows.length > LINE_LIMIT)
    lines.push(`and ${String(rows.length - LINE_LIMIT)} more`);
  return lines;
};

/** Props for the shared flag: everything one marker needs to draw. */
interface MarkerProps extends BlockedMarkerProps {
  type: LinkTypeRead;
  label: (count: number) => string;
  glyph: React.FC<{ className?: string }>;
  tone: string;
}

/** One flag with its tooltip, which fills in the related issues on first hover. */
const Marker: React.FC<MarkerProps> = ({
  count,
  workspaceId,
  issueId,
  className,
  type,
  label,
  glyph: Glyph,
  tone,
}) => {
  const [lines, setLines] = useState<string[] | null>(null);
  const asked = useRef(false);

  const load = useCallback((): void => {
    if (asked.current || !workspaceId || !issueId) return;
    asked.current = true;
    listLinks(workspaceId, issueId)
      .then((links) => {
        setLines(relationLines(links, type));
      })
      .catch(() => {
        asked.current = false;
      });
  }, [workspaceId, issueId, type]);

  if (count === undefined || count <= 0) return null;
  const name = label(count);
  const text =
    lines === null || lines.length === 0
      ? name
      : `${name}\n${lines.join('\n')}`;
  return (
    <Tooltip
      text={text}
      className={cn(
        'relative z-10 shrink-0 pointer-coarse:pointer-events-none',
        className
      )}
    >
      <span
        role="img"
        aria-label={name}
        data-relation-marker={type}
        className={cn('inline-flex shrink-0 items-center gap-0.5', tone)}
        onPointerEnter={load}
        onFocus={load}
      >
        <Glyph className="h-3.5 w-3.5" />
        <span
          data-relation-count
          className="text-xs leading-none font-medium tabular-nums"
        >
          {count}
        </span>
      </span>
    </Tooltip>
  );
};

/** The blocked flag, or nothing when no open issue blocks this one. */
export const BlockedMarker: React.FC<BlockedMarkerProps> = (props) => (
  <Marker
    {...props}
    type="blocked_by"
    label={blockedLabel}
    glyph={BlockedGlyph}
    tone={BLOCKED_TONE}
  />
);

/** The blocking flag, or nothing when this issue blocks nothing or is finished. */
export const BlockingMarker: React.FC<BlockingMarkerProps> = (props) => (
  <Marker
    {...props}
    type="blocks"
    label={blockingLabel}
    glyph={BlockingGlyph}
    tone={BLOCKING_TONE}
  />
);

/** Props for RelationMarkers: the issue whose counts and links it reads. */
export interface RelationMarkersProps {
  issue: {
    id: string;
    workspace_id: string;
    blocked_by_open_count?: number;
    blocking_count?: number;
  };
  className?: string;
}

/** Both flags for one issue, blocked first, each drawn only when it applies. */
export const RelationMarkers: React.FC<RelationMarkersProps> = ({
  issue,
  className,
}) => (
  <>
    <BlockedMarker
      count={issue.blocked_by_open_count}
      workspaceId={issue.workspace_id}
      issueId={issue.id}
      {...(className === undefined ? {} : { className })}
    />
    <BlockingMarker
      count={issue.blocking_count}
      workspaceId={issue.workspace_id}
      issueId={issue.id}
      {...(className === undefined ? {} : { className })}
    />
  </>
);

export default BlockedMarker;
