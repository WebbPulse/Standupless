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
import { createShareLink } from '../../api/access';
import { errorMessage } from '../../lib/errors';
import type { ShareTargetType } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';

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

  return (
    <div className="space-y-3">
      <Button variant="secondary" disabled={isMinting} onClick={onShare}>
        {isMinting ? 'Creating link' : 'Share'}
      </Button>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not create a share link.')}
        />
      )}

      {url !== null && (
        <div
          role="status"
          className="space-y-3 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3"
        >
          <p className="text-sm text-emerald-100">
            Anyone with this link can read it without signing in. It is shown
            once, so copy it now. You can revoke it later from settings.
          </p>
          <code className="block overflow-x-auto rounded border border-emerald-500/30 bg-slate-900 px-2 py-1 text-xs text-emerald-200">
            {url}
          </code>
          <div className="flex gap-2">
            <Button onClick={onCopy}>{copied ? 'Copied' : 'Copy link'}</Button>
            <Button
              variant="secondary"
              onClick={() => {
                setUrl(null);
              }}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ShareButton;
