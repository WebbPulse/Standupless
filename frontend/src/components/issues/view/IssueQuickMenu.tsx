/**
 * The short menu a swipe left on a touch row opens, the few things a thumb
 * does to an issue on the go: take it or hand it back, set its priority, or
 * snooze it with a private reminder that lands in the inbox at the chosen
 * moment, the way Linear's mobile list does.
 */

import React from 'react';
import { LuBellRing, LuSignal, LuUserRound } from 'react-icons/lu';
import type { OrderedIssueRead } from '../../../api/issues';
import { setReminder } from '../../../api/views';
import { errorMessage } from '../../../lib/errors';
import { issueReminderKey } from '../../../lib/queryKeys';
import { reminderLabel, reminderPresets } from '../../../lib/reminders';
import { showErrorToast, showToast } from '../../../lib/toast';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { ContextMenu, MenuItem, MenuSeparator } from '../../ui/menu';

/** Props for IssueQuickMenu. */
export interface IssueQuickMenuProps {
  /** Where the menu opens, in viewport coordinates. */
  x: number;
  y: number;
  issue: OrderedIssueRead;
  workspaceId: string;
  /** The signed in person's id, or undefined when they cannot take issues. */
  meId?: string | undefined;
  /** Whether the issue can be edited, which assigning and priority need. */
  canEdit: boolean;
  /** Assigns the issue to the viewer, or takes it back off them. */
  onAssignToMe: () => void;
  /** Opens the priority picker on the issue. */
  onPriority: () => void;
  onClose: () => void;
}

/** Sets a reminder on one issue and says when it lands. */
const snooze = async (
  workspaceId: string,
  issueId: string,
  moment: Date
): Promise<void> => {
  try {
    const saved = await setReminder(workspaceId, issueId, moment.toISOString());
    invalidateQueries(issueReminderKey(workspaceId, issueId));
    showToast(`Reminder set for ${reminderLabel(saved.remind_at)}.`);
  } catch (failure: unknown) {
    showErrorToast(errorMessage(failure, 'Could not set the reminder.'));
  }
};

/** Assign to me, priority and snooze presets for one issue. */
const IssueQuickMenu: React.FC<IssueQuickMenuProps> = ({
  x,
  y,
  issue,
  workspaceId,
  meId,
  canEdit,
  onAssignToMe,
  onPriority,
  onClose,
}) => {
  const presets = workspaceId === '' ? [] : reminderPresets();
  const mine = meId !== undefined && issue.assignee_id === meId;
  return (
    <ContextMenu
      x={x}
      y={y}
      label={`${issue.key} quick actions`}
      onClose={onClose}
    >
      {canEdit && meId !== undefined && (
        <MenuItem onSelect={onAssignToMe}>
          <LuUserRound aria-hidden="true" className="h-3.5 w-3.5" />
          {mine ? 'Unassign me' : 'Assign to me'}
        </MenuItem>
      )}
      {canEdit && (
        <MenuItem onSelect={onPriority}>
          <LuSignal aria-hidden="true" className="h-3.5 w-3.5" />
          Priority…
        </MenuItem>
      )}
      {canEdit && presets.length > 0 && <MenuSeparator />}
      {presets.map((preset) => (
        <MenuItem
          key={preset.id}
          textValue={`Snooze ${preset.label}`}
          onSelect={() => {
            void snooze(workspaceId, issue.id, preset.at);
          }}
        >
          <LuBellRing aria-hidden="true" className="h-3.5 w-3.5" />
          Snooze: {preset.label}
        </MenuItem>
      ))}
    </ContextMenu>
  );
};

export default IssueQuickMenu;
