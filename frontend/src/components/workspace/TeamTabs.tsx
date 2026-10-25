/**
 * The switch between a team's surfaces, sitting at the start of the toolbar on
 * each of them. These are links rather than local state, because each surface
 * is its own route and a person should be able to send one to someone else.
 *
 * Each page names the surface it is, so these are plain links: a NavLink would
 * re-derive the current tab from the address and disagree with the page on any
 * route it does not match exactly.
 */

import React, { useContext, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { SidebarDataContext } from '../../contexts/SidebarDataContextDefinition';
import { useFeatureOn } from '../../hooks/useFeatureOn';
import { cn } from '../../lib/cn';
import {
  teamBoardPath,
  teamCyclesPath,
  teamDocumentsPagePath,
  teamPath,
  teamProjectsPath,
  teamReleasesPath,
  teamSettingsPath,
  teamStandupPath,
  teamTriagePath,
  teamViewsPath,
} from '../../lib/paths';

/** Which of a team's surfaces is showing. */
export type TeamTab =
  | 'issues'
  | 'triage'
  | 'board'
  | 'cycles'
  | 'projects'
  | 'views'
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
    'flex h-7 shrink-0 items-center rounded-sm px-2.5 text-sm font-medium whitespace-nowrap transition-colors duration-100 pointer-coarse:h-10',
    'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none focus-visible:ring-inset',
    active ? 'bg-raised text-text' : 'text-text-muted hover:text-text'
  );

/**
 * The Issues, Board, Cycles, Projects, Views, Releases, Documents, Standup and
 * Settings switch for one team, in Linear's order, led by Triage whenever the
 * team has triage on or the triage page is showing, so the inbox is one click
 * from any of the team's surfaces. Releases and Documents drop out while the
 * workspace has them off. On a narrow screen the row scrolls sideways and
 * brings the showing tab into view.
 */
export const TeamTabs: React.FC<TeamTabsProps> = ({
  slug,
  keyPrefix,
  current,
  teamId,
}) => {
  const shared = useContext(SidebarDataContext);
  const releasesOn = useFeatureOn('releases');
  const documentsOn = useFeatureOn('documents');
  const activeRef = useRef<HTMLAnchorElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({
      block: 'nearest',
      inline: 'nearest',
    });
  }, [current]);
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
      tab: 'projects',
      label: 'Projects',
      to: teamProjectsPath(slug, keyPrefix),
    },
    { tab: 'views', label: 'Views', to: teamViewsPath(slug, keyPrefix) },
    ...(releasesOn
      ? [
          {
            tab: 'releases' as const,
            label: 'Releases',
            to: teamReleasesPath(slug, keyPrefix),
          },
        ]
      : []),
    ...(documentsOn
      ? [
          {
            tab: 'documents' as const,
            label: 'Documents',
            to: teamDocumentsPagePath(slug, keyPrefix),
          },
        ]
      : []),
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
    <nav
      aria-label="Team"
      className="flex max-w-[calc(100vw-2rem)] min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map((row) => (
        <Link
          key={row.tab}
          to={row.to}
          ref={current === row.tab ? activeRef : undefined}
          className={tabClass(current === row.tab)}
          {...(current === row.tab ? { 'aria-current': 'page' as const } : {})}
        >
          {row.label}
        </Link>
      ))}
    </nav>
  );
};

export default TeamTabs;
