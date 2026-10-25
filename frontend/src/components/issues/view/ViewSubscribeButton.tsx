/**
 * Following a saved view, as in Linear: a follower hears in their inbox each
 * time an issue newly matches the view, while the issues already in it stay
 * quiet. The header button shows whether the caller follows the view and how
 * many members do, and the count also sits beside the views list's menu item.
 */

import React, { useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { LuBell, LuBellOff } from 'react-icons/lu';
import {
  setViewSubscription,
  type SavedViewDisplayRead,
} from '../../../api/views';
import { errorMessage } from '../../../lib/errors';
import { viewKey, viewsKey } from '../../../lib/queryKeys';
import { showErrorToast, showToast } from '../../../lib/toast';
import { Button } from '../../ui/button';

/** Says how many members follow a view, drawn only once someone does. */
export const SubscriberCount: React.FC<{ count?: number | undefined }> = ({
  count,
}) =>
  count === undefined || count === 0 ? null : (
    <span
      className="ml-auto pl-3 text-xs tabular-nums text-text-faint"
      aria-label={`${count} ${count === 1 ? 'subscriber' : 'subscribers'}`}
    >
      {count}
    </span>
  );

/** Re-reads the view and every views list, so the bell and count agree everywhere. */
const refreshSubscription = (workspaceId: string, viewId: string): void => {
  invalidateQueries([
    viewKey(workspaceId, viewId),
    viewsKey(workspaceId, 'mine', ''),
    viewsKey(workspaceId, 'team', ''),
    viewsKey(workspaceId, 'workspace', ''),
    viewsKey(workspaceId, 'all', ''),
  ]);
};

/** Props for ViewSubscribeButton: the view followed and its workspace. */
export interface ViewSubscribeButtonProps {
  workspaceId: string;
  view: SavedViewDisplayRead;
}

/** The header toggle that follows or unfollows one issue view. */
export const ViewSubscribeButton: React.FC<ViewSubscribeButtonProps> = ({
  workspaceId,
  view,
}) => {
  const [busy, setBusy] = useState(false);
  const subscribed = view.subscribed === true;
  const count = view.subscriber_count ?? 0;

  const toggle = async (): Promise<void> => {
    setBusy(true);
    try {
      await setViewSubscription(workspaceId, view.view_id, !subscribed);
      refreshSubscription(workspaceId, view.view_id);
      showToast(
        subscribed
          ? `Unsubscribed from ${view.name}.`
          : `Subscribed to ${view.name}.`
      );
    } catch (failure) {
      showErrorToast(
        errorMessage(failure, 'Could not change the subscription.')
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      size="sm"
      variant="ghost"
      className="gap-1.5"
      disabled={busy}
      aria-pressed={subscribed}
      title={
        subscribed
          ? 'You hear when issues are added to this view'
          : 'Hear when issues are added to this view'
      }
      onClick={() => void toggle()}
    >
      {subscribed ? (
        <LuBellOff aria-hidden="true" className="h-3.5 w-3.5" />
      ) : (
        <LuBell aria-hidden="true" className="h-3.5 w-3.5" />
      )}
      <span className="max-sm:sr-only">
        {subscribed ? 'Unsubscribe' : 'Subscribe'}
      </span>
      {count > 0 && (
        <span
          className="tabular-nums text-text-faint"
          aria-label={`${count} ${count === 1 ? 'subscriber' : 'subscribers'}`}
        >
          {count}
        </span>
      )}
    </Button>
  );
};

export default ViewSubscribeButton;
