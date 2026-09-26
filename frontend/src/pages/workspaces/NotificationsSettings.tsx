/**
 * The notification settings page: which kinds of notification reach the inbox
 * and which also send an email.
 *
 * Preferences belong to the person, not to the workspace, so a change here
 * applies in every workspace they are a member of. Each switch saves as soon
 * as it flips, the way the rest of the settings pages do, and the page keeps
 * the answer the server returns rather than what it sent, so a refused change
 * does not leave the switch showing something that is not stored.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import {
  NOTIFICATION_KINDS,
  getCurrentUser,
  updatePreferences,
} from '../../api/notifications';
import { ErrorAlert } from '../../components/ui/alert';
import Checkbox from '../../components/ui/checkbox';
import Spinner from '../../components/ui/spinner';
import SettingsNav from '../../components/workspace/SettingsNav';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
import { errorMessage } from '../../lib/errors';
import { CURRENT_USER_KEY } from '../../lib/queryKeys';
import type {
  NotificationChannels,
  NotificationKind,
  UserPreferencesUpdate,
  UserRead,
} from '../../types/Api';

/** How often the preferences are re-read while the page is open. */
const POLL_MS = 300000;

/** What each kind is called, and when it is sent. */
const KIND_COPY: Record<NotificationKind, { title: string; detail: string }> = {
  assigned: {
    title: 'Assigned to you',
    detail: 'Someone else gives you an issue.',
  },
  mentioned: {
    title: 'Mentions',
    detail: 'You are mentioned in an issue description or a comment.',
  },
  commented: {
    title: 'Comments',
    detail: 'Someone comments on an issue you are subscribed to.',
  },
  status_changed: {
    title: 'Status changes',
    detail: 'An issue you are subscribed to or assigned moves status.',
  },
};

/** The switches a kind shows when the profile has no entry for it. */
const ALL_ON: NotificationChannels = { in_app: true, email: true };

/** The column layout the header and every row share. */
const COLUMNS =
  'grid grid-cols-[minmax(0,1fr)_4rem_4rem] items-center gap-3 px-3';

/** Renders the caller's notification preferences and saves each change. */
const NotificationsSettings: React.FC = () => {
  const { workspace } = useWorkspace();
  const auth = useQueryAuth();
  const [saved, setSaved] = useState<UserRead | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => getCurrentUser(signal),
    { intervalMs: POLL_MS, queryKey: CURRENT_USER_KEY, auth }
  );

  const user = saved ?? data;
  const emailOn = user?.email_notifications ?? true;

  const save = (body: UserPreferencesUpdate): void => {
    setSaving(true);
    setSaveError(null);
    void updatePreferences(body)
      .then((stored) => {
        setSaved(stored);
        invalidateQueries(CURRENT_USER_KEY);
      })
      .catch((failure: unknown) => {
        setSaveError(failure);
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const channelsOf = (kind: NotificationKind): NotificationChannels =>
    user?.notification_preferences?.[kind] ?? ALL_ON;

  return (
    <WorkspaceShell
      title="Settings"
      toolbar={
        workspace === null ? undefined : <SettingsNav workspace={workspace} />
      }
    >
      <div className="max-w-2xl space-y-6">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">Notifications</h2>
          <p className="text-sm text-text-muted">
            Choose what reaches your inbox and what also sends an email. These
            settings are yours and apply in every workspace you belong to.
          </p>
        </div>

        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load your preferences.')}
          />
        )}
        {saveError !== null && (
          <ErrorAlert
            message={errorMessage(saveError, 'Could not save that change.')}
          />
        )}

        {isLoading && user === null ? (
          <Spinner label="Loading your preferences" />
        ) : user === null ? null : (
          <>
            <div className="rounded-md border border-line p-3">
              <Checkbox
                label="Send email notifications"
                checked={emailOn}
                disabled={saving}
                onChange={(event) => {
                  save({ email_notifications: event.target.checked });
                }}
              />
              <p className="mt-1 pl-5.5 text-xs text-text-faint">
                Turning this off stops every email below at once. Your inbox is
                not affected.
              </p>
            </div>

            <div className="rounded-md border border-line">
              <div
                className={`${COLUMNS} h-8 border-b border-line bg-surface text-xs font-medium text-text-muted`}
              >
                <span>Notify me when</span>
                <span className="text-center">Inbox</span>
                <span className="text-center">Email</span>
              </div>
              <ul>
                {NOTIFICATION_KINDS.map((kind) => {
                  const channels = channelsOf(kind);
                  const copy = KIND_COPY[kind];
                  return (
                    <li
                      key={kind}
                      className={`${COLUMNS} min-h-row border-b border-line py-2 last:border-b-0`}
                    >
                      <div className="min-w-0 space-y-0.5">
                        <p className="text-sm font-medium text-text">
                          {copy.title}
                        </p>
                        <p className="text-xs text-text-faint">{copy.detail}</p>
                      </div>
                      <div className="flex justify-center">
                        <input
                          type="checkbox"
                          aria-label={`${copy.title} in your inbox`}
                          className="h-3.5 w-3.5 rounded-xs border-line-strong"
                          checked={channels.in_app}
                          disabled={saving}
                          onChange={(event) => {
                            save({
                              notification_preferences: {
                                [kind]: { in_app: event.target.checked },
                              },
                            });
                          }}
                        />
                      </div>
                      <div className="flex justify-center">
                        <input
                          type="checkbox"
                          aria-label={`${copy.title} by email`}
                          className="h-3.5 w-3.5 rounded-xs border-line-strong"
                          checked={emailOn && channels.email}
                          disabled={saving || !emailOn}
                          onChange={(event) => {
                            save({
                              notification_preferences: {
                                [kind]: { email: event.target.checked },
                              },
                            });
                          }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </>
        )}
      </div>
    </WorkspaceShell>
  );
};

export default NotificationsSettings;
