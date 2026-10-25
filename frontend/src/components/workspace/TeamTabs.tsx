/**
 * The switch between a team's surfaces, sitting at the start of the toolbar on
 * each of them. These are links rather than local state, because each surface
 * is its own route and a person should be able to send one to someone else.
 *
 * Each page names the surface it is, so these are plain links: a NavLink would
 * re-derive the current tab from the address and disagree with the page on any
 * route it does not match exactly.
 */

import React, { useContext } from 'react';
import { Link } from 'react-router-dom';
import { SidebarDataContext } from '../../contexts/SidebarDataContextDefinition';
import { cn } from '../../lib/cn';
import {
  teamBoardPath,
  teamCyclesPath,
  teamDocumentsPagePath,
  teamPath,
  teamReleasesPath,
  teamSettingsPath,
  teamStandupPath,
  teamTriagePath,
} from '../../lib/paths';

/** Which of a team's surfaces is showing. */
export type TeamTab =
  | 'issues'
  | 'triage'
  | 'board'
  | 'cycles'
  | 'releases'
  | 'documents'
  | 'standup'
  | 'settings';

/** Props for TeamTabs: where the team lives and which tab is showing. */
export interface TeamTabsProps {
  slug: string;
  keyPrefix: string;
  current: TeamTab;
  /** The team's id, which shows the Triage tab once the team has triage on. */
  teamId?: string | undefined;
}

const tabClass = (active: boolean): string =>
  cn(
    'flex h-7 items-center rounded-sm px-2.5 text-sm font-medium whitespace-nowrap transition-colors duration-100 pointer-coarse:h-10',
    'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
    active ? 'bg-raised text-text' : 'text-text-muted hover:text-text'
  );

/**
 * The Issues, Board, Cycles, Releases, Documents, Standup and Settings switch for one
 * team, led by Triage whenever the team has triage on or the triage page is
 * showing, so the inbox is one click from any of the team's surfaces.
 */
export const TeamTabs: React.FC<TeamTabsProps> = ({
  slug,
  keyPrefix,
  current,
  teamId,
}) => {
  const shared = useContext(SidebarDataContext);
  const triageOn =
    teamId !== undefined &&
    (shared?.triage?.teams ?? []).some((row) => row.team_id === teamId);
  const tabs: { tab: TeamTab; label: string; to: string }[] = [
    ...(current === 'triage' || triageOn
      ? [
          {
            tab: 'triage' as const,
            label: 'Triage',
            to: teamTriagePath(slug, keyPrefix),
          },
        ]
      : []),
    { tab: 'issues', label: 'Issues', to: teamPath(slug, keyPrefix) },
    { tab: 'board', label: 'Board', to: teamBoardPath(slug, keyPrefix) },
    {
      tab: 'cycles',
      label: 'Cycles',
      to: teamCyclesPath(slug, keyPrefix),
    },
    {
      tab: 'releases',
      label: 'Releases',
      to: teamReleasesPath(slug, keyPrefix),
    },
    {
      tab: 'documents',
      label: 'Documents',
      to: teamDocumentsPagePath(slug, keyPrefix),
    },
    {
      tab: 'standup',
      label: 'Standup',
      to: teamStandupPath(slug, keyPrefix),
    },
    {
      tab: 'settings',
      label: 'Settings',
      to: teamSettingsPath(slug, keyPrefix),
    },
  ];

  return (
    <div className="flex items-center gap-1">
      {tabs.map((row) => (
        <Link
          key={row.tab}
          to={row.to}
          className={tabClass(current === row.tab)}
          {...(current === row.tab ? { 'aria-current': 'page' as const } : {})}
        >
          {row.label}
        </Link>
      ))}
    </div>
  );
};

export default TeamTabs;
