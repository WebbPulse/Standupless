/**
 * The release line in the issue rail: the furthest stage the newest release
 * carrying this issue reached, linked to that release, and how many other
 * releases carried it. Renders nothing while the issue has shipped in none,
 * or when the read fails, because the line is a pointer and not a control.
 */

import React from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { LuRocket } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { listIssueReleases } from '../../api/releases';
import { releasePath } from '../../lib/paths';
import { issueReleasesKey } from '../../lib/queryKeys';
import type { TeamRead } from '../../types/Api';
import RailSection from './RailSection';

/** How often the line re-reads. Releases land rarely, so this is slow. */
const POLL_MS = 300000;

/** Props for IssueReleasesSection: the issue, and the teams its releases map to. */
export interface IssueReleasesSectionProps {
  workspaceId: string;
  issueId: string;
  slug: string;
  teams: readonly Pick<TeamRead, 'id' | 'key_prefix'>[];
}

/** Names the newest release an issue shipped in and the stage it reached. */
export const IssueReleasesSection: React.FC<IssueReleasesSectionProps> = ({
  workspaceId,
  issueId,
  slug,
  teams,
}) => {
  const auth = useQueryAuth();
  const { data, error } = usePolledQuery(
    ({ signal }) => listIssueReleases(workspaceId, issueId, signal),
    {
      intervalMs: POLL_MS,
      queryKey: issueReleasesKey(workspaceId, issueId),
      auth,
    }
  );

  const releases = data?.releases ?? [];
  const newest = releases[0];
  if (error !== null || newest === undefined) return null;

  const team = teams.find((row) => row.id === newest.team_id);
  const others = releases.length - 1;
  const stage = newest.current_stage?.name ?? null;
  const label =
    stage === null
      ? `Released in ${newest.name}`
      : `Released to ${stage} in ${newest.name}`;

  return (
    <RailSection title="Releases" count={String(releases.length)}>
      <p className="flex min-w-0 items-center gap-1.5 text-xs text-text">
        <LuRocket
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-text-faint"
        />
        {team === undefined ? (
          <span className="truncate">{label}</span>
        ) : (
          <Link
            to={releasePath(slug, team.key_prefix, newest.release_id)}
            className="truncate rounded-xs hover:underline focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          >
            {label}
          </Link>
        )}
        {others > 0 && (
          <span className="shrink-0 text-text-faint">
            {`+${String(others)} more`}
          </span>
        )}
      </p>
    </RailSection>
  );
};

export default IssueReleasesSection;
