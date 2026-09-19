/**
 * The navigation between the workspace settings pages.
 *
 * Settings grew past one page at M6, and the shell's top nav is for the places
 * a person works rather than the places they configure, so the sections get
 * their own row inside settings instead of four more links in the header.
 *
 * Workspace administration is admin only, but a person's own API keys are not,
 * so the members link is gated and the access links are not. That mirrors what
 * the server allows rather than hiding a page somebody is entitled to open.
 */

import React from 'react';
import { NavLink } from 'react-router-dom';
import { canManageMembers } from '../../lib/capabilities';
import type { WorkspaceRead } from '../../types/Api';

/** Props for SettingsNav: the workspace whose settings are being shown. */
export interface SettingsNavProps {
  workspace: WorkspaceRead;
}

const linkClass = ({ isActive }: { isActive: boolean }): string =>
  isActive
    ? 'rounded-md bg-slate-800 px-3 py-1 text-sm text-white'
    : 'rounded-md px-3 py-1 text-sm text-slate-400 hover:text-slate-200';

/** Renders the links between the workspace, API key and share link settings. */
export const SettingsNav: React.FC<SettingsNavProps> = ({ workspace }) => (
  <nav aria-label="Settings sections" className="flex flex-wrap gap-2">
    {canManageMembers(workspace.role) && (
      <NavLink to={`/w/${workspace.slug}/settings`} end className={linkClass}>
        Workspace
      </NavLink>
    )}
    <NavLink
      to={`/w/${workspace.slug}/settings/api-keys`}
      className={linkClass}
    >
      API keys
    </NavLink>
    <NavLink
      to={`/w/${workspace.slug}/settings/share-links`}
      className={linkClass}
    >
      Share links
    </NavLink>
  </nav>
);

export default SettingsNav;
