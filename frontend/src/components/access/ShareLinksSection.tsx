/**
 * The share links of one workspace: what is published, and the revoke.
 *
 * There is no create here on purpose. A link is minted from the thing it points
 * at, where the person can see what they are about to publish; a settings page
 * that minted one would be asking somebody to pick a target id out of a list.
 * What settings is for is the opposite question, which is what is currently
 * readable without a session, and the answer to that is a list and a revoke.
 *
 * The rows carry `token_hash` rather than the token, and `url` with no token in
 * it, because a list that held live tokens would itself be a credential.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import { listShareLinks, revokeShareLink } from '../../api/access';
import {
  dateLabel,
  isLinkLive,
  targetTypeLabel,
} from '../../lib/accessDisplay';
import { errorMessage } from '../../lib/errors';
import { shareLinksKey } from '../../lib/queryKeys';
import type { ShareTargetType, WorkspaceRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Badge from '../ui/badge';
import Button from '../ui/button';
import Spinner from '../ui/spinner';
import { SelectField } from '../ui/select';

/** Props for ShareLinksSection: the workspace whose links are shown. */
export interface ShareLinksSectionProps {
  workspace: WorkspaceRead;
}

/** How often the link list is re-read while the page is open. */
const POLL_MS = 60000;

/** The column layout the header and every row share. */
const COLUMNS =
  'grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3 px-3';

/** The target filter, with the empty string standing for no filter at all. */
type TargetFilter = ShareTargetType | '';

/** Lists the workspace's share links and revokes them. */
export const ShareLinksSection: React.FC<ShareLinksSectionProps> = ({
  workspace,
}) => {
  const auth = useQueryAuth();
  const [targetType, setTargetType] = useState<TargetFilter>('');

  const queryKey = shareLinksKey(workspace.id, targetType, '');

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) =>
      listShareLinks(
        workspace.id,
        targetType === '' ? {} : { target_type: targetType },
        signal
      ),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const { mutate: revoke, error: revokeError } = useMutationWithRefetch(
    (tokenHash: string) => revokeShareLink(workspace.id, tokenHash),
    queryKey
  );

  const links = data ?? [];

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">Share links</h2>
          <p className="text-sm text-text-muted">
            Anyone holding one of these links can read the issue, view or
            filtered list it points at, without signing in. Revoking a link
            stops it at once. Links are created from the Share button on an
            issue or a list, not from here.
          </p>
        </div>
        <SelectField
          id="share-links-target"
          label="Show"
          hideLabel
          className="w-36"
          value={targetType}
          onChange={(event) => {
            setTargetType(event.target.value as TargetFilter);
          }}
        >
          <option value="">Everything</option>
          <option value="issue">Issues</option>
          <option value="view">Views</option>
          <option value="filter">Filters</option>
        </SelectField>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the share links.')}
        />
      )}
      {revokeError !== null && (
        <ErrorAlert
          message={errorMessage(revokeError, 'Could not revoke that link.')}
        />
      )}

      {isLoading ? (
        <Spinner label="Loading share links" />
      ) : links.length === 0 ? (
        <p className="text-sm text-text-muted">
          Nothing in this workspace is shared publicly.
        </p>
      ) : (
        <div className="rounded-md border border-line">
          <div
            className={`${COLUMNS} h-8 border-b border-line bg-surface text-xs font-medium text-text-muted`}
          >
            <span>Link</span>
            <span>Target</span>
            <span>Status</span>
            <span className="sr-only">Actions</span>
          </div>
          <ul>
            {links.map((item) => {
              const revoked = (item.revoked_at ?? null) !== null;
              const live = !revoked && isLinkLive(item.expires_at);
              return (
                <li
                  key={item.token_hash}
                  className={`${COLUMNS} min-h-row border-b border-line py-1.5 transition-colors duration-100 last:border-b-0 hover:bg-surface`}
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium text-text">
                        {item.title}
                      </span>
                    </div>
                    <p className="text-xs text-text-faint">
                      Created {dateLabel(item.created_at)}, expires{' '}
                      {item.expires_at === null
                        ? 'never'
                        : dateLabel(item.expires_at)}
                    </p>
                  </div>
                  <span className="w-10 text-xs text-text-muted">
                    {targetTypeLabel(item.target_type)}
                  </span>
                  <Badge tone={live ? 'success' : 'warning'}>
                    {live ? 'Active' : revoked ? 'Revoked' : 'Expired'}
                  </Badge>
                  <div className="flex justify-end">
                    <Button
                      disabled={revoked}
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void revoke(item.token_hash).catch(() => undefined);
                      }}
                    >
                      Revoke
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
};

export default ShareLinksSection;
