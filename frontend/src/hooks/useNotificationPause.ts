/**
 * Pausing and resuming notifications from anywhere in the app. The pause is a
 * preference on the signed in profile, so saving it replaces the session's
 * user with what the server stored, and every place reading `useAuth` shows
 * the same answer. While paused, email and desktop notifications wait and the
 * inbox still fills.
 */

import { useCallback, useEffect, useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { updatePreferences } from '../api/notifications';
import { notificationsHeldUntil, pausedUntil } from '../lib/notificationPause';
import { CURRENT_USER_KEY } from '../lib/queryKeys';
import { useAuth } from './useAuth';

/** How often the running pause is re-read against the clock, so an ended pause clears on its own. */
const TICK_MS = 30000;

/** What useNotificationPause answers. */
export interface NotificationPause {
  /** The end of the running pause, or null when none is running. */
  pausedUntil: Date | null;
  /** When notifications may reach the person again, by pause or working hours, or null when they may now. */
  heldUntil: Date | null;
  saving: boolean;
  error: unknown;
  /** Pauses until `until`, answering whether the server kept it. */
  pause: (until: Date) => Promise<boolean>;
  /** Ends the running pause now. */
  resume: () => Promise<boolean>;
}

/** The signed in person's notification pause, and a way to change it. */
export const useNotificationPause = (): NotificationPause => {
  const { user, login } = useAuth();
  const [now, setNow] = useState(() => new Date());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date());
    }, TICK_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const store = useCallback(
    async (until: Date | null): Promise<boolean> => {
      setSaving(true);
      setError(null);
      try {
        const stored = await updatePreferences({
          notifications_paused_until:
            until === null ? null : until.toISOString(),
        });
        login(stored);
        invalidateQueries(CURRENT_USER_KEY);
        setNow(new Date());
        return true;
      } catch (failure: unknown) {
        setError(failure);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [login]
  );

  return {
    pausedUntil: pausedUntil(user, now),
    heldUntil: notificationsHeldUntil(user, now),
    saving,
    error,
    pause: store,
    resume: () => store(null),
  };
};
