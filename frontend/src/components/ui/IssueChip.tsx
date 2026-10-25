/**
 * An issue key written in a description, comment, document or project
 * overview, drawn the way Linear draws a mention: a compact link with the
 * issue's status glyph in its colour, the key in muted text and the title,
 * truncated, at the body's own weight. Only a key whose prefix is one of the
 * workspace's teams is read, so text such as `UTF-8` never costs a request,
 * and every chip on the page is read through one batch lookup rather than a
 * request each. A key that does not resolve, or that the reader cannot see,
 * stays the text it was written as. Resting the pointer or keyboard focus on
 * the chip opens its preview card.
 */

import React, { useContext } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { Link } from 'react-router-dom';
import { listStatuses } from '../../api/teams';
import { TeamsContext } from '../../contexts/TeamsContextDefinition';
import { WorkspaceContext } from '../../contexts/WorkspaceContextDefinition';
import { isTeamKey } from '../../lib/issueDisplay';
import { loadIssueMention } from '../../lib/issueMentions';
import { issuePath } from '../../lib/paths';
import { LOOKUP_POLL_MS } from '../../lib/polling';
import { issueMentionKey, statusesKey } from '../../lib/queryKeys';
import { TRIAGE_STATUS } from '../../lib/triageStatus';
import type { IssueRead, StatusRead } from '../../types/Api';
import { useIssueHoverCard } from './IssueHoverCard';
import { StatusIcon } from './StatusIcon';

/** How often a mentioned issue is re-read, so its status stays current. */
const POLL_MS = 60000;

/** The classes the chip shares with the editor's drawing of it. */
export const ISSUE_CHIP_CLASS =
  'inline-flex max-w-full items-baseline gap-1 rounded-sm px-0.5 align-baseline text-text no-underline decoration-transparent transition-colors duration-100 hover:bg-raised focus-visible:bg-raised focus-visible:outline-none';

/** What a resolved mention draws from: the issue and its status. */
export interface IssueMention {
  /** The issue, or null until it resolves and when the reader cannot see it. */
  issue: IssueRead | null;
  /** The status its glyph shows, once the team's statuses are read. */
  status: StatusRead | undefined;
  /** The team's statuses, which a progress glyph ranks among. */
  statuses: readonly StatusRead[];
}

/**
 * Reads the issue a key names through the batch lookup, and its team's
 * statuses through the query every status picker already shares, so neither
 * costs a request per mention.
 */
export const useIssueMention = (
  workspaceId: string,
  issueKeyText: string
): IssueMention => {
  const auth = useQueryAuth();
  const { data: issue } = usePolledQuery(
    () => loadIssueMention(workspaceId, issueKeyText),
    {
      intervalMs: POLL_MS,
      queryKey: issueMentionKey(workspaceId, issueKeyText),
      auth,
    }
  );
  const teamId = issue?.team_id ?? '';
  const { data: statuses } = usePolledQuery(
    (context) => listStatuses(workspaceId, teamId, context),
    {
      intervalMs: LOOKUP_POLL_MS,
      enabled: teamId !== '',
      queryKey: statusesKey(teamId),
      auth,
    }
  );
  const known = statuses ?? [];
  const status =
    issue?.in_triage === true
      ? TRIAGE_STATUS
      : known.find((item) => item.id === issue?.status_id);
  return { issue: issue ?? null, status, statuses: known };
};

/** Props for the chip once the key is known to name a team's prefix. */
interface ResolvedIssueChipProps {
  workspaceId: string;
  slug: string;
  issueKeyText: string;
  fallback: React.ReactNode;
}

/** Reads the mention and draws the linked chip, or the fallback until it resolves. */
const ResolvedIssueChip: React.FC<ResolvedIssueChipProps> = ({
  workspaceId,
  slug,
  issueKeyText,
  fallback,
}) => {
  const { triggerProps, card } = useIssueHoverCard(issueKeyText);
  const { issue, status, statuses } = useIssueMention(
    workspaceId,
    issueKeyText
  );

  if (issue === null) return <>{fallback}</>;

  return (
    <>
      <Link
        to={issuePath(slug, issue.key)}
        {...triggerProps}
        data-md={issueKeyText}
        data-issue-chip=""
        className={ISSUE_CHIP_CLASS}
      >
        <StatusIcon
          status={status}
          statuses={statuses}
          className="h-3 w-3 shrink-0 self-center"
          {...(status === undefined ? {} : { name: status.name })}
        />
        <span className="shrink-0 text-text-muted">{issue.key}</span>
        <span className="min-w-0 truncate">{issue.title}</span>
      </Link>
      {card}
    </>
  );
};

/** Props for IssueChip. */
export interface IssueChipProps {
  issueKeyText: string;
  /**
   * What shows while the issue is read and when it does not resolve. Defaults
   * to the key as plain text; a key written as inline code passes the code.
   */
  fallback?: React.ReactNode;
}

/** An issue key in rendered Markdown, as a chip when it names a team's issue. */
export const IssueChip: React.FC<IssueChipProps> = ({
  issueKeyText,
  fallback,
}) => {
  const workspace = useContext(WorkspaceContext)?.workspace ?? null;
  const teams = useContext(TeamsContext)?.data ?? null;
  const shown = fallback ?? issueKeyText;
  if (workspace === null || teams === null || !isTeamKey(issueKeyText, teams)) {
    return <>{shown}</>;
  }
  return (
    <ResolvedIssueChip
      workspaceId={workspace.id}
      slug={workspace.slug}
      issueKeyText={issueKeyText}
      fallback={shown}
    />
  );
};

export default IssueChip;
