/**
 * The switch between a team's surfaces, sitting at the start of the toolbar on
 * each of them. These are links rather than local state, because each surface
 * is its own route and a person should be able to send one to someone else.
 *
 * Each page names the surface it is, so these are plain links: a NavLink would
 * re-derive the current tab from the address and disagree with the page on any
 * route it does not match exactly.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';
import {
  teamBoardPath,
  teamCyclesPath,
  teamPath,
  teamSettingsPath,
} from '../../lib/paths';

/** Which of a team's surfaces is showing. */
export type TeamTab = 'issues' | 'board' | 'cycles' | 'settings';

/** Props for TeamTabs: where the team lives and which tab is showing. */
export interface TeamTabsProps {
  slug: string;
  keyPrefix: string;
  current: TeamTab;
}

const tabClass = (active: boolean): string =>
  cn(
    'flex h-7 items-center rounded-sm px-2.5 text-sm font-medium transition-colors duration-100',
    'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
    active ? 'bg-raised text-text' : 'text-text-muted hover:text-text'
  );

/** The Issues, Board, Cycles and Settings switch for one team. */
export const TeamTabs: React.FC<TeamTabsProps> = ({
  slug,
  keyPrefix,
  current,
}) => {
  const tabs: { tab: TeamTab; label: string; to: string }[] = [
    { tab: 'issues', label: 'Issues', to: teamPath(slug, keyPrefix) },
    { tab: 'board', label: 'Board', to: teamBoardPath(slug, keyPrefix) },
    {
      tab: 'cycles',
      label: 'Cycles',
      to: teamCyclesPath(slug, keyPrefix),
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
