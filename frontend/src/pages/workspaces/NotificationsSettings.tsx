/**
 * The notification settings page: which kinds of notification reach the inbox,
 * which also send an email, and which also arrive as a chat direct message in
 * Slack or Discord.
 *
 * Email arrives in the format the person picks: a short digest by default, or
 * one email per notification. Desktop notifications are switched per device,
 * since the browser holds their permission.
 *
 * The priority inbox switch splits the inbox into Priority and Other tabs, and
 * the Priority column picks which kinds land in the first.
 *
 * Preferences belong to the person, not to the workspace, so a change here
 * applies in every workspace they are a member of. Each switch saves as soon
 * as it flips, the way the rest of the settings pages do, and the page keeps
 * the answer the server returns rather than what it sent, so a refused change
 * does not leave the switch showing something that is not stored.
 *
 * The Slack and Discord links are the exception: they belong to this
 * workspace, because each workspace connects its own Slack workspace and
 * Discord server, and the Chat column stays locked until one link works. A
 * Discord link returns here from Discord's consent screen with its outcome in
 * `?discord_dm=`.
 */

import React, { useCallback, useId, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import {
  NOTIFICATION_KINDS,
  getCurrentUser,
  updatePreferences,
} from '../../api/notifications';
import { getDiscordLink, getSlackLink } from '../../api/integrations';
import { ErrorAlert } from '../../components/ui/alert';
import Checkbox from '../../components/ui/checkbox';
import { Select } from '../../components/ui/select';
import Spinner from '../../components/ui/spinner';
import DesktopNotificationsSettings from '../../components/workspace/DesktopNotificationsSettings';
import DiscordDirectMessages from '../../components/workspace/DiscordDirectMessages';
import ReturnToast from '../../components/workspace/ReturnToast';
import SettingsNav from '../../components/workspace/SettingsNav';
import SlackDirectMessages from '../../components/workspace/SlackDirectMessages';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { discordLinkOutcome } from '../../components/workspace/discordLinkOutcomes';
import { useAuth } from '../../hooks/useAuth';
import { DEFAULT_PRIORITY_KINDS } from '../../hooks/usePriorityInbox';
import { useWorkspace } from '../../hooks/useWorkspace';
import { errorMessage } from '../../lib/errors';
import {
  CURRENT_USER_KEY,
  discordLinkKey,
  inboxCountKey,
  inboxCountsKey,
  slackLinkKey,
} from '../../lib/queryKeys';
import { browserTimezone } from '../../lib/viewerTimezone';
import type {
  DiscordLinkRead,
  EmailFormat,
  InboxKind,
  NotificationChannels,
  NotificationKind,
  PulseDigest,
  SlackLinkRead,
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
  subscribed: {
    title: 'Subscribed by someone',
    detail: 'Someone else subscribes you to an issue.',
  },
  project_update: {
    title: 'Project updates',
    detail: 'Someone posts an update on a project you lead or are a member of.',
  },
  project_update_comment: {
    title: 'Replies on project updates',
    detail:
      'Someone replies to an update you wrote or replied to, or mentions you in a reply. These stay in your inbox.',
  },
  project_update_due: {
    title: 'Project update reminders',
    detail: 'An update is due on a project you lead.',
  },
  initiative_update_due: {
    title: 'Initiative update reminders',
    detail: 'An update is due or overdue on an initiative you own.',
  },
  due_soon: {
    title: 'Due date approaching',
    detail: 'An issue assigned to you is due tomorrow or today.',
  },
  overdue: {
    title: 'Overdue issues',
    detail: 'An issue assigned to you is past its due date.',
  },
  reminder: {
    title: 'Issue reminders',
    detail: 'A reminder you set on an issue comes due.',
  },
  standup_digest: {
    title: 'Standup digests',
    detail: "Your team's scheduled standup digest is ready.",
  },
  sla_at_risk: {
    title: 'SLA at risk',
    detail: 'An issue assigned to you is close to breaching its SLA.',
  },
  sla_breached: {
    title: 'SLA breached',
    detail: 'An issue assigned to you has breached its SLA.',
  },
  review_requested: {
    title: 'Review requests',
    detail:
      'Someone asks you to review a pull request. These stay in your inbox and are not emailed.',
  },
  triage_new: {
    title: 'New in triage',
    detail:
      'An issue enters the triage inbox of a team where you are on triage duty.',
  },
  view_issue_added: {
    title: 'Issues added to views you follow',
    detail:
      'An issue newly matches a saved view you subscribed to. Issues already in the view stay quiet.',
  },
  reaction: {
    title: 'Reactions',
    detail:
      'Someone reacts to a comment you wrote. Reactions within an hour arrive as one notification.',
  },
  issue_completed: {
    title: 'Issue completed',
    detail: 'An issue you are subscribed to or assigned is completed.',
  },
  issue_cancelled: {
    title: 'Issue canceled',
    detail: 'An issue you are subscribed to or assigned is canceled.',
  },
  priority_urgent: {
    title: 'Marked as urgent',
    detail:
      'An issue you are subscribed to or assigned has its priority raised to urgent.',
  },
  blocking_changed: {
    title: 'Blocking changes',
    detail:
      'An issue you are subscribed to or assigned gains or loses a blocking relation, or a blocker is resolved.',
  },
  team_issue_created: {
    title: 'New issues in teams you follow',
    detail:
      "An issue is created in a team where you turned on Issue created in the team's Notifications menu.",
  },
  document_comment: {
    title: 'Document comments',
    detail:
      'Someone comments on a document you follow or mentions you in one. These stay in your inbox.',
  },
};

/** One heading in the settings list and the kinds listed under it. */
interface KindSection {
  title: string;
  kinds: readonly NotificationKind[];
}

/** The headings the settings list groups kinds under, in order. */
const KIND_SECTIONS: readonly KindSection[] = [
  {
    title: 'Assignments and mentions',
    kinds: ['assigned', 'mentioned', 'subscribed', 'review_requested'],
  },
  {
    title: 'Comments and reactions',
    kinds: ['commented', 'reaction', 'document_comment'],
  },
  {
    title: 'Issue changes',
    kinds: [
      'status_changed',
      'issue_completed',
      'issue_cancelled',
      'priority_urgent',
      'blocking_changed',
    ],
  },
  {
    title: 'Dates and SLAs',
    kinds: ['due_soon', 'overdue', 'reminder', 'sla_at_risk', 'sla_breached'],
  },
  {
    title: 'Teams and views',
    kinds: [
      'triage_new',
      'team_issue_created',
      'view_issue_added',
      'standup_digest',
    ],
  },
  {
    title: 'Projects and initiatives',
    kinds: [
      'project_update',
      'project_update_comment',
      'project_update_due',
      'initiative_update_due',
    ],
  },
];

/** Every section, plus one for any kind no heading names yet, so no switch goes missing. */
const sectionsFor = (kinds: readonly NotificationKind[]): KindSection[] => {
  const named = new Set(KIND_SECTIONS.flatMap((section) => section.kinds));
  const rest = kinds.filter((kind) => !named.has(kind));
  return rest.length === 0
    ? [...KIND_SECTIONS]
    : [...KIND_SECTIONS, { title: 'Other', kinds: rest }];
};

/** The kinds that only ever reach the inbox, so their email switch is off and locked. */
const IN_APP_ONLY: ReadonlySet<NotificationKind> = new Set([
  'project_update_comment',
  'review_requested',
  'document_comment',
]);

/** The kinds a chat direct message never carries: the standup digest is a digest already, and review requests stay in the inbox. */
const NOT_IN_CHAT: ReadonlySet<NotificationKind> = new Set([
  'standup_digest',
  'project_update_comment',
  'review_requested',
  'document_comment',
]);

/** The switches a kind shows when the profile has no entry for it. */
const ALL_ON: NotificationChannels = { in_app: true, email: true, chat: true };

/** Kinds that start with only the inbox on, matching the server's defaults. */
const INBOX_DEFAULT: Partial<Record<NotificationKind, NotificationChannels>> = {
  reaction: { in_app: true, email: false, chat: false },
};

/** Every timezone the browser knows, with `current` kept even when it is not among them. */
const zoneChoices = (current: string): string[] => {
  let known: string[];
  try {
    known = Intl.supportedValuesOf('timeZone');
  } catch {
    known = [];
  }
  return known.includes(current) ? known : [current, ...known];
};

/** The Pulse digest cadences, in the order the picker lists them. */
const DIGEST_CHOICES: { value: PulseDigest; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
];

/** The email formats, in the order the choice lists them, each with its one line explanation. */
const EMAIL_FORMAT_CHOICES: {
  value: EmailFormat;
  label: string;
  detail: string;
}[] = [
  {
    value: 'digest',
    label: 'Digest',
    detail:
      'Holds emails for a few minutes and sends them together. Urgent issues are sent sooner.',
  },
  {
    value: 'immediate',
    label: 'Immediate',
    detail: 'Sends one email for every notification as it happens.',
  },
];

/** The column layout the header and every row share, with a Priority column while the split inbox is on. */
const columnsFor = (split: boolean): string =>
  split
    ? 'grid grid-cols-[minmax(0,1fr)_4rem_4rem_4rem_4rem] items-center gap-3 px-3'
    : 'grid grid-cols-[minmax(0,1fr)_4rem_4rem_4rem] items-center gap-3 px-3';

/** Renders the caller's notification preferences and saves each change. */
const NotificationsSettings: React.FC = () => {
  const { workspace } = useWorkspace();
  const { login } = useAuth();
  const auth = useQueryAuth();
  const [saved, setSaved] = useState<UserRead | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [linkSaved, setLinkSaved] = useState<SlackLinkRead | null>(null);
  const [discordSaved, setDiscordSaved] = useState<DiscordLinkRead | null>(
    null
  );
  const workspaceId = workspace?.id ?? '';

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => getCurrentUser(signal),
    { intervalMs: POLL_MS, queryKey: CURRENT_USER_KEY, auth }
  );

  const { data: linkData } = usePolledQuery(
    ({ signal }) => getSlackLink(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      queryKey: slackLinkKey(workspaceId),
      auth,
      enabled: workspaceId !== '',
    }
  );

  const { data: discordData } = usePolledQuery(
    ({ signal }) => getDiscordLink(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      queryKey: discordLinkKey(workspaceId),
      auth,
      enabled: workspaceId !== '',
    }
  );

  const user = saved ?? data;
  const slackLink = linkSaved ?? linkData ?? null;
  const discordLink = discordSaved ?? discordData ?? null;
  const delivers = (link: SlackLinkRead | DiscordLinkRead | null): boolean =>
    link !== null && link.linked && (link.problem ?? '') === '';
  const chatOn = delivers(slackLink) || delivers(discordLink);
  const emailOn = user?.email_notifications ?? true;
  const zoneId = useId();
  const digestId = useId();
  const formatName = useId();
  const emailFormat: EmailFormat = user?.email_format ?? 'digest';
  const digest: PulseDigest = user?.pulse_digest ?? 'off';
  const zone = user?.timezone ?? browserTimezone();
  const zones = useMemo(() => zoneChoices(zone), [zone]);
  const split = user?.priority_inbox ?? true;
  const priorityKinds: readonly InboxKind[] =
    user?.priority_kinds ?? DEFAULT_PRIORITY_KINDS;
  const COLUMNS = columnsFor(split);

  const save = (body: UserPreferencesUpdate): void => {
    setSaving(true);
    setSaveError(null);
    void updatePreferences(body)
      .then((stored) => {
        setSaved(stored);
        login(stored);
        invalidateQueries([
          CURRENT_USER_KEY,
          inboxCountKey(workspaceId),
          inboxCountsKey(workspaceId),
        ]);
      })
      .catch((failure: unknown) => {
        setSaveError(failure);
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const setPriority = (kind: NotificationKind, on: boolean): void => {
    const next = on
      ? [...priorityKinds.filter((one) => one !== kind), kind]
      : priorityKinds.filter((one) => one !== kind);
    save({ priority_kinds: next });
  };

  const channelsOf = (kind: NotificationKind): NotificationChannels =>
    user?.notification_preferences?.[kind] ?? INBOX_DEFAULT[kind] ?? ALL_ON;

  const onLinkChange = (stored: SlackLinkRead): void => {
    setLinkSaved(stored);
    invalidateQueries(slackLinkKey(workspaceId));
  };

  const onDiscordChange = (stored: DiscordLinkRead): void => {
    setDiscordSaved(stored);
    invalidateQueries(discordLinkKey(workspaceId));
  };

  const onDiscordReturn = useCallback((): void => {
    setDiscordSaved(null);
    invalidateQueries(discordLinkKey(workspaceId));
  }, [workspaceId]);

  return (
    <WorkspaceShell
      title="Settings"
      toolbar={
        workspace === null ? undefined : <SettingsNav workspace={workspace} />
      }
    >
      <ReturnToast
        param="discord_dm"
        describe={discordLinkOutcome}
        onOutcome={onDiscordReturn}
      />
      <div className="max-w-2xl space-y-6">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">Notifications</h2>
          <p className="text-sm text-text-muted">
            Choose what reaches your inbox, what also sends an email and what
            also arrives in chat. These settings are yours and apply in every
            workspace you belong to; your Slack and Discord links are for this
            workspace.
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

            <div className="rounded-md border border-line p-3">
              <Checkbox
                label="Use priority inbox"
                checked={split}
                disabled={saving}
                onChange={(event) => {
                  save({ priority_inbox: event.target.checked });
                }}
              />
              <p className="mt-1 pl-5.5 text-xs text-text-faint">
                Splits your inbox into Priority and Other tabs. The sidebar
                badge counts Priority only. Pick the Priority types in the
                column below.
              </p>
            </div>

            <div className="space-y-1 rounded-md border border-line p-3">
              <div className="flex items-center justify-between gap-3">
                <label
                  htmlFor={zoneId}
                  className="text-sm font-medium text-text"
                >
                  Timezone
                </label>
                <Select
                  id={zoneId}
                  className="w-64"
                  value={zone}
                  disabled={saving}
                  onChange={(event) => {
                    save({ timezone: event.target.value });
                  }}
                >
                  {zones.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </Select>
              </div>
              <p className="text-xs text-text-faint">
                Due date reminders arrive on your calendar day in this zone.
              </p>
            </div>

            <div className="space-y-1 rounded-md border border-line p-3">
              <div className="flex items-center justify-between gap-3">
                <label
                  htmlFor={digestId}
                  className="text-sm font-medium text-text"
                >
                  Pulse digest
                </label>
                <Select
                  id={digestId}
                  className="w-64"
                  value={digest}
                  disabled={saving || !emailOn}
                  onChange={(event) => {
                    const choice = DIGEST_CHOICES.find(
                      (option) => option.value === event.target.value
                    );
                    if (choice !== undefined) {
                      save({ pulse_digest: choice.value });
                    }
                  }}
                >
                  {DIGEST_CHOICES.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </Select>
              </div>
              <p className="text-xs text-text-faint">
                An email of the updates in your Pulse, at 8:00 in your timezone:
                every day, or on Mondays for the week. It is skipped when
                nothing is new.
              </p>
            </div>

            <fieldset
              className="space-y-2 rounded-md border border-line p-3"
              disabled={saving || !emailOn}
            >
              <legend className="sr-only">Notification format</legend>
              <div className="space-y-0.5">
                <p className="text-sm font-medium text-text">
                  Notification format
                </p>
                <p className="text-xs text-text-faint">
                  How the emails below arrive. Anything you read in your inbox
                  before its email goes out is left out of it.
                </p>
              </div>
              {EMAIL_FORMAT_CHOICES.map((choice) => (
                <label
                  key={choice.value}
                  className="flex cursor-pointer items-start gap-2"
                >
                  <input
                    type="radio"
                    name={formatName}
                    value={choice.value}
                    className="mt-0.5 h-3.5 w-3.5 border-line-strong"
                    checked={emailFormat === choice.value}
                    onChange={() => {
                      save({ email_format: choice.value });
                    }}
                  />
                  <span className="space-y-0.5">
                    <span className="block text-sm text-text">
                      {choice.label}
                    </span>
                    <span className="block text-xs text-text-faint">
                      {choice.detail}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>

            <DesktopNotificationsSettings />

            {slackLink !== null && slackLink.configured && (
              <SlackDirectMessages
                workspaceId={workspaceId}
                link={slackLink}
                onChange={onLinkChange}
              />
            )}

            {discordLink !== null && discordLink.configured && (
              <DiscordDirectMessages
                workspaceId={workspaceId}
                link={discordLink}
                onChange={onDiscordChange}
              />
            )}

            <div className="rounded-md border border-line">
              <div
                className={`${COLUMNS} h-8 border-b border-line bg-surface text-xs font-medium text-text-muted`}
              >
                <span>Notify me when</span>
                <span className="text-center">Inbox</span>
                <span className="text-center">Email</span>
                <span className="text-center">Chat</span>
                {split && <span className="text-center">Priority</span>}
              </div>
              {sectionsFor(NOTIFICATION_KINDS).map((section) => (
                <section
                  key={section.title}
                  aria-label={section.title}
                  className="[&:last-child_li:last-child]:border-b-0"
                >
                  <h3 className="border-b border-line bg-surface px-3 py-1.5 text-xs font-medium text-text-muted">
                    {section.title}
                  </h3>
                  <ul>
                    {section.kinds.map((kind) => {
                      const channels = channelsOf(kind);
                      const copy = KIND_COPY[kind];
                      return (
                        <li
                          key={kind}
                          className={`${COLUMNS} min-h-row border-b border-line py-2`}
                        >
                          <div className="min-w-0 space-y-0.5">
                            <p className="text-sm font-medium text-text">
                              {copy.title}
                            </p>
                            <p className="text-xs text-text-faint">
                              {copy.detail}
                            </p>
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
                              checked={
                                emailOn &&
                                channels.email &&
                                !IN_APP_ONLY.has(kind)
                              }
                              disabled={
                                saving || !emailOn || IN_APP_ONLY.has(kind)
                              }
                              onChange={(event) => {
                                save({
                                  notification_preferences: {
                                    [kind]: { email: event.target.checked },
                                  },
                                });
                              }}
                            />
                          </div>
                          <div className="flex justify-center">
                            <input
                              type="checkbox"
                              aria-label={`${copy.title} in chat`}
                              className="h-3.5 w-3.5 rounded-xs border-line-strong"
                              checked={
                                chatOn &&
                                channels.chat !== false &&
                                !NOT_IN_CHAT.has(kind)
                              }
                              disabled={
                                saving || !chatOn || NOT_IN_CHAT.has(kind)
                              }
                              onChange={(event) => {
                                save({
                                  notification_preferences: {
                                    [kind]: { chat: event.target.checked },
                                  },
                                });
                              }}
                            />
                          </div>
                          {split && (
                            <div className="flex justify-center">
                              <input
                                type="checkbox"
                                aria-label={`${copy.title} in Priority`}
                                className="h-3.5 w-3.5 rounded-xs border-line-strong"
                                checked={priorityKinds.includes(kind)}
                                disabled={saving}
                                onChange={(event) => {
                                  setPriority(kind, event.target.checked);
                                }}
                              />
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </WorkspaceShell>
  );
};

export default NotificationsSettings;
