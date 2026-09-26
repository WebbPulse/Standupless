/**
 * The share popover beside the thing being looked at: publish, copy, revoke.
 *
 * It lives beside the target rather than in settings, because minting a link is
 * an act of publication and the person doing it should be looking at what they
 * are about to publish. The token comes back on the create response and on no
 * other, so the fresh URL is copied straight away and held in state until the
 * popover closes; afterwards the live links are listed without their tokens and
 * can only be revoked.
 *
 * A `filter` share publishes an unsaved team filter. The filter and sort travel
 * on the create body and are snapshotted onto the link, so what the link shows
 * is what was on screen when it was made.
 *
 * Creating a link is gated on being able to write in the target's team. The
 * server decides that too, and a refusal is surfaced rather than guessed at.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  invalidateQueries,
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import { LuCheck, LuCopy, LuGlobe, LuLink, LuShare2 } from 'react-icons/lu';
import { Link, useParams } from 'react-router-dom';
import {
  createShareLink,
  listShareLinks,
  revokeShareLink,
} from '../../api/access';
import { dateLabel, isLinkLive } from '../../lib/accessDisplay';
import { errorMessage } from '../../lib/errors';
import { shareLinksSettingsPath } from '../../lib/paths';
import { shareLinksKey } from '../../lib/queryKeys';
import type { SavedViewFilter } from '../../api/views';
import type {
  ShareLinkCreate,
  ShareLinkRead,
  ShareTargetType,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import { Popover } from '../ui/popover';

/** What a filter share snapshots onto its link. */
export interface ShareSnapshot {
  filter: SavedViewFilter;
  sort?: string;
  title?: string;
}

/** Props for ShareButton: which workspace, and what is being shared. */
export interface ShareButtonProps {
  workspaceId: string;
  targetType: ShareTargetType;
  targetId: string;
  /** The filter a `filter` share publishes. Ignored for every other kind. */
  snapshot?: ShareSnapshot | undefined;
}

/** How often the live links are re-read while the popover is open. */
const POLL_MS = 60000;

/** What one kind of target is called in the popover's copy. */
const NOUN: Record<ShareTargetType, string> = {
  issue: 'issue',
  view: 'view',
  filter: 'filtered list',
};

/** Whether a listed link can still be opened. */
const isOpen = (link: ShareLinkRead): boolean =>
  (link.revoked_at ?? null) === null && isLinkLive(link.expires_at);

/** The create body for one target, carrying the snapshot for a filter. */
const createBody = (
  targetType: ShareTargetType,
  targetId: string,
  snapshot: ShareSnapshot | undefined
): ShareLinkCreate => {
  if (targetType !== 'filter' || snapshot === undefined) {
    return { target_type: targetType, target_id: targetId };
  }
  return {
    target_type: targetType,
    target_id: targetId,
    filter: { ...snapshot.filter },
    ...(snapshot.sort === undefined ? {} : { sort: snapshot.sort }),
    ...(snapshot.title === undefined ? {} : { title: snapshot.title }),
  };
};

