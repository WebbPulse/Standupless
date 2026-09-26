/**
 * The GitHub issue an issue syncs with, shown on its own near the top of the
 * issue rail the way Linear shows a synced GitHub issue, apart from the pull
 * requests. Sync is set per team, so there is nothing to unlink here. With no
 * synced issue the section renders nothing.
 */

import React from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { LuCircleDot } from 'react-icons/lu';
import { getIssueSync } from '../../api/integrations';
import { issueSyncKey } from '../../lib/queryKeys';
import { PropertySection } from './IssueFields';

/** Props for GithubIssueSection: which issue's synced GitHub issue to show. */
export interface GithubIssueSectionProps {
  workspaceId: string;
  issueId: string;
}

/** How often the sync is re-read while the issue is open. */
const POLL_MS = 30000;

/** Links to the GitHub issue this issue syncs with, when there is one. */
export const GithubIssueSection: React.FC<GithubIssueSectionProps> = ({
  workspaceId,
  issueId,
}) => {
  const auth = useQueryAuth();
  const { data } = usePolledQuery(
    ({ signal }) => getIssueSync(workspaceId, issueId, signal),
    {
      intervalMs: POLL_MS,
      queryKey: issueSyncKey(workspaceId, issueId),
      auth,
    }
  );

  const sync = data ?? null;
  if (sync === null) return null;

  const reference = `${sync.repository_full_name}#${String(sync.number)}`;
  return (
    <PropertySection title="GitHub issue">
      <a
        className="-mx-1 flex items-center gap-1.5 rounded-sm px-1 py-1 text-xs text-text hover:bg-raised"
        href={sync.url}
        target="_blank"
        rel="noreferrer"
        aria-label={`Synced with ${reference}`}
        title={`Synced with ${reference}`}
      >
        <LuCircleDot
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-success"
        />
        <span className="truncate">{reference}</span>
      </a>
    </PropertySection>
  );
};

export default GithubIssueSection;
