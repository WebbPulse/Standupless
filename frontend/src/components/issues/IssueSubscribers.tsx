/**
 * The subscribers section of the issue rail: who follows the issue, and the
 * caller's own subscribe toggle.
 *
 * Creating, being assigned, commenting and being mentioned all subscribe a
 * person without asking, so the toggle is mostly how someone leaves an issue
 * they no longer care about. Cmd or Ctrl, Shift and S flips it from anywhere
 * on the issue and from the command palette.
 */

import React, { useCallback } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import { LuBell, LuBellOff } from 'react-icons/lu';
import {
  listSubscribers,
  subscribe,
  unsubscribe,
} from '../../api/notifications';
import { displayKeys, useShortcut } from '../../hooks/useShortcuts';
import { errorMessage } from '../../lib/errors';
import { subscribersKey } from '../../lib/queryKeys';
import { showErrorToast, showToast } from '../../lib/toast';
import type { SubscriptionReason } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Avatar from '../ui/avatar';
import { IconButton } from '../ui/button';
import RailSection from './RailSection';

/** The shortcut that subscribes to or unsubscribes from the issue. */
export const TOGGLE_SUBSCRIPTION_KEYS = 'mod+shift+s';

/** How often the subscriber list is re-read while the issue is open. */
const POLL_MS = 30000;

/** How each reason reads beside a subscriber's name. */
const REASON_LABELS: Record<SubscriptionReason, string> = {
  creator: 'Creator',
  assignee: 'Assignee',
  commenter: 'Commented',
  mentioned: 'Mentioned',
  manual: 'Subscribed',
};

/** Props for IssueSubscribers: which issue's subscribers to show. */
export interface IssueSubscribersProps {
  workspaceId: string;
  issueId: string;
}

/** Lists an issue's subscribers and toggles the caller's own subscription. */
export const IssueSubscribers: React.FC<IssueSubscribersProps> = ({
  workspaceId,
  issueId,
}) => {
  const auth = useQueryAuth();
  const queryKey = subscribersKey(workspaceId, issueId);

  const { data, error } = usePolledQuery(
    ({ signal }) => listSubscribers(workspaceId, issueId, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const subscribed = data?.subscribed ?? false;

  const toggle = useCallback((): void => {
    if (data === null) return;
    const leaving = data.subscribed;
    const request = leaving
      ? unsubscribe(workspaceId, issueId)
      : subscribe(workspaceId, issueId);
    void request
      .then(() => {
        invalidateQueries(subscribersKey(workspaceId, issueId));
        showToast(
          leaving
            ? 'Unsubscribed from this issue.'
            : 'Subscribed to this issue.'
        );
      })
      .catch((failure: unknown) => {
        showErrorToast(
          errorMessage(failure, 'Could not change your subscription.')
        );
      });
  }, [data, workspaceId, issueId]);

  const label = subscribed ? 'Unsubscribe from issue' : 'Subscribe to issue';

  useShortcut({
    keys: TOGGLE_SUBSCRIPTION_KEYS,
    label,
    scope: 'issue',
    group: 'Issue',
    enabled: data !== null,
    handler: toggle,
  });

  const subscribers = data?.subscribers ?? [];
  const Icon = subscribed ? LuBellOff : LuBell;

  return (
    <RailSection
      title="Subscribers"
      {...(subscribers.length > 0 ? { count: String(subscribers.length) } : {})}
      actions={
        <IconButton
          label={label}
          size="sm"
          className="h-5 w-5 shrink-0"
          title={`${label} (${displayKeys(TOGGLE_SUBSCRIPTION_KEYS)[0] ?? ''})`}
          disabled={data === null}
          onClick={toggle}
        >
          <Icon className="h-3.5 w-3.5" />
        </IconButton>
      }
    >
      {error !== null ? (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the subscribers.')}
        />
      ) : subscribers.length === 0 ? (
        data === null ? null : (
          <p className="py-1 text-xs text-text-faint">
            Nobody is subscribed to this issue.
          </p>
        )
      ) : (
        <ul aria-label="Subscribers" className="space-y-0.5">
          {subscribers.map((subscriber) => (
            <li
              key={subscriber.user_id}
              className="-mx-1 flex items-center gap-1.5 rounded-sm px-1 py-1 text-xs"
            >
              <Avatar name={subscriber.display_name} size="xs" />
              <span className="min-w-0 flex-1 truncate text-text">
                {subscriber.display_name}
              </span>
              <span className="shrink-0 text-text-faint">
                {REASON_LABELS[subscriber.reason]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </RailSection>
  );
};

export default IssueSubscribers;
