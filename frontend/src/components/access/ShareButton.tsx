/**
 * The small affordance that mints a share link from the thing being looked at.
 *
 * It lives beside the target rather than in settings, because minting a link is
 * an act of publication and the person doing it should be looking at what they
 * are about to publish. The token comes back on this one response and on no
 * other, so the URL it carries is held in state and shown until dismissed; the
 * settings list will show the link afterwards but never the token again.
 *
 * Creating a link is gated on being able to write in the target's project. The
 * server decides that too, and a refusal is surfaced rather than guessed at.
 */

import React, { useState } from 'react';
import { LuCheck, LuCopy, LuShare2 } from 'react-icons/lu';
import { createShareLink } from '../../api/access';
import { errorMessage } from '../../lib/errors';
import type { ShareTargetType } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Dialog from '../ui/dialog';

/** Props for ShareButton: which workspace, and what is being shared. */
export interface ShareButtonProps {
  workspaceId: string;
  targetType: ShareTargetType;
  targetId: string;
}

/** Mints a share link and shows the one URL that carries its token. */
export const ShareButton: React.FC<ShareButtonProps> = ({
  workspaceId,
  targetType,
  targetId,
}) => {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [isMinting, setIsMinting] = useState(false);
  const [copied, setCopied] = useState(false);

  const onShare = (): void => {
    if (isMinting) return;
    setIsMinting(true);
    setError(null);
    createShareLink(workspaceId, {
      target_type: targetType,
      target_id: targetId,
    })
      .then((link) => {
        setUrl(link.url);
        setCopied(false);
      })
      .catch((failure: unknown) => {
        setError(failure);
      })
      .finally(() => {
        setIsMinting(false);
      });
  };

  const onCopy = (): void => {
    if (url === null) return;
    void globalThis.navigator.clipboard
      ?.writeText(url)
      .then(() => {
        setCopied(true);
      })
      .catch(() => undefined);
  };

  const onClose = (): void => {
    setUrl(null);
    setError(null);
  };

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        disabled={isMinting}
        onClick={onShare}
      >
        <LuShare2 aria-hidden="true" className="h-3.5 w-3.5" />
        {isMinting ? 'Creating link' : 'Share'}
      </Button>

      <Dialog
        open={url !== null || error !== null}
        onClose={onClose}
        title="Share link"
        size="sm"
      >
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not create a share link.')}
          />
        )}

        {url !== null && (
          <div role="status" className="space-y-3">
            <p className="text-sm text-text-muted">
              Anyone with this link can read it without signing in. It is shown
              once, so copy it now. You can revoke it later from settings.
            </p>
            <code className="block overflow-x-auto rounded-sm border border-line bg-surface px-2.5 py-1.5 font-mono text-xs text-text">
              {url}
            </code>
            <div className="flex gap-2">
              <Button variant="primary" onClick={onCopy}>
                {copied ? (
                  <LuCheck aria-hidden="true" className="h-3.5 w-3.5" />
                ) : (
                  <LuCopy aria-hidden="true" className="h-3.5 w-3.5" />
                )}
                {copied ? 'Copied' : 'Copy link'}
              </Button>
              <Button variant="ghost" onClick={onClose}>
                Dismiss
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
};

export default ShareButton;
