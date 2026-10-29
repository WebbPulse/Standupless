/**
 * The caller's own reminder on one project, initiative or document, read once
 * per page and shared by the page menu, the command palette and the banner
 * that shows a pending reminder. It is the issue reminder on another kind of
 * subject: private to the caller, one per subject, and at its moment it lands
 * in the caller's inbox and opens the subject.
 */

import { useCallback } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import {
  cancelEntityReminder,
  listEntityReminders,
  setEntityReminder,
} from '../api/views';
import { errorMessage } from '../lib/errors';
import { entityReminderKey } from '../lib/queryKeys';
import { reminderLabel } from '../lib/reminders';
import { showErrorToast, showToast } from '../lib/toast';
import type { ReminderEntityType, ReminderRead } from '../types/Api';

/** How often the pending reminder is re-read while the page is open. */
const POLL_MS = 60000;

/** What the "Remind me" dialog needs of a reminder, on any kind of subject. */
export interface ReminderHandle {
  /** The pending reminder, or null when there is none or before the first read lands. */
  reminder: { remind_at: string } | null;
  /** Reminds the caller at `moment`, replacing any reminder already set, and resolves once saved. */
  set: (moment: Date) => Promise<boolean>;
  /** Cancels the pending reminder. */
  cancel: () => void;
}

/** What useEntityReminder returns. */
export interface EntityReminder extends ReminderHandle {
  reminder: ReminderRead | null;
}

/**
 * Reads the caller's reminder on one subject and sets or cancels it. An empty
 * id waits without reading, for a page still resolving what it shows.
 */
export const useEntityReminder = (
  workspaceId: string,
  entityType: Exclude<ReminderEntityType, 'issue'>,
  entityId: string
): EntityReminder => {
  const auth = useQueryAuth();
  const ready = workspaceId !== '' && entityId !== '';
  const key = entityReminderKey(workspaceId, entityType, entityId);

  const { data } = usePolledQuery(
    ({ signal }) =>
      listEntityReminders(workspaceId, entityType, entityId, signal),
    { intervalMs: POLL_MS, queryKey: key, auth, enabled: ready }
  );

  const reminder =
    data?.find(
      (row) => row.entity_type === entityType && row.entity_id === entityId
    ) ?? null;

  const set = useCallback(
    async (moment: Date): Promise<boolean> => {
      if (!ready) return false;
      try {
        const saved = await setEntityReminder(
          workspaceId,
          entityType,
          entityId,
          moment.toISOString()
        );
        invalidateQueries(entityReminderKey(workspaceId, entityType, entityId));
        showToast(`Reminder set for ${reminderLabel(saved.remind_at)}.`);
        return true;
      } catch (failure: unknown) {
        showErrorToast(errorMessage(failure, 'Could not set the reminder.'));
        return false;
      }
    },
    [ready, workspaceId, entityType, entityId]
  );

  const cancel = useCallback((): void => {
    if (!ready) return;
    void cancelEntityReminder(workspaceId, entityType, entityId)
      .then(() => {
        invalidateQueries(entityReminderKey(workspaceId, entityType, entityId));
        showToast('Reminder cancelled.');
      })
      .catch((failure: unknown) => {
        showErrorToast(errorMessage(failure, 'Could not cancel the reminder.'));
      });
  }, [ready, workspaceId, entityType, entityId]);

  return { reminder, set, cancel };
};
