/**
 * The subscribers section of the issue rail: who follows the issue, the
 * caller's own subscribe toggle, and a picker that adds or removes anyone who
 * can see the issue.
 *
 * Creating, being assigned, commenting and being mentioned all subscribe a
 * person without asking, so the toggle is mostly how someone leaves an issue
 * they no longer care about. The picker is how a teammate is looped in, or
 * taken off, without them doing it themselves. The state comes from
 * useIssueSubscription, read once by the issue view, so this section, the bell
 * in the issue bar, the shortcuts and the command palette always agree.
 */

import React, { useState } from 'react';
import { LuBell, LuBellOff, LuUserPlus, LuX } from 'react-icons/lu';
import {
  subscriptionTitle,
  type IssueSubscription,
} from '../../hooks/useIssueSubscription';
import { displayKeys, useShortcut } from '../../hooks/useShortcuts';
import { errorMessage } from '../../lib/errors';
import {
  personAvatar,
  personLabel,
  type Assignable,
} from '../../lib/issuePeople';
import type { SubscriberRead, SubscriptionReason } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Avatar from '../ui/avatar';
import { IconButton } from '../ui/button';
import { Combobox, type ComboboxOption } from '../ui/combobox';
import { Popover } from '../ui/popover';
import RailSection from './RailSection';

/** The shortcut that opens the subscriber picker, also listed in the palette. */
export const MANAGE_SUBSCRIBERS_KEYS = 'shift+s';

/** How each reason reads beside a subscriber's name. */
const REASON_LABELS: Record<SubscriptionReason, string> = {
  creator: 'Creator',
  assignee: 'Assignee',
  commenter: 'Commented',
  mentioned: 'Mentioned',
  manual: 'Subscribed',
};

/** Props for IssueSubscribers: the shared subscription state and the people to offer. */
export interface IssueSubscribersProps {
  subscription: IssueSubscription;
  /** The people who can see the issue, offered by the picker. */
  people: Assignable[];
  /** Lists the signed in person first in the picker, marked as such. */
  currentUserId?: string;
}

/**
 * The picker's rows: the caller first, then everyone else who can see the
 * issue, then any subscriber the people list does not hold, so they can still
 * be removed.
 */
const subscriberOptions = (
  people: Assignable[],
  subscribers: SubscriberRead[],
  currentUserId: string | undefined
): ComboboxOption[] => {
  const me = people.find((person) => person.user_id === currentUserId);
  const others = people.filter((person) => person.user_id !== currentUserId);
  const known = new Set(people.map((person) => person.user_id));
  const rows: ComboboxOption[] = (me === undefined ? others : [me, ...others]).map(
    (person) => ({
      value: person.user_id,
      label: personLabel(person),
      icon: (
        <Avatar
          name={personLabel(person)}
          src={personAvatar(person)}
          size="xs"
        />
      ),
      keywords: [person.email],
      ...(person === me ? { detail: 'You' } : {}),
    })
  );
  const extra = subscribers
    .filter((subscriber) => !known.has(subscriber.user_id))
    .map((subscriber) => ({
      value: subscriber.user_id,
      label: subscriber.display_name,
      icon: (
        <Avatar
          name={subscriber.display_name}
          src={subscriber.avatar_url}
          size="xs"
        />
      ),
    }));
  return [...rows, ...extra];
};

/**
 * Lists an issue's subscribers, toggles the caller's own subscription and
 * adds or removes anyone else through the picker or a row's remove control.
 * The section stays on the rail when nobody follows the issue, so the toggle
 * and the picker are always reachable.
 */
export const IssueSubscribers: React.FC<IssueSubscribersProps> = ({
  subscription,
  people,
  currentUserId,
}) => {
  const { data, error, subscribed, label, toggle, add, remove } = subscription;
  const [picking, setPicking] = useState(false);
  const subscribers = data?.subscribers ?? [];
  const Icon = subscribed ? LuBellOff : LuBell;
  const chosen = subscribers.map((subscriber) => subscriber.user_id);
  const options = subscriberOptions(people, subscribers, currentUserId);

  useShortcut({
    keys: MANAGE_SUBSCRIBERS_KEYS,
    label: 'Manage subscribers',
    scope: 'issue',
    group: 'Issue',
    enabled: data !== null,
    handler: () => {
      setPicking(true);
    },
  });

  const pick = (userId: string): void => {
    const name =
      options.find((option) => option.value === userId)?.label ?? 'them';
    if (chosen.includes(userId)) remove(userId, name);
    else add(userId, name);
  };

  return (
    <RailSection
      title="Subscribers"
      {...(subscribers.length > 0 ? { count: String(subscribers.length) } : {})}
      actions={
        <span className="flex items-center gap-0.5">
          <Popover
            label="Manage subscribers"
            align="end"
            contentClassName="w-64"
            open={picking}
            onOpenChange={setPicking}
            trigger={(trigger) => (
              <IconButton
                label="Manage subscribers"
                size="sm"
                className="h-5 w-5 shrink-0"
                title={`Manage subscribers (${displayKeys(MANAGE_SUBSCRIBERS_KEYS)[0] ?? ''})`}
                disabled={data === null}
                {...trigger}
              >
                <LuUserPlus className="h-3.5 w-3.5" />
              </IconButton>
            )}
          >
            <Combobox
              label="Subscribers"
              placeholder="Subscribe people"
              multiple
              options={options}
              selected={chosen}
              onSelect={pick}
              emptyMessage="No people"
            />
          </Popover>
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
        </span>
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
              className="group -mx-1 flex items-center gap-1.5 rounded-sm px-1 py-1 text-xs hover:bg-raised"
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
              <IconButton
                label={`Unsubscribe ${subscriber.display_name}`}
                size="sm"
                className="h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                onClick={() => {
                  remove(subscriber.user_id, subscriber.display_name);
                }}
              >
                <LuX className="h-3 w-3" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </RailSection>
  );
};

export default IssueSubscribers;
