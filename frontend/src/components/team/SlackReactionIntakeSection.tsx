/**
 * A team's Slack emoji reaction intake: react to a Slack message with the
 * team's emoji and it becomes an issue in the team.
 *
 * The issue lands in Triage when triage is on, carries the message and a link
 * back, and is paired with the message's thread, so the bot replies there with
 * the issue link and the thread's replies sync with the issue's comments. It is
 * created as the person who reacted when they are a member who can create issues
 * here, and otherwise as the admin who turned intake on. A channel set to every
 * message files each new top-level message without the emoji, and the bot
 * reacts with the emoji to acknowledge it.
 *
 * The section shows only where this environment has a Slack App. Anyone who can
 * read the team sees the setting; only a team admin changes it, because picking
 * channels reads the bot's channel list, which only a team admin may.
 */

import React, { useId, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
  type QueryKey,
} from '@webbpulse/api-client/react';
import {
  disableSlackIntake,
  getSlackIntake,
  listSlackChannels,
  saveSlackIntake,
} from '../../api/integrations';
import type { SlackChannelRead, SlackIntakeRead } from '../../types/Api';
import { errorMessage } from '../../lib/errors';
import { integrationsSettingsPath } from '../../lib/paths';
import { slackChannelsKey } from '../../lib/queryKeys';
import { showToast } from '../../lib/toast';
import { ErrorAlert } from '../ui/alert';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import Spinner from '../ui/spinner';

/** Props for SlackReactionIntakeSection: which team, and whether the caller may edit. */
export interface SlackReactionIntakeSectionProps {
  workspaceId: string;
  teamId: string;
  /** Whether the caller administers the team. */
  canEdit: boolean;
  /** The workspace's slug, for the link to its integrations page. */
  workspaceSlug?: string;
}

/** How often the setting and the channel list are re-read while the tab is open. */
const POLL_MS = 60000;

/** The emoji suggested before an admin picks one. */
const SUGGESTED_EMOJI = 'ticket';

/** The most channels one team listens in, matching the API. */
const MAX_CHANNELS = 20;

/** An emoji name the way Slack names it in a reaction: no colons, lowercase, no skin tone. */
export const normalizeEmoji = (value: string): string =>
  value
    .trim()
    .replace(/^:+|:+$/g, '')
    .trim()
    .toLowerCase()
    .replace(/::skin-tone-\d$/, '');

