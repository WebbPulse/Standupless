/**
 * The caller's subscription to one issue, read once per issue view and shared
 * by every control that shows it: the bell in the issue bar, the Subscribers
 * section of the rail, the Cmd or Ctrl, Shift and S shortcut and the command
 * palette. One read keeps them in step, so subscribing from any of them flips
 * all of them together. It also adds and removes teammates, for the
 * Subscribers picker and its Manage subscribers palette entry.
 */

import { useCallback } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import { listSubscribers, subscribe, unsubscribe } from '../api/notifications';
import { errorMessage } from '../lib/errors';
import { activityKey, subscribersKey } from '../lib/queryKeys';
import { showErrorToast, showToast } from '../lib/toast';
import type { SubscribersRead } from '../types/Api';
import { displayKeys, useShortcut } from './useShortcuts';

/** The shortcut that subscribes to or unsubscribes from the issue. */
export const TOGGLE_SUBSCRIPTION_KEYS = 'mod+shift+s';

/** A toggle label with its shortcut, for a tooltip. */
export const subscriptionTitle = (label: string): string =>
  `${label} (${displayKeys(TOGGLE_SUBSCRIPTION_KEYS)[0] ?? ''})`;

/** How often the subscriber list is re-read while the issue is open. */
const POLL_MS = 30000;

/** What useIssueSubscription returns. */
export interface IssueSubscription {
  /** The last subscriber list, or null before the first read lands. */
  data: SubscribersRead | null;
  /** The last read failure, or null. */
  error: unknown;
  /** Whether the caller follows the issue. */
  subscribed: boolean;
  /** The toggle's label for the caller's current state. */
  label: string;
  /** Subscribes or unsubscribes, whichever the current state calls for. */
  toggle: () => void;
  /** Subscribes a teammate, named in the confirmation toast. */
  add: (userId: string, name: string) => void;
  /** Unsubscribes a teammate, named in the confirmation toast. */
  remove: (userId: string, name: string) => void;
}

/**
 * Reads an issue's subscribers and binds the subscribe toggle to its shortcut
 * in the issue scope, which also lists it in the command palette. An empty
 * issue id waits without reading, for a view still resolving its issue.
 */
export const useIssueSubscription = (
  workspaceId: string,
  issueId: string
): IssueSubscription => {
  const auth = useQueryAuth();
  const ready = workspaceId !== '' && issueId !== '';

  const { data, error } = usePolledQuery(
    ({ signal }) => listSubscribers(workspaceId, issueId, signal),
    {
      intervalMs: POLL_MS,
      queryKey: subscribersKey(workspaceId, issueId),
      auth,
      enabled: ready,
    }
  );

  const subscribed = data?.subscribed ?? false;

  const toggle = useCallback((): void => {
    if (data === null || !ready) return;
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
  }, [data, ready, workspaceId, issueId]);

  const change = useCallback(
    (userId: string, name: string, adding: boolean): void => {
      if (!ready) return;
      const request = adding
        ? subscribe(workspaceId, issueId, userId)
        : unsubscribe(workspaceId, issueId, userId);
      void request
        .then(() => {
          invalidateQueries(subscribersKey(workspaceId, issueId));
          invalidateQueries(activityKey(issueId));
          showToast(adding ? `Subscribed ${name}.` : `Unsubscribed ${name}.`);
        })
        .catch((failure: unknown) => {
          showErrorToast(
            errorMessage(failure, 'Could not change the subscribers.')
          );
        });
    },
    [ready, workspaceId, issueId]
  );

  const add = useCallback(
    (userId: string, name: string): void => {
      change(userId, name, true);
    },
    [change]
  );

  const remove = useCallback(
    (userId: string, name: string): void => {
      change(userId, name, false);
    },
    [change]
  );

  const label = subscribed ? 'Unsubscribe from issue' : 'Subscribe to issue';

  useShortcut({
    keys: TOGGLE_SUBSCRIPTION_KEYS,
    label,
    scope: 'issue',
    group: 'Issue',
    enabled: ready && data !== null,
    handler: toggle,
  });

  return { data, error, subscribed, label, toggle, add, remove };
};
