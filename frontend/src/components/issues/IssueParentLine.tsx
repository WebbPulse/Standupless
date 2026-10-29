/**
 * The parent of a sub-issue, as a line above its title, as Linear shows it on
 * the issue page, the inbox pane and the peek. It names the parent's status,
 * key and title, shows the hover card, and links to the parent's page. Where
 * an `onOpenIssue` is given, as in the peek, a plain click opens the parent in
 * place instead and a modified click still follows the link.
 *
 * The parent is found among the team's candidate parents the caller already
 * holds, and read on its own under the issue key only when it is not one of
 * them.
 */

import React from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { Link } from 'react-router-dom';
import { getIssue } from '../../api/issues';
import type { IssueTreeTarget } from '../../hooks/useIssueTreeKeys';
import { issuePath } from '../../lib/paths';
import { issueKey } from '../../lib/queryKeys';
import { TRIAGE_STATUS } from '../../lib/triageStatus';
import type { IssueRead, StatusRead } from '../../types/Api';
import { IssueHoverTrigger } from '../ui/IssueHoverCard';
import { StatusIcon } from '../ui/StatusIcon';

/** Props for IssueParentLine. */
export interface IssueParentLineProps {
  workspaceId: string;
  slug: string;
  parentId: string;
  /** Issues already loaded, searched for the parent before reading it. */
  known: readonly IssueRead[];
  statuses: StatusRead[];
  /** Opens the parent in place on a plain click. */
  onOpenIssue?: (issue: IssueTreeTarget) => void;
}

/** How often a parent read on its own is re-read. */
const POLL_MS = 60000;

/** True for a click that should follow a link rather than open in place. */
const opensPage = (event: React.MouseEvent): boolean =>
  event.button !== 0 ||
  event.metaKey ||
  event.ctrlKey ||
  event.shiftKey ||
  event.altKey;

/** The line above a sub-issue's title that names and links its parent. */
export const IssueParentLine: React.FC<IssueParentLineProps> = ({
  workspaceId,
  slug,
  parentId,
  known,
  statuses,
  onOpenIssue,
}) => {
  const auth = useQueryAuth();
  const held = known.find((candidate) => candidate.id === parentId);
  const { data: fetched } = usePolledQuery(
    (context) => getIssue(workspaceId, parentId, context),
    {
      intervalMs: POLL_MS,
      enabled: held === undefined && workspaceId !== '',
      queryKey: issueKey(workspaceId, parentId),
      auth,
    }
  );
  const parent =
    held ?? (fetched !== null && fetched.id === parentId ? fetched : undefined);
  if (parent === undefined) return null;
  const status =
    parent.in_triage === true
      ? TRIAGE_STATUS
      : statuses.find((item) => item.id === parent.status_id);
  return (
    <IssueHoverTrigger issueKey={parent.key}>
      {(hover) => (
        <Link
          to={issuePath(slug, parent.key)}
          {...hover}
          aria-label={`Sub-issue of ${parent.key} ${parent.title}`}
          onClick={(event) => {
            if (onOpenIssue === undefined || opensPage(event)) return;
            event.preventDefault();
            onOpenIssue({ id: parent.id, key: parent.key });
          }}
          className="-mx-1 -mb-3 flex h-6 w-fit max-w-full items-center gap-1.5 rounded-sm px-1 text-xs text-text-muted transition-colors duration-100 hover:bg-raised hover:text-text print:hidden"
        >
          <StatusIcon
            status={status}
            statuses={statuses}
            {...(status === undefined ? {} : { name: status.name })}
          />
          <span className="shrink-0 font-mono text-text-faint">
            {parent.key}
          </span>
          <span className="min-w-0 truncate">{parent.title}</span>
        </Link>
      )}
    </IssueHoverTrigger>
  );
};

export default IssueParentLine;