/** Whether a normalized emoji name is one Slack could send as a reaction. */
export const validEmoji = (name: string): boolean =>
  /^[a-z0-9_+\-']{1,100}$/.test(name);

/** The channel names a setting listens in, falling back to the id for one the bot no longer sees. */
const channelNames = (
  ids: string[],
  channels: SlackChannelRead[] | null
): string => {
  const byId = new Map((channels ?? []).map((row) => [row.id, row.name]));
  return ids.map((id) => `#${byId.get(id) ?? id}`).join(', ');
};

/** One change to the setting the section can make. */
type IntakeChange =
  | {
      action: 'save';
      emoji: string;
      channelIds: string[];
      messageChannelIds: string[];
    }
  | { action: 'disable' };

/** Props for the editor an admin turns intake on and changes it with. */
interface EditorProps {
  workspaceId: string;
  teamId: string;
  intake: SlackIntakeRead;
  saving: boolean;
  onSave: (
    emoji: string,
    channelIds: string[],
    messageChannelIds: string[]
  ) => void;
  onDisable: () => void;
}

/**
 * The emoji field, the channel checkboxes and the save and turn off buttons.
 * It is keyed on the stored setting, so a save starts it afresh from what was
 * stored while a poll that changed nothing leaves an edit in progress alone.
 */
const Editor: React.FC<EditorProps> = ({
  workspaceId,
  teamId,
  intake,
  saving,
  onSave,
  onDisable,
}) => {
  const auth = useQueryAuth();
  const emojiId = useId();
  const [emoji, setEmoji] = useState(intake.emoji ?? SUGGESTED_EMOJI);
  const [picked, setPicked] = useState<string[]>(intake.channel_ids);
  const [everyMessage, setEveryMessage] = useState<string[]>(
    intake.message_channel_ids
  );
  const {
    data: channels,
    error: channelsError,
    isLoading: channelsLoading,
  } = usePolledQuery(
    ({ signal }) => listSlackChannels(workspaceId, teamId, signal),
    {
      intervalMs: POLL_MS,
      queryKey: slackChannelsKey(workspaceId, teamId),
      auth,
    }
  );

  const name = normalizeEmoji(emoji);
  const emojiOk = validEmoji(name);
  const canSave =
    !saving && emojiOk && picked.length > 0 && picked.length <= MAX_CHANNELS;
  const listed = channels ?? [];
  const orphaned = picked.filter((id) => !listed.some((row) => row.id === id));

  const toggle = (id: string, on: boolean): void => {
    setPicked((current) =>
      on ? [...current, id] : current.filter((row) => row !== id)
    );
  };

  const setMode = (id: string, every: boolean): void => {
    setEveryMessage((current) =>
      every ? [...current, id] : current.filter((row) => row !== id)
    );
  };

  const modeFor = (id: string, label: string): React.ReactNode =>
    picked.includes(id) ? (
      <Select
        aria-label={`Mode for ${label}`}
        className="mt-1 ml-6 max-w-56"
        value={everyMessage.includes(id) ? 'message' : 'reaction'}
        disabled={saving}
        onChange={(event) => {
          setMode(id, event.target.value === 'message');
        }}
      >
        <option value="reaction">When reacted with the emoji</option>
        <option value="message">Every new message</option>
      </Select>
    ) : null;

  return (
    <div className="space-y-4 rounded-md border border-line p-3">
      <div className="space-y-1">
        <label htmlFor={emojiId} className="block text-sm font-medium">
          Emoji
        </label>
        <div className="flex items-center gap-2">
          <span className="text-sm text-text-muted" aria-hidden="true">
            :
          </span>
          <Input
            id={emojiId}
            value={emoji}
            maxLength={110}
            placeholder={SUGGESTED_EMOJI}
            aria-invalid={!emojiOk}
            className="max-w-60"
            onChange={(event) => {
              setEmoji(event.target.value);
            }}
          />
          <span className="text-sm text-text-muted" aria-hidden="true">
            :
          </span>
        </div>
        <p className="text-xs text-text-muted">
          {emojiOk
            ? `Reacting with :${name}: files the message here.`
            : 'Use a Slack emoji name such as ticket.'}
        </p>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Channels</legend>
        <p className="text-xs text-text-muted">
          Standupless joins the public channels you pick. Invite it to a private
          channel before picking it. Set a channel to every new message to file
          each top-level message there without the emoji.
        </p>
        {channelsError !== null && (
          <ErrorAlert
            message={errorMessage(
              channelsError,
              'Could not load the Slack channels.'
            )}
          />
        )}
        {channelsLoading && channels === null ? (
          <Spinner label="Loading the Slack channels" />
        ) : (
          <ul className="max-h-60 space-y-1 overflow-y-auto">
            {listed.map((row) => (
              <li key={row.id}>
                <Checkbox
                  label={`#${row.name}${row.is_private ? ' (private)' : ''}`}
                  checked={picked.includes(row.id)}
                  disabled={saving}
                  onChange={(event) => {
                    toggle(row.id, event.target.checked);
                  }}
                />
                {modeFor(row.id, `#${row.name}`)}
              </li>
            ))}
            {orphaned.map((id) => (
              <li key={id}>
                <Checkbox
                  label={`${id} (no longer visible to the bot)`}
                  checked
                  disabled={saving}
                  onChange={(event) => {
                    toggle(id, event.target.checked);
                  }}
                />
                {modeFor(id, id)}
              </li>
            ))}
            {listed.length === 0 && orphaned.length === 0 && (
              <li className="text-sm text-text-muted">
                The bot cannot see any channels yet.
              </li>
            )}
          </ul>
        )}
      </fieldset>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={!canSave}
          onClick={() => {
            onSave(
              name,
              picked,
              everyMessage.filter((id) => picked.includes(id))
            );
          }}
        >
          {intake.enabled ? 'Save' : 'Turn on'}
        </Button>
        {intake.enabled && (
          <Button
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={() => {
              onDisable();
            }}
          >
            Turn off
          </Button>
        )}
      </div>
    </div>
  );
};

/** Shows and edits a team's Slack emoji reaction intake. */
export const SlackReactionIntakeSection: React.FC<
  SlackReactionIntakeSectionProps
> = ({ workspaceId, teamId, canEdit, workspaceSlug }) => {
  const auth = useQueryAuth();
  const queryKey: QueryKey = ['slack-intake', workspaceId, teamId];

  const { data, error, isLoading, refetch } = usePolledQuery(
    ({ signal }) => getSlackIntake(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const {
    mutate: change,
    error: saveError,
    isMutating: saving,
  } = useMutationWithRefetch(
    async (next: IntakeChange) => {
      if (next.action === 'save') {
        await saveSlackIntake(workspaceId, teamId, {
          emoji: next.emoji,
          channel_ids: next.channelIds,
          message_channel_ids: next.messageChannelIds,
        });
      } else {
        await disableSlackIntake(workspaceId, teamId);
      }
    },
    [queryKey]
  );

  if (data !== null && !data.configured) return null;

  const run = async (next: IntakeChange, message: string): Promise<void> => {
    if (!canEdit) return;
    try {
      await change(next);
      await refetch();
      showToast(message);
    } catch {
      return;
    }
  };

  const manageHref =
    workspaceSlug === undefined
      ? undefined
      : integrationsSettingsPath(workspaceSlug);

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Create from Slack reactions</h3>
        <p className="text-sm text-text-muted">
          React to a Slack message with the team&apos;s emoji to file it as an
          issue here. The message becomes the description with a link back,
          issues land in Triage when it is on, and the bot replies in the thread
          with the issue link so the thread and its comments stay in step.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(
            error,
            'Could not load the Slack reaction settings.'
          )}
        />
      )}
      {saveError !== null && (
        <ErrorAlert
          message={errorMessage(
            saveError,
            'Could not change the Slack reaction settings.'
          )}
        />
      )}

      {isLoading && data === null ? (
        <Spinner label="Loading the Slack reaction settings" />
      ) : data === null ? null : !data.installed ? (
        <p className="text-sm text-text-muted">
          Connect Slack in{' '}
          {manageHref === undefined ? (
            'workspace settings'
          ) : (
            <a className="text-accent hover:underline" href={manageHref}>
              workspace settings
            </a>
          )}{' '}
          to file messages by emoji.
        </p>
      ) : (
        <>
          {data.reinstall && (
            <p className="text-sm text-text-muted">
              Slack was connected before reactions could be read. Reconnect
              Slack in workspace settings so reactions file issues.
            </p>
          )}
          {canEdit ? (
            <Editor
              key={`${String(data.enabled)}:${data.updated_at ?? ''}`}
              workspaceId={workspaceId}
              teamId={teamId}
              intake={data}
              saving={saving}
              onSave={(emoji, channelIds, messageChannelIds) => {
                void run(
                  { action: 'save', emoji, channelIds, messageChannelIds },
                  data.enabled
                    ? 'Slack reaction settings saved.'
                    : 'Create from Slack reactions turned on.'
                );
              }}
              onDisable={() => {
                void run(
                  { action: 'disable' },
                  'Create from Slack reactions turned off.'
                );
              }}
            />
          ) : (
            <p className="text-sm text-text-muted">
              {data.enabled && data.emoji !== null
                ? `Reacting with :${data.emoji}: in ${channelNames(data.channel_ids, null)} files the message here.${data.message_channel_ids.length > 0 ? ` Every new message in ${channelNames(data.message_channel_ids, null)} is filed too.` : ''} Only a team admin can change this.`
                : 'Off. Only a team admin can turn this on.'}
            </p>
          )}
        </>
      )}
    </section>
  );
};

export default SlackReactionIntakeSection;
