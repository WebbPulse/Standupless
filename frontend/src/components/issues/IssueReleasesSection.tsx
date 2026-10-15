/**
 * The releases section of the issue rail: every release carrying this issue,
 * newest first, one row each like the pull requests section. A row links to
 * the release and reads its furthest stage, whether a promotion carried it,
 * and when it reached that stage. A release a promotion carried is listed and
 * marked as included in it, never hidden. Past five rows a toggle shows the
 * rest. Renders nothing while the issue has shipped in none, or when the read
 * fails, because the section is a pointer and not a control.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { LuRocket } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { listIssueReleases } from '../../api/releases';
import { releasePath } from '../../lib/paths';
import { issueReleasesKey } from '../../lib/queryKeys';
import { fullTimestamp } from '../../lib/relativeTime';
import type { IssueReleaseRead, TeamRead } from '../../types/Api';
import RelativeTime from '../ui/relative-time';
import RailSection from './RailSection';

/** How often the section re-reads. Releases land rarely, so this is slow. */
const POLL_MS = 300000;

/** How many rows show before the toggle. */
export const RELEASES_SHOWN = 5;

/** Props for IssueReleasesSection: the issue, and the teams its releases map to. */
export interface IssueReleasesSectionProps {
  workspaceId: string;
  issueId: string;
  slug: string;
  teams: readonly Pick<TeamRead, 'id' | 'key_prefix'>[];
}

/** The stage a release reached, with its environment when that differs. */
const stageLabel = (release: IssueReleaseRead): string => {
  const stage = release.current_stage;
  if (stage === null || stage === undefined) return 'Not deployed';
  const environment = stage.environment ?? null;
  return environment === null ||
    environment.toLowerCase() === stage.name.toLowerCase()
    ? stage.name
    : `${stage.name} (${environment})`;
};

/** Whether the release went out alone or inside a promotion. */
const stateLabel = (release: IssueReleaseRead): string => {
  if (release.included_in === null || release.included_in === undefined) {
    return release.current_stage === null ||
      release.current_stage === undefined
      ? 'created'
      : 'released';
  }
  return `included in ${release.included_in_name ?? 'a promotion'}`;
};

/** One release: its icon, its name linked to it, and its stage, state and time. */
const ReleaseEntry: React.FC<{
  release: IssueReleaseRead;
  slug: string;
  keyPrefix: string | undefined;
}> = ({ release, slug, keyPrefix }) => {
  const when = release.current_stage?.reached_at ?? release.created_at;
  const detail = `${stageLabel(release)}, ${stateLabel(release)}`;
  const label = `${release.name}, ${detail}, ${fullTimestamp(when)}`;
  const nameClass =
    'block truncate rounded-xs text-text hover:underline focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none';
  return (
    <div className="flex items-start gap-1.5">
      <LuRocket
        aria-hidden="true"
        data-included={String(
          release.included_in !== null && release.included_in !== undefined
        )}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-faint"
      />
      <div className="min-w-0 flex-1">
        {keyPrefix === undefined ? (
          <span
            className="block truncate text-text"
            title={release.name}
            aria-label={label}
          >
            {release.name}
          </span>
        ) : (
          <Link
            to={releasePath(slug, keyPrefix, release.release_id)}
            className={nameClass}
            title={release.name}
            aria-label={label}
          >
            {release.name}
          </Link>
        )}
        <p className="flex min-w-0 items-center gap-1 text-text-faint">
          <span className="truncate">{detail}</span>
          <span aria-hidden="true">·</span>
          <RelativeTime value={when} className="shrink-0" />
        </p>
      </div>
    </div>
  );
};

/** Lists every release an issue shipped in, one row each. */
export const IssueReleasesSection: React.FC<IssueReleasesSectionProps> = ({
  workspaceId,
  issueId,
  slug,
  teams,
}) => {
  const auth = useQueryAuth();
  const [showAll, setShowAll] = useState(false);
  const { data, error } = usePolledQuery(
    ({ signal }) => listIssueReleases(workspaceId, issueId, signal),
    {
      intervalMs: POLL_MS,
      queryKey: issueReleasesKey(workspaceId, issueId),
      auth,
    }
  );

  const releases = data?.releases ?? [];
  if (error !== null || releases.length === 0) return null;

  const prefixes = new Map(teams.map((team) => [team.id, team.key_prefix]));
  const shown = showAll ? releases : releases.slice(0, RELEASES_SHOWN);
  const hidden = releases.length - RELEASES_SHOWN;

  return (
    <RailSection title="Releases" count={String(releases.length)}>
      <ul aria-label="Releases carrying this issue" className="space-y-0.5">
        {shown.map((release) => (
          <li
            key={release.release_id}
            className="-mx-1 rounded-sm px-1 py-1 text-xs hover:bg-raised"
          >
            <ReleaseEntry
              release={release}
              slug={slug}
              keyPrefix={prefixes.get(release.team_id)}
            />
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          aria-expanded={showAll}
          className="mt-0.5 rounded-xs text-xs text-text-faint hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          onClick={() => {
            setShowAll((value) => !value);
          }}
        >
          {showAll ? 'Show fewer' : `Show all ${String(releases.length)}`}
        </button>
      )}
    </RailSection>
  );
};

export default IssueReleasesSection;