/** Copies text to the clipboard, answering whether it took. */
const copyText = async (text: string): Promise<boolean> => {
  try {
    await globalThis.navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

/** A trigger and the popover that publishes, copies and revokes links. */
export const ShareButton: React.FC<ShareButtonProps> = ({
  workspaceId,
  targetType,
  targetId,
  snapshot,
}) => {
  const auth = useQueryAuth();
  const { slug } = useParams<{ slug: string }>();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [isMinting, setIsMinting] = useState(false);

  const queryKey = shareLinksKey(workspaceId, targetType, targetId);
  const { data } = usePolledQuery(
    ({ signal }) =>
      listShareLinks(
        workspaceId,
        { target_type: targetType, target_id: targetId },
        signal
      ),
    {
      intervalMs: POLL_MS,
      queryKey,
      auth,
      enabled: open && workspaceId !== '' && targetId !== '',
    }
  );
  const { mutate: revoke, error: revokeError } = useMutationWithRefetch(
    (tokenHash: string) => revokeShareLink(workspaceId, tokenHash),
    queryKey
  );

  const live = (data ?? []).filter(isOpen);
  const noun = NOUN[targetType];

  const onOpenChange = (next: boolean): void => {
    setOpen(next);
    if (!next) {
      setUrl(null);
      setCopied(false);
      setError(null);
    }
  };

  const onCreate = (): void => {
    if (isMinting) return;
    setIsMinting(true);
    setError(null);
    createShareLink(workspaceId, createBody(targetType, targetId, snapshot))
      .then(async (link) => {
        setUrl(link.url);
        setCopied(await copyText(link.url));
        invalidateQueries(queryKey);
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
    void copyText(url).then(setCopied);
  };

  return (
    <Popover
      label="Share"
      align="end"
      open={open}
      onOpenChange={onOpenChange}
      contentClassName="w-80"
      trigger={(props) => (
        <Button {...props} variant="secondary" size="sm">
          <LuShare2 aria-hidden="true" className="h-3.5 w-3.5" />
          Share
        </Button>
      )}
    >
      <div className="space-y-3 p-3">
        <div className="flex items-start gap-2.5">
          <LuGlobe
            aria-hidden="true"
            className="mt-0.5 h-4 w-4 shrink-0 text-text-muted"
          />
          <div className="space-y-0.5">
            <h2 className="text-sm font-medium text-text">Share publicly</h2>
            <p className="text-xs text-text-muted">
              Anyone with the link can read this {noun} without signing in.
              Nothing else in the workspace is visible to them.
            </p>
          </div>
        </div>

        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not create a share link.')}
          />
        )}
        {revokeError !== null && (
          <ErrorAlert
            message={errorMessage(revokeError, 'Could not revoke that link.')}
          />
        )}

        {url === null ? (
          <Button
            variant="primary"
            size="sm"
            className="w-full justify-center"
            disabled={isMinting}
            onClick={onCreate}
          >
            <LuLink aria-hidden="true" className="h-3.5 w-3.5" />
            {isMinting ? 'Creating link' : 'Create public link'}
          </Button>
        ) : (
          <div role="status" className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <input
                readOnly
                aria-label="Share link"
                value={url}
                onFocus={(event) => {
                  event.currentTarget.select();
                }}
                className="h-7 min-w-0 flex-1 rounded-sm border border-line bg-surface px-2 font-mono text-xs text-text"
              />
              <Button variant="secondary" size="sm" onClick={onCopy}>
                {copied ? (
                  <LuCheck aria-hidden="true" className="h-3.5 w-3.5" />
                ) : (
                  <LuCopy aria-hidden="true" className="h-3.5 w-3.5" />
                )}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="text-xs text-text-faint">
              This link is shown once. Copy it now; you can revoke it here or
              from settings.
            </p>
          </div>
        )}
      </div>

      {live.length > 0 && (
        <div className="border-t border-line px-3 py-2">
          <p className="pb-1 text-xs font-medium text-text-muted">Live links</p>
          <ul className="space-y-0.5">
            {live.map((link) => (
              <li
                key={link.token_hash}
                className="flex items-center justify-between gap-2 text-xs"
              >
                <span className="min-w-0 truncate text-text-muted">
                  {link.title}, created {dateLabel(link.created_at)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Revoke link created ${dateLabel(link.created_at)}`}
                  onClick={() => {
                    void revoke(link.token_hash).catch(() => undefined);
                  }}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {slug !== undefined && (
        <div className="border-t border-line px-3 py-2">
          <Link
            to={shareLinksSettingsPath(slug)}
            className="text-xs text-text-muted hover:text-text"
          >
            Manage all share links
          </Link>
        </div>
      )}
    </Popover>
  );
};

export default ShareButton;
