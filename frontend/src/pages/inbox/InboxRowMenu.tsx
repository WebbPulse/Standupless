/**
 * The actions of one inbox row, as the menu its "more" button and a right
 * click both open: read or unread, snooze and delete with the keys that do
 * the same, then the issue-only entries, subscribing or unsubscribing, copying
 * the issue's link, and opening the row in a new tab.
 *
 * Whether the caller follows the issue is read when the menu opens, so the
 * entry names the change it will make. Until that read lands, or if it fails,
 * the entry offers to unsubscribe, since being notified about an issue nearly
 * always means following it.
 */

import React, { useEffect, useState } from 'react';
import {
  LuBell,
  LuBellOff,
  LuCheck,
  LuClock,
  LuLink,
  LuMailOpen,
  LuSquareArrowOutUpRight,
  LuTrash2,
} from 'react-icons/lu';
import { listSubscribers } from '../../api/notifications';
import {
  MenuItem,
  MenuSeparator,
  MenuShortcut,
} from '../../components/ui/menu';
import { TOGGLE_SUBSCRIPTION_KEYS } from '../../components/issues/view/propertyKeys';
import type { InboxGroup } from './groups';

/** The key that toggles read and unread. */
export const TOGGLE_READ_KEYS = 'u';

/** The key that snoozes a row. */
export const SNOOZE_KEYS = 'h';

/** The key that deletes a row. */
export const REMOVE_KEYS = 'backspace';

/**
 * Whether the caller follows one issue, read once while the menu is open:
 * null before the read lands, when it fails, or for a row with no issue.
 */
const useSubscribed = (
  workspaceId: string,
  issueId: string | null
): boolean | null => {
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  useEffect(() => {
    if (issueId === null || workspaceId === '') return;
    const controller = new AbortController();
    listSubscribers(workspaceId, issueId, controller.signal)
      .then((read) => {
        setSubscribed(read.subscribed);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [workspaceId, issueId]);
  return subscribed;
};

/** Props for InboxRowMenuItems: the row, what it is about and what each entry does. */
export interface InboxRowMenuItemsProps {
  workspaceId: string;
  group: InboxGroup;
  /** Whether the row is about an issue, which offers the issue-only entries. */
  issueRow: boolean;
  onToggleRead: () => void;
  onSnooze: () => void;
  onRemove: () => void;
  /** Subscribes when `subscribe` is true, unsubscribes otherwise. */
  onSubscription: (subscribe: boolean) => void;
  onCopyLink: () => void;
  onOpenInNewTab: () => void;
}

/** The entries of one row's menu, shared by its "more" button and its context menu. */
export const InboxRowMenuItems: React.FC<InboxRowMenuItemsProps> = ({
  workspaceId,
  group,
  issueRow,
  onToggleRead,
  onSnooze,
  onRemove,
  onSubscription,
  onCopyLink,
  onOpenInNewTab,
}) => {
  const subscribed = useSubscribed(
    workspaceId,
    issueRow ? group.latest.issue_id : null
  );
  const joining = subscribed === false;
  return (
    <>
      <MenuItem onSelect={onToggleRead}>
        {group.unread ? (
          <LuCheck aria-hidden="true" className="h-3.5 w-3.5" />
        ) : (
          <LuMailOpen aria-hidden="true" className="h-3.5 w-3.5" />
        )}
        {group.unread ? 'Mark as read' : 'Mark as unread'}
        <MenuShortcut keys={TOGGLE_READ_KEYS} />
      </MenuItem>
      <MenuItem onSelect={onSnooze}>
        <LuClock aria-hidden="true" className="h-3.5 w-3.5" />
        Snooze
        <MenuShortcut keys={SNOOZE_KEYS} />
      </MenuItem>
      <MenuItem danger onSelect={onRemove}>
        <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
        Delete notification
        <MenuShortcut keys={REMOVE_KEYS} />
      </MenuItem>
      <MenuSeparator />
      {issueRow && (
        <>
          <MenuItem
            onSelect={() => {
              onSubscription(joining);
            }}
          >
            {joining ? (
              <LuBell aria-hidden="true" className="h-3.5 w-3.5" />
            ) : (
              <LuBellOff aria-hidden="true" className="h-3.5 w-3.5" />
            )}
            {joining ? 'Subscribe to issue' : 'Unsubscribe from issue'}
            <MenuShortcut keys={TOGGLE_SUBSCRIPTION_KEYS} />
          </MenuItem>
          <MenuItem onSelect={onCopyLink}>
            <LuLink aria-hidden="true" className="h-3.5 w-3.5" />
            Copy issue link
          </MenuItem>
        </>
      )}
      <MenuItem onSelect={onOpenInNewTab}>
        <LuSquareArrowOutUpRight aria-hidden="true" className="h-3.5 w-3.5" />
        Open in new tab
      </MenuItem>
    </>
  );
};

export default InboxRowMenuItems;
