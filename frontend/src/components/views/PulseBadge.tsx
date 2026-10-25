/**
 * The count beside the Pulse link in the shell: how many updates, health
 * changes and completed milestones on what the caller follows arrived since
 * they last read their Pulse.
 */

import React from 'react';
import type { SidebarBadgeStyle } from '../../types/Api';
import { usePulseCount } from '../../hooks/useSidebarData';

/** Props for PulseBadge: the workspace whose Pulse is counted. */
export interface PulseBadgeProps {
  workspaceId: string;
  /** Draws a dot in place of the number. */
  badgeStyle?: SidebarBadgeStyle;
}

/** The count past which the badge shows "99+". */
const SATURATES_AT = 100;

/** Shows how many Pulse entries are unread, or nothing when none are. */
export const PulseBadge: React.FC<PulseBadgeProps> = ({
  workspaceId,
  badgeStyle = 'count',
}) => {
  const unread = usePulseCount(workspaceId) ?? 0;
  if (unread <= 0) return null;

  const shown = unread >= SATURATES_AT ? '99+' : String(unread);

  if (badgeStyle === 'dot') {
    return (
      <span
        role="img"
        aria-label={`${shown} unread in Pulse`}
        data-testid="sidebar-badge-dot"
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-muted"
      />
    );
  }

  return (
    <span
      aria-label={`${shown} unread in Pulse`}
      className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-raised px-1 text-2xs font-medium text-text-muted tabular-nums"
    >
      {shown}
    </span>
  );
};

export default PulseBadge;
