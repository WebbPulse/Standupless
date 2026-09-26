/**
 * The navigation between the workspace settings pages, as a row of tabs in
 * the page bar's toolbar row.
 *
 * Workspace administration is admin only, but the team list and a person's own
 * API keys are not, so the workspace link is gated and the others are not. That mirrors what
 * the server allows rather than hiding a page somebody is entitled to open.
 */

import React from 'react';
import { NavLink } from 'react-router-dom';
import { canManageMembers } from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import type { WorkspaceRead } from '../../types/Api';

/** Props for SettingsNav: the workspace whose settings are being shown. */
export interface SettingsNavProps {
  workspace: WorkspaceRead;
}

/** The classes a tab carries, by whether it is the current page. */
const tabClass = ({ isActive }: { isActive: boolean }): string =>
  cn(
    'inline-flex h-8 items-center rounded-sm px-2.5 text-sm transition-colors duration-100',
    isActive
      ? 'bg-raised font-medium text-text'
      : 'text-text-muted hover:text-text'
  );

/** Renders the links between the workspace, team, API key and share link settings. */
export const SettingsNav: React.FC<SettingsNavProps> = ({ workspace }) => (
  <nav aria-label="Settings sections" className="flex flex-wrap gap-1">
    {canManageMembers(workspace.role) && (
      <NavLink to={`/w/${workspace.slug}/settings`} end className={tabClass}>
        Workspace
      </NavLink>
    )}
    <NavLink to={`/w/${workspace.slug}/settings/teams`} className={tabClass}>
      Teams
    </NavLink>
    <NavLink to={`/w/${workspace.slug}/settings/api-keys`} className={tabClass}>
      API keys
    </NavLink>
    <NavLink
      to={`/w/${workspace.slug}/settings/share-links`}
      className={tabClass}
    >
      Share links
    </NavLink>
  </nav>
);

export default SettingsNav;
