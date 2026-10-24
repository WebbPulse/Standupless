/**
 * An issue key written in a description or a comment, drawn the way Linear
 * draws one: a link to the issue with its status glyph, key and title. Only a
 * key whose prefix is one of the workspace's teams is read, so text such as
 * `UTF-8` never costs a request, and a key that does not resolve, or that the
 * reader cannot see, stays the plain text it was written as.
 */

import React, { useContext } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { Link } from 'react-router-dom';
import { getIssueByKey } from '../../api/issues';
import { listStatuses } from '../../api/teams';
import { TeamsContext } from '../../contexts/TeamsContextDefinition';
import { WorkspaceContext } from '../../contexts/WorkspaceContextDefinition';
import { isTeamKey } from '../../lib/issueDisplay';
import { issuePath } from '../../lib/paths';
import { LOOKUP_POLL_MS } from '../../lib/polling';
import { issueKey, statusesKey } from '../../lib/queryKeys';
import { TRIAGE_STATUS } from '../../lib/triageStatus';
import { StatusIcon } from './StatusIcon';

/** How often a mentioned issue is re-read, so its status stays current. */
const POLL_MS = 60000;

/** Props for the chip once the key is known to name a team's issue. */
interface ResolvedIssueChipProps {
  workspaceId: string;
  slug: string;
  issueKeyText: string;
}

/** Reads the issue and its team's statuses, and draws the linked chip. */
const ResolvedIssueChip: React.FC<ResolvedIssueChipProps> = ({
  workspaceId,
  slug,
  issueKeyText,
}) => {
  const auth = useQueryAuth();
  const { data: issue } = usePolledQuery(
    (context) => getIssueByKey(workspaceId, issueKeyText, context),
    {
      intervalMs: POLL_MS,
      queryKey: issueKey(workspaceId, issueKeyText),
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

  if (issue === null) return <>{issueKeyText}</>;

  const known = statuses ?? [];
  const status =
    issue.in_triage === true
      ? TRIAGE_STATUS
      : known.find((item) => item.id === issue.status_id);

  return (
    <Link
      to={issuePath(slug, issue.key)}
      title={`${issue.key} ${issue.title}`}
      className="inline-flex max-w-full items-baseline gap-1 rounded-xs bg-raised px-1 align-baseline text-[0.95em] text-text no-underline transition-colors duration-100 hover:bg-line"
    >
      <StatusIcon
        status={status}
        statuses={known}
        className="h-3 w-3 shrink-0 self-center"
        {...(status === undefined ? {} : { name: status.name })}
      />
      <span className="shrink-0 font-mono text-text-muted">{issue.key}</span>
      <span className="min-w-0 truncate">{issue.title}</span>
    </Link>
  );
};

/** An issue key in rendered Markdown, as a chip when it names a team's issue. */
export const IssueChip: React.FC<{ issueKeyText: string }> = ({
  issueKeyText,
}) => {
  const workspace = useContext(WorkspaceContext)?.workspace ?? null;
  const teams = useContext(TeamsContext)?.data ?? null;
  if (workspace === null || teams === null || !isTeamKey(issueKeyText, teams)) {
    return <>{issueKeyText}</>;
  }
  return (
    <ResolvedIssueChip
      workspaceId={workspace.id}
      slug={workspace.slug}
      issueKeyText={issueKeyText}
    />
  );
};

export default IssueChip;
