/**
 * The card on the notification settings page that links the caller's own
 * Slack account, so the notifications they switch on for Slack arrive as
 * direct messages from the Standupless App.
 *
 * Linking needs no Slack sign in: the backend finds the Slack account that
 * holds the caller's confirmed email in the Slack workspace this workspace
 * installed, the same rule the slash command uses. A link Slack stopped
 * accepting stays listed with the reason, so the caller can link again.
 */

import React, { useState } from 'react';
import { linkSlack, unlinkSlack } from '../../api/integrations';
import { ErrorAlert } from '../ui/alert';
import { Button } from '../ui/button';
import { errorMessage } from '../../lib/errors';
import type { SlackLinkRead } from '../../types/Api';

/** What the card says for each reason a linked account stopped receiving messages. */
const PROBLEM_COPY: Record<string, string> = {
  slack_uninstalled:
    'The Slack App was removed from this workspace, so messages are paused.',
  slack_team_changed:
    'The Slack App now lives in a different Slack workspace. Link again to keep getting messages.',
  messages_tab_disabled:
    'Slack is not accepting messages from the App. Link again once the App has its Messages tab.',
  account_inactive:
    'Your Slack account is deactivated, so messages are paused.',
  user_not_found: 'Slack no longer finds your account, so messages are paused.',
};

/** The sentence a problem code reads as, with a general one for codes not listed. */
const problemText = (code: string): string =>
  PROBLEM_COPY[code] ??
  'Slack stopped accepting messages. Link again to resume them.';

/** Props for SlackDirectMessages. */
export interface SlackDirectMessagesProps {
  workspaceId: string;
  link: SlackLinkRead;
  /** Called with the stored link after a link or unlink, so the page can update its Slack column. */
  onChange: (link: SlackLinkRead) => void;
}

/** Shows whether the caller's Slack account is linked here and links or unlinks it. */
const SlackDirectMessages: React.FC<SlackDirectMessagesProps> = ({
  workspaceId,
  link,
  onChange,
}) => {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  const run = (action: () => Promise<SlackLinkRead>): void => {
    setBusy(true);
    setFailure(null);
    void action()
      .then(onChange)
      .catch((error: unknown) => {
        setFailure(error);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const connect = (): void => {
    run(() => linkSlack(workspaceId));
  };

  const disconnect = (): void => {
    run(async () => {
      await unlinkSlack(workspaceId);
      return {
        ...link,
        linked: false,
        slack_user_id: null,
        linked_at: null,
        problem: null,
      };
    });
  };

  const place = link.slack_team_name ?? 'Slack';
  const problem = link.linked ? (link.problem ?? '') : '';

  return (
    <div className="space-y-2 rounded-md border border-line p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium text-text">Slack direct messages</p>
          <p className="text-xs text-text-faint">
            {problem !== ''
              ? problemText(problem)
              : link.linked
                ? `Linked to your account in ${place}. Notifications you tick under Slack arrive as messages from the Standupless App, a few at a time.`
                : link.available
                  ? `Get the notifications you tick under Slack as direct messages in ${place}. Your Slack account is found by your confirmed email address.`
                  : 'A workspace admin connects Slack on Settings > Integrations before you can link your account.'}
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
              {link.linked ? 'Link again' : 'Link Slack'}
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
          message={errorMessage(failure, 'Could not change your Slack link.')}
        />
      )}
    </div>
  );
};

export default SlackDirectMessages;
