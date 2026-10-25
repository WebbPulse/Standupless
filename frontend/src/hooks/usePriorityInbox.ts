/**
 * The caller's split inbox setting: whether the inbox splits into Priority and
 * Other tabs, and which notification kinds the Priority tab holds. A change
 * shows at once on the signed in account and is saved to it; a refused save
 * puts the last saved setting back and says so.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { updatePreferences } from '../api/notifications';
import {
  CURRENT_USER_KEY,
  inboxCountKey,
  inboxCountsKey,
} from '../lib/queryKeys';
import { showErrorToast } from '../lib/toast';
import type { InboxKind, UserPreferencesUpdate, UserRead } from '../types/Api';
import { useAuth } from './useAuth';

/** The kinds the Priority tab holds until the person changes them, matching the server. */
export const DEFAULT_PRIORITY_KINDS: readonly InboxKind[] = [
  'mentioned',
  'assigned',
  'review_requested',
  'priority_urgent',
  'sla_breached',
  'reminder',
];

/** What {@link usePriorityInbox} hands back. */
export interface PriorityInbox {
  /** Whether the inbox splits into Priority and Other tabs. */
  enabled: boolean;
  /** Every kind the Priority tab holds. */
  kinds: ReadonlySet<InboxKind>;
  setEnabled: (on: boolean) => void;
  /** Adds kinds to the Priority tab or moves them to Other. */
  setKinds: (kinds: readonly InboxKind[], priority: boolean) => void;
}

/** The signed in person's split inbox setting, with changes that save to the account. */
export const usePriorityInbox = (workspaceId: string): PriorityInbox => {
  const { user, login } = useAuth();
  const latest = useRef<UserRead | null>(user);
  useEffect(() => {
    latest.current = user;
  }, [user]);

  const enabled = user?.priority_inbox === true;
  const stored = user?.priority_kinds;
  const kinds = useMemo(
    () => new Set<InboxKind>(stored ?? DEFAULT_PRIORITY_KINDS),
    [stored]
  );

  const save = useCallback(
    (shownFrom: (held: UserRead) => UserRead, send: UserPreferencesUpdate) => {
      const held = latest.current;
      if (held === null) return;
      const shown = shownFrom(held);
      latest.current = shown;
      login(shown);
      void updatePreferences(send)
        .then((answer) => {
          latest.current = answer;
          login(answer);
          invalidateQueries([
            CURRENT_USER_KEY,
            inboxCountKey(workspaceId),
            inboxCountsKey(workspaceId),
          ]);
        })
        .catch(() => {
          latest.current = held;
          login(held);
          showErrorToast('Could not save your inbox setting.');
        });
    },
    [login, workspaceId]
  );

  const setEnabled = useCallback(
    (on: boolean) => {
      save((held) => ({ ...held, priority_inbox: on }), {
        priority_inbox: on,
      });
    },
    [save]
  );

  const setKinds = useCallback(
    (changed: readonly InboxKind[], priority: boolean) => {
      const held = latest.current;
      if (held === null) return;
      const next = new Set<InboxKind>(
        held.priority_kinds ?? DEFAULT_PRIORITY_KINDS
      );
      for (const kind of changed) {
        if (priority) next.add(kind);
        else next.delete(kind);
      }
      const list = [...next];
      save((current) => ({ ...current, priority_kinds: list }), {
        priority_kinds: list,
      });
    },
    [save]
  );

  return { enabled, kinds, setEnabled, setKinds };
};

export default usePriorityInbox;
