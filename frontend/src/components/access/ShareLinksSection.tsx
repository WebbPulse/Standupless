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
import Button from '../ui/button';
import Spinner from '../ui/spinner';
import { SelectField } from '../ui/select';

/** Props for ShareLinksSection: the workspace whose links are shown. */
export interface ShareLinksSectionProps {
  workspace: WorkspaceRead;
}

/** How often the link list is re-read while the page is open. */
const POLL_MS = 60000;

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
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-lg font-medium text-white">Share links</h2>
        <SelectField
          id="share-links-target"
          label="Show"
          className="w-48"
          value={targetType}
          onChange={(event) => {
            setTargetType(event.target.value as TargetFilter);
          }}
        >
          <option value="">Everything</option>
          <option value="issue">Issues</option>
          <option value="view">Views</option>
        </SelectField>
      </div>
      <p className="text-sm text-slate-400">
        Anyone holding one of these links can read the one issue or view it
        points at, without signing in. Revoking a link stops it at once. Links
        are created from an issue or a view, not from here.
      </p>

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
        <p className="text-sm text-slate-400">
          Nothing in this workspace is shared publicly.
        </p>
      ) : (
        <ul className="space-y-2">
          {links.map((item) => (
            <li
              key={item.token_hash}
              className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-slate-700 px-3 py-2"
            >
              <div className="min-w-0 space-y-1">
                <p className="truncate text-sm text-slate-100">{item.title}</p>
                <p className="text-xs text-slate-500">
                  {targetTypeLabel(item.target_type)},{' '}
                  {isLinkLive(item.expires_at) ? 'Active' : 'Expired'}
                </p>
                <p className="text-xs text-slate-500">
                  Created {dateLabel(item.created_at)}, expires{' '}
                  {item.expires_at === null
                    ? 'never'
                    : dateLabel(item.expires_at)}
                </p>
              </div>
              <Button
                variant="secondary"
                onClick={() => {
                  void revoke(item.token_hash).catch(() => undefined);
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

export default ShareLinksSection;
