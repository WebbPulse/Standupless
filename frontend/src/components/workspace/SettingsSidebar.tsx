/**
 * The sidebar every settings page shows in place of the app sidebar, as
 * Linear's settings do: a Back to app link, the settings search, then the
 * settings pages in headed groups (Account, Workspace, Administration,
 * Features and Integrations) and last the viewer's teams, each opening onto
 * its own settings sections.
 *
 * The groups, their order and every label come from the settings index, which
 * the settings search and the command palette read too, so the three never
 * drift. A group the viewer has no page in is left out, so a member never
 * sees the Administration or Features headings. Back to app goes to the last
 * page shown outside settings, the same place Escape goes.
 */

import React, { useContext, useState } from 'react';
import {
  LuChevronLeft,
  LuChevronRight,
  LuPanelLeftClose,
} from 'react-icons/lu';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { TeamsContext } from '../../contexts/TeamsContextDefinition';
import { cn } from '../../lib/cn';
import { teamSettingsPath, teamSettingsSectionPath } from '../../lib/paths';
import {
  settingsNavGroups,
  teamSettingsAnchorId,
  teamSettingsSectionsFor,
} from '../../lib/settingsIndex';
import { settingsReturnPath } from '../../lib/settingsReturn';
import type { TeamRead, WorkspaceRead } from '../../types/Api';
import Avatar from '../ui/avatar';
import { IconButton } from '../ui/button';
import { TruncatedText } from '../ui/truncated-text';
import SettingsSearch from './SettingsSearch';

/** Props for SettingsSidebar. */
export interface SettingsSidebarProps {
  workspace: WorkspaceRead;
  /** Runs after a link is followed, so the phone list can close. */
  onNavigate?: () => void;
  /** Collapses the desktop sidebar, or none where it cannot collapse. */
  onCollapse?: () => void;
  /** Lets the rows fill a phone's width with taller touch targets. */
  fullScreen?: boolean;
}

const FOCUS =
  'focus-visible:bg-raised/70 focus-visible:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none';

/** The look of a settings row, lit when it is the current page. */
const rowClass = (isActive: boolean, indent = 'px-2'): string =>
  cn(
    'flex h-7 items-center gap-2 rounded-sm text-sm transition-colors duration-100 pointer-coarse:h-11',
    indent,
    FOCUS,
    isActive
      ? 'bg-raised font-medium text-text'
      : 'text-text-muted hover:bg-raised/70 hover:text-text'
  );

/** The id of a group's heading, which its list is labelled by. */
const headingId = (id: string): string => `settings-sidebar-${id}`;

/** A small heading over one group of rows. */
const Heading: React.FC<{ id: string; children: React.ReactNode }> = ({
  id,
  children,
}) => (
  <h2
    id={headingId(id)}
    className="flex h-6 items-center px-2 text-2xs font-medium text-text-faint pointer-coarse:h-9"
  >
    {children}
  </h2>
);

/** Props for one team's entry under Your teams. */
interface TeamEntryProps {
  slug: string;
  team: TeamRead;
  features: WorkspaceRead['features'] | undefined;
  onNavigate: (() => void) | undefined;
}

/**
 * One team under Your teams: a toggle that opens onto the team's settings
 * sections, open from the start while that team's settings are in view.
 */
const TeamEntry: React.FC<TeamEntryProps> = ({
  slug,
  team,
  features,
  onNavigate,
}) => {
  const { pathname, hash } = useLocation();
  const base = teamSettingsPath(slug, team.key_prefix);
  const here = pathname === base;
  const [open, setOpen] = useState(here);
  const isOpen = open || here;
  const panelId = `settings-sidebar-team-${team.id}`;
  const sections = teamSettingsSectionsFor(features);
  const current =
    hash === ''
      ? 'general'
      : hash.slice(1).replace(teamSettingsAnchorId(''), '');

  return (
    <li>
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={() => {
          setOpen(!isOpen);
        }}
        className={cn(rowClass(false), 'w-full')}
      >
        <Avatar
          name={team.name}
          src={team.icon_url}
          size="sm"
          shape="square"
          className="h-4 w-4 text-2xs"
        />
        <TruncatedText className="min-w-0 text-left">{team.name}</TruncatedText>
        <LuChevronRight
          aria-hidden="true"
          className={cn(
            'h-3 w-3 shrink-0 text-text-faint transition-transform duration-100',
            isOpen && 'rotate-90'
          )}
        />
      </button>
      <ul
        id={panelId}
        hidden={!isOpen}
        aria-label={`${team.name} settings`}
        className="mt-px space-y-px"
      >
        {sections.map((section) => {
          const active = here && current === section.id;
          return (
            <li key={section.id}>
              <Link
                to={teamSettingsSectionPath(slug, team.key_prefix, section.id)}
                aria-current={active ? 'page' : undefined}
                onClick={onNavigate}
                className={rowClass(active, 'pr-2 pl-8')}
              >
                <TruncatedText className="min-w-0">
                  {section.title}
                </TruncatedText>
              </Link>
            </li>
          );
        })}
      </ul>
    </li>
  );
};

/** Renders the settings sidebar for the workspace in view. */
export const SettingsSidebar: React.FC<SettingsSidebarProps> = ({
  workspace,
  onNavigate,
  onCollapse,
  fullScreen = false,
}) => {
  const shared = useContext(TeamsContext)?.data;
  const teams = (shared ?? []).filter((team) => team.is_member !== false);
  const groups = settingsNavGroups(workspace.role);
  const slug = workspace.slug;

  return (
    <div
      data-testid="settings-sidebar"
      className={cn('flex h-full flex-col bg-app', fullScreen && 'w-full')}
    >
      <div
        className={cn(
          'flex h-topbar shrink-0 items-center gap-1 px-2',
          fullScreen && 'pr-12'
        )}
      >
        <Link
          to={settingsReturnPath(slug)}
          onClick={onNavigate}
          className={cn(rowClass(false), 'min-w-0 flex-1 gap-1.5')}
        >
          <LuChevronLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="truncate">Back to app</span>
        </Link>
        {onCollapse !== undefined && (
          <IconButton label="Collapse sidebar" size="sm" onClick={onCollapse}>
            <LuPanelLeftClose className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
      <div className="shrink-0 px-2 pb-2">
        <SettingsSearch workspace={workspace} />
      </div>
      <nav
        aria-label="Settings"
        className="min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto px-2 pt-1 pb-4 scrollbar-thin"
      >
        {groups.map((group) => (
          <section key={group.id} aria-labelledby={headingId(group.id)}>
            <Heading id={group.id}>{group.title}</Heading>
            <ul className="space-y-px">
              {group.pages.map((page) => {
                const to = page.path(slug);
                return (
                  <li key={page.id}>
                    <NavLink
                      to={to}
                      end={page.id === 'workspace'}
                      onClick={onNavigate}
                      className={({ isActive }) => rowClass(isActive)}
                    >
                      <TruncatedText className="min-w-0">
                        {page.title}
                      </TruncatedText>
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {teams.length > 0 && (
          <section aria-labelledby={headingId('teams')}>
            <Heading id="teams">Your teams</Heading>
            <ul className="space-y-px">
              {teams.map((team) => (
                <TeamEntry
                  key={team.id}
                  slug={slug}
                  team={team}
                  features={workspace.features}
                  onNavigate={onNavigate}
                />
              ))}
            </ul>
          </section>
        )}
      </nav>
    </div>
  );
};

export default SettingsSidebar;
