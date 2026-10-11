/**
 * The bell in the issue bar, as in Linear: subscribes to or unsubscribes from
 * the issue whether or not anyone follows it yet, with the shortcut in its
 * tooltip so the keys are discoverable. It renders the issue view's shared
 * subscription state rather than reading its own.
 */

import React from 'react';
import { LuBell, LuBellOff } from 'react-icons/lu';
import {
  subscriptionTitle,
  type IssueSubscription,
} from '../../hooks/useIssueSubscription';
import Button from '../ui/button';
import Tooltip from '../ui/tooltip';

/** Props for IssueSubscribeButton: the issue's shared subscription state. */
export interface IssueSubscribeButtonProps {
  subscription: IssueSubscription;
}

/** A bell that toggles the caller's subscription to the open issue. */
export const IssueSubscribeButton: React.FC<IssueSubscribeButtonProps> = ({
  subscription,
}) => {
  const { data, subscribed, label, toggle } = subscription;
  const Icon = subscribed ? LuBellOff : LuBell;

  return (
    <Tooltip text={subscriptionTitle(label)}>
      <Button
        aria-label={label}
        size="sm"
        variant="ghost"
        className="w-7 px-0 pointer-coarse:w-11"
        disabled={data === null}
        onClick={toggle}
      >
        <Icon aria-hidden="true" className="h-4 w-4" />
      </Button>
    </Tooltip>
  );
};

export default IssueSubscribeButton;
