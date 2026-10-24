/**
 * The card on the notification settings page that links the caller's own
 * Discord account, so the notifications they switch on for chat arrive as
 * direct messages from the Standupless App in Discord.
 *
 * Discord shows no one's email to a bot, so linking goes through Discord's own
 * consent screen, asking only for `identify`, and comes back to this page with
 * the outcome. A link Discord stopped accepting, such as one whose direct
 * messages were closed, stays listed with the reason so the caller can link
 * again.
 */

import React, { useState } from 'react';
import { getDiscordLinkUrl, unlinkDiscord } from '../../api/integrations';
import { ErrorAlert } from '../ui/alert';
import { Button } from '../ui/button';
import { errorMessage } from '../../lib/errors';
import type { DiscordLinkRead } from '../../types/Api';

/** What the card says for each reason a linked account stopped receiving messages. */
const PROBLEM_COPY: Record<string, string> = {
  discord_uninstalled:
    'The Discord App was removed from this workspace, so messages are paused.',
  discord_guild_changed:
    'The Discord App now lives in a different server. Link again to keep getting messages.',
  discord_50007:
    'Discord is not letting the App message you. Allow direct messages from server members, then link again.',
  discord_403:
    'Discord is not letting the App message you. Allow direct messages from server members, then link again.',
  discord_10013:
    'Discord no longer finds your account, so messages are paused.',
  discord_50033:
    'Discord no longer finds your account, so messages are paused.',
  discord_404: 'Discord no longer finds your account, so messages are paused.',
};

/** The sentence a problem code reads as, with a general one for codes not listed. */
const problemText = (code: string): string =>
  PROBLEM_COPY[code] ??
  'Discord stopped accepting messages. Link again to resume them.';

/** Props for DiscordDirectMessages. */
export interface DiscordDirectMessagesProps {
  workspaceId: string;
  link: DiscordLinkRead;
  /** Called with the stored link after an unlink, so the page can update its chat column. */
  onChange: (link: DiscordLinkRead) => void;
  /** Sends the browser to Discord's consent screen; the page passes the real navigation. */
  navigate?: (url: string) => void;
}

/** Leaves the app for Discord's consent screen. */
const assignLocation = (url: string): void => {
  window.location.assign(url);
};

/** Shows whether the caller's Discord account is linked here and links or unlinks it. */
const DiscordDirectMessages: React.FC<DiscordDirectMessagesProps> = ({
  workspaceId,
  link,
  onChange,
  navigate = assignLocation,
}) => {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  const connect = (): void => {
    setBusy(true);
    setFailure(null);
    void getDiscordLinkUrl(workspaceId)
      .then((started) => {
        navigate(started.url);
      })
      .catch((error: unknown) => {
        setFailure(error);
        setBusy(false);
      });
  };

  const disconnect = (): void => {
    setBusy(true);
    setFailure(null);
    void unlinkDiscord(workspaceId)
      .then(() => {
        onChange({
          ...link,
          linked: false,
          discord_user_id: null,
          linked_at: null,
          problem: null,
        });
      })
      .catch((error: unknown) => {
        setFailure(error);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const place = link.guild_name ?? 'Discord';
  const problem = link.linked ? (link.problem ?? '') : '';

  return (
    <div className="space-y-2 rounded-md border border-line p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium text-text">
            Discord direct messages
          </p>
          <p className="text-xs text-text-faint">
            {problem !== ''
              ? problemText(problem)
              : link.linked
                ? `Linked to your Discord account in ${place}. Notifications you tick under Chat arrive as messages from the Standupless App, a few at a time.`
                : link.available
                  ? `Get the notifications you tick under Chat as direct messages in ${place}. Discord asks you to confirm which account is yours.`
                  : 'A workspace admin connects Discord on Settings > Integrations before you can link your account.'}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {link.available && (!link.linked || problem !== '') && (
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={connect}
            >
              {link.linked ? 'Link again' : 'Link Discord'}
            </Button>
          )}
          {link.linked && (
            <Button size="sm" disabled={busy} onClick={disconnect}>
              Unlink
            </Button>
          )}
        </div>
      </div>
      {failure !== null && (
        <ErrorAlert
          message={errorMessage(failure, 'Could not change your Discord link.')}
        />
      )}
    </div>
  );
};

export default DiscordDirectMessages;
