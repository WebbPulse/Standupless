/**
 * The pull requests linked to one issue.
 *
 * The section is read only: a link is made by naming the issue key in a branch,
 * a pull request or a commit, so there is nothing here to add or remove by hand
 * and no route that would. It renders nothing at all when there are no links,
 * because an empty GitHub panel on every issue would be noise for a workspace
 * that has not connected GitHub.
 */

import React from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { listIssueLinks } from '../../api/integrations';
import { errorMessage } from '../../lib/errors';
import { githubLinksKey } from '../../lib/queryKeys';
import type { GithubIssueLinkRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';

/** Props for GithubLinksSection: which issue's pull requests to show. */
export interface GithubLinksSectionProps {
  workspaceId: string;
  issueId: string;
}

/** How often the links are re-read while the issue is open. */
const POLL_MS = 30000;

/** How each pull request state reads in the interface. */
const STATE_LABELS: Record<GithubIssueLinkRead['pr_state'], string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
};

/** Lists the pull requests that name this issue. */
export const GithubLinksSection: React.FC<GithubLinksSectionProps> = ({
  workspaceId,
  issueId,
}) => {
  const auth = useQueryAuth();

  const { data, error } = usePolledQuery(
    ({ signal }) => listIssueLinks(workspaceId, issueId, {}, signal),
    {
      intervalMs: POLL_MS,
      queryKey: githubLinksKey(workspaceId, issueId),
      auth,
    }
  );

  if (error !== null) {
    return (
      <ErrorAlert
        message={errorMessage(
          error,
          'Could not load the linked pull requests.'
        )}
      />
    );
  }

  const links = data?.items ?? [];
  if (links.length === 0) {
    return null;
  }

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium text-white">Pull requests</h2>
      <ul className="space-y-2">
        {links.map((link) => (
          <li
            key={link.link_id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-700 px-3 py-2"
          >
            <div className="min-w-0">
              <a
                className="truncate text-sm text-sky-300 hover:underline"
                href={link.pr_url}
                target="_blank"
                rel="noreferrer"
              >
                {link.repository_full_name}#{link.pr_number} {link.pr_title}
              </a>
              <p className="text-xs text-slate-500">
                {STATE_LABELS[link.pr_state]}, opened by {link.author_login}
                {link.closes_issue ? ', closes this issue' : ''}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
};

export default GithubLinksSection;
