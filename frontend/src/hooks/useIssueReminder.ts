/**
 * The caller's own reminder on one issue, read once per issue view and shared
 * by the issue menu, the command palette, the H shortcut and the banner that
 * shows a pending reminder. A reminder is private: nobody else sees it, and at
 * its moment it becomes a notification in the caller's inbox.
 */

import { useCallback } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import { cancelReminder, listReminders, setReminder } from '../api/views';
import { errorMessage } from '../lib/errors';
import { issueReminderKey } from '../lib/queryKeys';
import { reminderLabel } from '../lib/reminders';
import { showErrorToast, showToast } from '../lib/toast';
import type { IssueReminderRead } from '../types/Api';

/** The shortcut that opens "Remind me" on the issue in view. */
export const REMIND_ME_KEYS = 'h';

/** The command's name in the issue menu and the palette. */
export const REMIND_ME_LABEL = 'Remind me';

/** How often the pending reminder is re-read while the issue is open. */
const POLL_MS = 60000;

/** What useIssueReminder returns. */
export interface IssueReminder {
  /** The pending reminder, or null when there is none or before the first read lands. */
  reminder: IssueReminderRead | null;
  /** Reminds the caller at `moment`, replacing any reminder already set, and resolves once saved. */
  set: (moment: Date) => Promise<boolean>;
  /** Cancels the pending reminder. */
  cancel: () => void;
}

/**
 * Reads the caller's reminder on one issue and sets or cancels it. An empty
 * issue id waits without reading, for a view still resolving its issue.
 */
export const useIssueReminder = (
  workspaceId: string,
  issueId: string
): IssueReminder => {
  const auth = useQueryAuth();
  const ready = workspaceId !== '' && issueId !== '';

  const { data } = usePolledQuery(
    ({ signal }) => listReminders(workspaceId, issueId, signal),
    {
      intervalMs: POLL_MS,
      queryKey: issueReminderKey(workspaceId, issueId),
      auth,
      enabled: ready,
    }
  );

  const reminder = data?.find((row) => row.issue_id === issueId) ?? null;

  const set = useCallback(
    async (moment: Date): Promise<boolean> => {
      if (!ready) return false;
      try {
        const saved = await setReminder(
          workspaceId,
          issueId,
          moment.toISOString()
        );
        invalidateQueries(issueReminderKey(workspaceId, issueId));
        showToast(`Reminder set for ${reminderLabel(saved.remind_at)}.`);
        return true;
      } catch (failure: unknown) {
        showErrorToast(errorMessage(failure, 'Could not set the reminder.'));
        return false;
      }
    },
    [ready, workspaceId, issueId]
  );

  const cancel = useCallback((): void => {
    if (!ready) return;
    void cancelReminder(workspaceId, issueId)
      .then(() => {
        invalidateQueries(issueReminderKey(workspaceId, issueId));
        showToast('Reminder cancelled.');
      })
      .catch((failure: unknown) => {
        showErrorToast(errorMessage(failure, 'Could not cancel the reminder.'));
      });
  }, [ready, workspaceId, issueId]);

  return { reminder, set, cancel };
};
