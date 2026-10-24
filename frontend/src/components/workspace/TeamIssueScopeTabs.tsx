/**
 * The All issues, Active and Backlog switch beside a team's name on its issue
 * list and board. Each segment is a link that keeps the filters on screen and
 * swaps the preset, so the choice sits in the URL and survives a reload.
 */

import React from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { cn } from '../../lib/cn';
import {
  TEAM_ISSUE_SCOPES,
  teamScopeHref,
  type TeamIssueScope,
} from '../../lib/teamIssueScope';

/** Props for TeamIssueScopeTabs. */
export interface TeamIssueScopeTabsProps {
  current: TeamIssueScope;
}

const segmentClass = (active: boolean): string =>
  cn(
    'flex h-6 items-center rounded-sm border px-2 text-xs font-medium whitespace-nowrap transition-colors duration-100 pointer-coarse:h-9',
    'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
    active
      ? 'border-line-strong bg-raised text-text'
      : 'border-transparent text-text-muted hover:bg-raised hover:text-text'
  );

/** The three preset segments, the showing one marked as the current page. */
export const TeamIssueScopeTabs: React.FC<TeamIssueScopeTabsProps> = ({
  current,
}) => {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  return (
    <nav
      aria-label="Issue presets"
      className="ml-2 flex shrink-0 items-center gap-1"
    >
      {TEAM_ISSUE_SCOPES.map(({ scope, label }) => (
        <Link
          key={scope}
          to={teamScopeHref(pathname, params, scope)}
          className={segmentClass(current === scope)}
          data-testid={`team-scope-${scope}`}
          {...(current === scope ? { 'aria-current': 'page' as const } : {})}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
};

export default TeamIssueScopeTabs;
