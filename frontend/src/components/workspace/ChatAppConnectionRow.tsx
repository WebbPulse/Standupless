/**
 * One chat App's connection to the workspace, Slack or Discord: whether it is
 * installed, the Slack workspace or Discord server it joined, and who added it
 * and when.
 *
 * On the workspace integrations page a workspace admin connects it from here,
 * which sends them to the service and back to the same page, or disconnects it
 * behind a confirm. A team's settings show the same row read only, with a link
 * to that page, since the install belongs to the whole workspace.
 */

import React, { useState } from 'react';
import { errorMessage } from '../../lib/errors';
import { fullTimestamp } from '../../lib/relativeTime';
import { ErrorAlert } from '../ui/alert';
import Badge from '../ui/badge';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import TextLink from '../ui/link';
import RelativeTime from '../ui/relative-time';

/** What a workspace admin can do to the connection on the integrations page. */
export interface ChatAppActions {
  /** Answers the address to send the admin to for the install. */
  installUrl: () => Promise<{ url: string }>;
  /** Removes the App from the workspace. */
  disconnect: () => Promise<void>;
  /** Re-reads the connection and the channels once the App is removed. */
  onDisconnected: () => void;
}

/** Props for ChatAppConnectionRow. */
export interface ChatAppConnectionRowProps {
  /** The service's name, as in "Connect Slack". */
  service: string;
  installed: boolean;
  /** The Slack workspace or Discord server the App joined. */
  placeName: string | null;
  /** Who added the App, by name, when the reader may see members. */
  installedBy?: string | null;
  installedAt?: string | null;
  /** What the App does once connected. */
  summary: string;
  /** What the disconnect confirm warns of. */
  warning: string;
  /** The admin's connect and disconnect, absent for the read only row. */
  actions?: ChatAppActions;
  /** Where the read only row sends people to manage the connection. */
  manageHref?: string;
  /** Whether the reader may open the page manageHref points at. */
  canManage?: boolean;
}

/** The second line of the row: where the App is connected, by whom and when. */
const ConnectedLine: React.FC<{
  placeName: string | null;
  installedBy?: string | null;
  installedAt?: string | null;
}> = ({ placeName, installedBy, installedAt }) => (
  <p className="flex flex-wrap items-center gap-x-1 text-xs text-text-muted">
    <span>
      Connected to{' '}
      <span className="font-medium text-text">
        {placeName ?? 'an unnamed workspace'}
      </span>
    </span>
    {installedBy !== undefined && installedBy !== null && (
      <span>by {installedBy}</span>
    )}
    {installedAt !== undefined && installedAt !== null && (
      <span title={fullTimestamp(installedAt)}>
        <RelativeTime value={installedAt} />
      </span>
    )}
  </p>
);

/** Whether the workspace installed a chat App, with the admin's connect or disconnect. */
export const ChatAppConnectionRow: React.FC<ChatAppConnectionRowProps> = ({
  service,
  installed,
  placeName,
  installedBy,
  installedAt,
  summary,
  warning,
  actions,
  manageHref,
  canManage = false,
}) => {
  const [opening, setOpening] = useState(false);
  const [installError, setInstallError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<unknown>(null);

  const onInstall = (): void => {
    if (actions === undefined) return;
    setOpening(true);
    setInstallError(null);
    void actions
      .installUrl()
      .then((result) => {
        globalThis.location.assign(result.url);
      })
      .catch((reason: unknown) => {
        setInstallError(reason);
        setOpening(false);
      });
  };

  const onDisconnect = (): void => {
    if (actions === undefined) return;
    setDisconnecting(true);
    setDisconnectError(null);
    void actions
      .disconnect()
      .then(() => {
        setConfirming(false);
        actions.onDisconnected();
      })
      .catch((reason: unknown) => {
        setDisconnectError(reason);
      })
      .finally(() => {
        setDisconnecting(false);
      });
  };

  return (
    <div className="space-y-2">
      {installError !== null && (
        <ErrorAlert
          message={errorMessage(installError, `Could not open ${service}.`)}
        />
      )}
      <div className="flex min-h-row items-center gap-3 rounded-md border border-line px-3 py-2">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-sm font-medium text-text">{service}</span>
            {installed ? (
              <Badge tone="success">Connected</Badge>
            ) : (
              <Badge tone="neutral">Not connected</Badge>
            )}
          </div>
          {installed ? (
            <ConnectedLine
              placeName={placeName}
              installedBy={installedBy}
              installedAt={installedAt}
            />
          ) : null}
          <p className="text-xs text-text-faint">{summary}</p>
          {actions === undefined && manageHref !== undefined && (
            <p className="text-xs text-text-muted">
              {canManage ? (
                <TextLink to={manageHref}>
                  {installed
                    ? 'Manage in workspace settings'
                    : `Connect ${service} in workspace settings`}
                </TextLink>
              ) : installed ? (
                'A workspace admin manages this connection.'
              ) : (
                `A workspace admin can connect ${service} in workspace settings.`
              )}
            </p>
          )}
        </div>
        {actions !== undefined &&
          (installed ? (
            <Button
              size="sm"
              onClick={() => {
                setDisconnectError(null);
                setConfirming(true);
              }}
            >
              Disconnect
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              disabled={opening}
              onClick={onInstall}
            >
              {opening ? `Opening ${service}` : `Connect ${service}`}
            </Button>
          ))}
      </div>

      {actions !== undefined && (
        <Dialog
          open={confirming}
          onClose={() => {
            if (!disconnecting) setConfirming(false);
          }}
          title={`Disconnect ${service}?`}
          size="sm"
        >
          <div className="space-y-4">
            <p className="text-sm text-text-muted">{warning}</p>
            {disconnectError !== null && (
              <ErrorAlert
                message={errorMessage(
                  disconnectError,
                  `Could not disconnect ${service}.`
                )}
              />
            )}
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => {
                  setConfirming(false);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={disconnecting}
                onClick={onDisconnect}
              >
                {disconnecting ? 'Disconnecting' : `Disconnect ${service}`}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
};

export default ChatAppConnectionRow;
