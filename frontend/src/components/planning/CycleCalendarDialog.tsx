/**
 * The dialog behind "Subscribe to cycle calendar": a private feed URL a
 * calendar app subscribes to, so a team's cycles show up as all-day events.
 *
 * The URL carries a secret and comes back only on the answer that minted it,
 * so it is held in state while the dialog is open and never read again. A
 * person who already has a feed sees that it is active and can make a new
 * URL, which stops the old one working, or turn the feed off.
 */

import React, { useEffect, useState } from 'react';
import { LuCalendarPlus, LuCheck, LuCopy } from 'react-icons/lu';
import {
  createCycleCalendarFeed,
  getCycleCalendarFeed,
  revokeCycleCalendarFeed,
} from '../../api/planning';
import { errorMessage } from '../../lib/errors';
import type { CycleCalendarFeedRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import Field from '../ui/field';
import Spinner from '../ui/spinner';

/** Props for CycleCalendarDialog: the team whose cycles the feed carries. */
export interface CycleCalendarDialogProps {
  workspaceId: string;
  teamId: string;
  teamName: string;
  onClose: () => void;
}

/** Copies text to the clipboard, answering whether it took. */
const copyText = async (text: string): Promise<boolean> => {
  try {
    await globalThis.navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

/** The `webcal:` form of a feed URL, which calendar apps open as a subscription. */
const webcalUrl = (url: string): string => url.replace(/^https?:/, 'webcal:');

/** The subscribe dialog: mint, copy, regenerate and turn off a cycle feed. */
export const CycleCalendarDialog: React.FC<CycleCalendarDialogProps> = ({
  workspaceId,
  teamId,
  teamName,
  onClose,
}) => {
  const [feed, setFeed] = useState<CycleCalendarFeedRead | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    let live = true;
    getCycleCalendarFeed(workspaceId, teamId)
      .then((read) => {
        if (live) setFeed(read);
      })
      .catch((failure: unknown) => {
        if (live) setError(failure);
      });
    return () => {
      live = false;
    };
  }, [workspaceId, teamId]);

  const onMint = (): void => {
    if (isBusy) return;
    setIsBusy(true);
    setError(null);
    setCopied(false);
    createCycleCalendarFeed(workspaceId, teamId)
      .then((read) => {
        setFeed(read);
        setUrl(read.url ?? null);
      })
      .catch((failure: unknown) => {
        setError(failure);
      })
      .finally(() => {
        setIsBusy(false);
      });
  };

  const onRevoke = (): void => {
    if (isBusy) return;
    setIsBusy(true);
    setError(null);
    revokeCycleCalendarFeed(workspaceId, teamId)
      .then(() => {
        setFeed({ team_id: teamId, active: false, created_at: null });
        setUrl(null);
        setCopied(false);
      })
      .catch((failure: unknown) => {
        setError(failure);
      })
      .finally(() => {
        setIsBusy(false);
      });
  };

  const onCopy = (): void => {
    if (url === null) return;
    void copyText(url).then(setCopied);
  };

  return (
    <Dialog
      open
      title="Subscribe to cycle calendar"
      description={`Show ${teamName} cycles in your calendar app as all-day events.`}
      onClose={onClose}
    >
      <div className="space-y-4">
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load the calendar feed.')}
          />
        )}
        {feed === null && error === null ? (
          <Spinner label="Loading calendar feed" />
        ) : url !== null ? (
          <div className="space-y-3">
            <div className="flex items-end gap-2">
              <Field
                id="cycle-calendar-url"
                label="Calendar URL"
                className="min-w-0 flex-1"
                value={url}
                readOnly
                onFocus={(event) => {
                  event.currentTarget.select();
                }}
              />
              <Button variant="secondary" onClick={onCopy}>
                {copied ? (
                  <LuCheck aria-hidden="true" className="h-3.5 w-3.5" />
                ) : (
                  <LuCopy aria-hidden="true" className="h-3.5 w-3.5" />
                )}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="text-xs text-text-muted">
              This URL is shown once. Anyone with it can see this team&apos;s
              cycle names, dates and goals, so keep it private.
            </p>
            <a
              href={webcalUrl(url)}
              className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline"
            >
              <LuCalendarPlus aria-hidden="true" className="h-3.5 w-3.5" />
              Open in calendar app
            </a>
          </div>
        ) : feed?.active === true ? (
          <p className="text-sm text-text-muted">
            You have an active calendar feed for this team. Its URL was shown
            when it was made. Make a new URL to copy it again; the old one stops
            working.
          </p>
        ) : (
          <p className="text-sm text-text-muted">
            Make a private URL that your calendar app checks for this
            team&apos;s cycles. It includes the last three completed cycles, the
            current one and every upcoming one.
          </p>
        )}

        <div className="space-y-1 rounded-md border border-line p-3 text-xs text-text-muted">
          <p className="font-medium text-text">How to subscribe</p>
          <p>
            Google Calendar: Other calendars, then From URL, and paste the URL.
          </p>
          <p>Apple Calendar: File, then New Calendar Subscription.</p>
          <p>Outlook: Add calendar, then Subscribe from web.</p>
          <p>Calendar apps refresh subscriptions on their own schedule.</p>
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          {feed?.active === true && (
            <Button variant="secondary" disabled={isBusy} onClick={onRevoke}>
              Turn off feed
            </Button>
          )}
          {feed !== null && (
            <Button variant="primary" disabled={isBusy} onClick={onMint}>
              {feed.active ? 'Make a new URL' : 'Create calendar URL'}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
};

export default CycleCalendarDialog;
