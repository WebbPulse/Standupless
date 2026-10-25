/**
 * Binds Cmd or Ctrl+Alt+1 to 9 to setting the issues in focus to the status
 * in that position of their team's workflow, one registration per digit, so
 * the list, the board, the issue page, the pane and peek all share one set of
 * keys and one write path, and undo records the change like any picker edit.
 */

import React from 'react';
import { useShortcut, type ShortcutScope } from '../../../hooks/useShortcuts';
import {
  setStatusByPosition,
  STATUS_POSITIONS,
  statusPositionKeys,
  statusPositionLabel,
  type StatusPositionIssue,
  type StatusPositionWrite,
  type TeamStatuses,
} from '../../../lib/statusPosition';

/** Props for StatusPositionKeys. */
export interface StatusPositionKeysProps {
  issues: readonly StatusPositionIssue[];
  /** Whether the viewer can edit the issues. */
  enabled: boolean;
  statusesFor: TeamStatuses;
  write: StatusPositionWrite;
  scope?: ShortcutScope;
  group?: string;
}

/** Binds one digit to the status at that workflow position. */
const StatusPositionKey: React.FC<
  StatusPositionKeysProps & { position: number }
> = ({
  issues,
  enabled,
  statusesFor,
  write,
  scope = 'issue',
  group,
  position,
}) => {
  useShortcut({
    keys: statusPositionKeys(position),
    label: statusPositionLabel(issues, position, statusesFor),
    scope,
    ...(group === undefined ? {} : { group }),
    enabled: enabled && issues.length > 0,
    handler: (event) => {
      event?.preventDefault();
      setStatusByPosition(issues, position, statusesFor, write);
    },
  });
  return null;
};

/** Binds every status position shortcut. Renders nothing visible. */
export const StatusPositionKeys: React.FC<StatusPositionKeysProps> = (
  props
) => (
  <>
    {STATUS_POSITIONS.map((position) => (
      <StatusPositionKey key={position} {...props} position={position} />
    ))}
  </>
);

export default StatusPositionKeys;
