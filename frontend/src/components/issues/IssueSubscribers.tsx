/**
 * The subscribers section of the issue rail: who follows the issue, and the
 * caller's own subscribe toggle.
 *
 * Creating, being assigned, commenting and being mentioned all subscribe a
 * person without asking, so the toggle is mostly how someone leaves an issue
 * they no longer care about. The state comes from useIssueSubscription, read
 * once by the issue view, so this section, the bell in the issue bar, the
 * shortcut and the command palette always agree.
 */

import React from 'react';
import { LuBell, LuBellOff } from 'react-icons/lu';
import {
  subscriptionTitle,
  type IssueSubscription,
} from '../../hooks/useIssueSubscription';
import { errorMessage } from '../../lib/errors';
import type { SubscriptionReason } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Avatar from '../ui/avatar';
import { IconButton } from '../ui/button';
import RailSection from './RailSection';

/** How each reason reads beside a subscriber's name. */
const REASON_LABELS: Record<SubscriptionReason, string> = {
  creator: 'Creator',
  assignee: 'Assignee',
  commenter: 'Commented',
  mentioned: 'Mentioned',
  manual: 'Subscribed',
};

/** Props for IssueSubscribers: the issue's shared subscription state. */
export interface IssueSubscribersProps {
  subscription: IssueSubscription;
}

/**
 * Lists an issue's subscribers and toggles the caller's own subscription. The
 * section stays on the rail when nobody follows the issue, so the toggle is
 * always reachable there as well as in the issue bar.
 */
export const IssueSubscribers: React.FC<IssueSubscribersProps> = ({
  subscription,
}) => {
  const { data, error, subscribed, label, toggle } = subscription;
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
          title={subscriptionTitle(label)}
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
              <Avatar
                name={subscriber.display_name}
                src={subscriber.avatar_url}
                size="xs"
              />
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
