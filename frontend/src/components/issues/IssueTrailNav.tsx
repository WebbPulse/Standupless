/**
 * The issue page's place in the list it was opened from: a `3 / 24` counter
 * with previous and next buttons in the page bar, `k` and `j` to step to the
 * previous and next issue, and Escape to return to the list. Renders nothing
 * and binds nothing when the issue was not opened from a list.
 */

import React, { useMemo } from 'react';
import { LuChevronDown, LuChevronUp } from 'react-icons/lu';
import { useNavigate } from 'react-router-dom';
import { useShortcut } from '../../hooks/useShortcuts';
import { readTrail, trailPosition } from '../../lib/issueTrail';
import { issuePath } from '../../lib/paths';
import { IconButton } from '../ui/button';

/** Props for IssueTrailNav. */
export interface IssueTrailNavProps {
  slug: string;
  issueKey: string;
}

/** The counter, the step buttons and their keys. */
export const IssueTrailNav: React.FC<IssueTrailNavProps> = ({
  slug,
  issueKey,
}) => {
  const navigate = useNavigate();
  const position = useMemo(
    () => trailPosition(readTrail(), slug, issueKey),
    [slug, issueKey]
  );

  const go = (key: string | null): void => {
    if (key !== null) void navigate(issuePath(slug, key));
  };

  useShortcut({
    keys: 'j',
    label: 'Next issue',
    scope: 'page',
    group: 'Issue',
    enabled: (position?.next ?? null) !== null,
    handler: () => {
      go(position?.next ?? null);
    },
  });
  useShortcut({
    keys: 'k',
    label: 'Previous issue',
    scope: 'page',
    group: 'Issue',
    enabled: (position?.previous ?? null) !== null,
    handler: () => {
      go(position?.previous ?? null);
    },
  });
  useShortcut({
    keys: 'escape',
    label: 'Back to list',
    scope: 'page',
    group: 'Issue',
    enabled: position !== null,
    handler: () => {
      if (position !== null) void navigate(position.from);
    },
  });

  if (position === null) return null;

  return (
    <div className="flex items-center gap-0.5">
      <span
        className="px-1.5 text-xs text-text-muted tabular-nums"
        aria-label={`Issue ${String(position.index + 1)} of ${String(position.total)}`}
      >
        {position.index + 1}
        <span className="text-text-faint"> / {position.total}</span>
      </span>
      <IconButton
        label="Previous issue (K)"
        size="sm"
        disabled={position.previous === null}
        onClick={() => {
          go(position.previous);
        }}
      >
        <LuChevronUp aria-hidden="true" className="h-4 w-4" />
      </IconButton>
      <IconButton
        label="Next issue (J)"
        size="sm"
        disabled={position.next === null}
        onClick={() => {
          go(position.next);
        }}
      >
        <LuChevronDown aria-hidden="true" className="h-4 w-4" />
      </IconButton>
    </div>
  );
};

export default IssueTrailNav;
