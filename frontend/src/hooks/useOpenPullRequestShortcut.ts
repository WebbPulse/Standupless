/**
 * O then G on an issue, as Linear binds it: opens the linked pull request in
 * a new tab, or the synced GitHub issue when there is none, and says so when
 * there is nothing to open. The issue page binds it from its pull requests
 * section and the peek binds it itself, both reading the same polled links and
 * sync, so the keys work whether or not the rail shows either section.
 */

import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { getIssueSync, listIssueLinks } from '../api/integrations';
import { pullRequestToOpen } from '../lib/pullRequestStacks';
import { githubLinksKey, issueSyncKey } from '../lib/queryKeys';
import { showToast } from '../lib/toast';
import { useShortcut } from './useShortcuts';

/** The keys that open the linked pull request or synced GitHub issue. */
export const OPEN_PULL_REQUEST_KEYS = 'o g';

/** How often the links and the sync are re-read while the issue is open. */
const POLL_MS = 30000;

/** Binds O then G for one issue while the caller is mounted. */
export const useOpenPullRequestShortcut = (
  workspaceId: string,
  issueId: string,
  enabled = true
): void => {
  const auth = useQueryAuth();
  const ready = enabled && workspaceId !== '' && issueId !== '';
  const { data: links } = usePolledQuery(
    ({ signal }) => listIssueLinks(workspaceId, issueId, {}, signal),
    {
      intervalMs: POLL_MS,
      queryKey: githubLinksKey(workspaceId, issueId),
      auth,
      enabled: ready,
    }
  );
  const { data: sync } = usePolledQuery(
    ({ signal }) => getIssueSync(workspaceId, issueId, signal),
    {
      intervalMs: POLL_MS,
      queryKey: issueSyncKey(workspaceId, issueId),
      auth,
      enabled: ready,
    }
  );

  useShortcut({
    keys: OPEN_PULL_REQUEST_KEYS,
    label: 'Open pull request or GitHub issue',
    scope: 'issue',
    group: 'Issue',
    enabled: ready,
    handler: () => {
      const url =
        pullRequestToOpen(links?.items ?? [])?.pr_url ?? sync?.url ?? null;
      if (url === null) {
        showToast('No linked pull request');
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    },
  });
};
