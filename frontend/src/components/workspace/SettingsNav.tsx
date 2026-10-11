/**
 * The navigation between the workspace settings pages, as a row of tabs in
 * the page bar's toolbar row.
 *
 * Workspace administration is admin only, but the team list, the workflow
 * and labels every team inherits (read only below admin), the plan, a person's own
 * API keys, connected apps and MCP and CLI setup are not, and notification
 * preferences are personal, so the workspace, security, audit log, export and import links are gated and the
 * others are not. That mirrors what the server allows rather than hiding a page somebody
 * is entitled to open.
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

/** Renders the links between the workspace, security, team, workflow, label, template, billing, API key, connected app, MCP and CLI, share link, export, import, audit log and notification settings. */
export const SettingsNav: React.FC<SettingsNavProps> = ({ workspace }) => (
  <nav aria-label="Settings sections" className="flex flex-wrap gap-1">
    {canManageMembers(workspace.role) && (
      <NavLink to={`/w/${workspace.slug}/settings`} end className={tabClass}>
        Workspace
      </NavLink>
    )}
    {canManageMembers(workspace.role) && (
      <NavLink
        to={`/w/${workspace.slug}/settings/security`}
        className={tabClass}
      >
        Security
      </NavLink>
    )}
    <NavLink to={`/w/${workspace.slug}/settings/teams`} className={tabClass}>
      Teams
    </NavLink>
    <NavLink to={`/w/${workspace.slug}/settings/workflow`} className={tabClass}>
      Workflow
    </NavLink>
    <NavLink to={`/w/${workspace.slug}/settings/labels`} className={tabClass}>
      Labels
    </NavLink>
    <NavLink
      to={`/w/${workspace.slug}/settings/templates`}
      className={tabClass}
    >
      Templates
    </NavLink>
    <NavLink to={`/w/${workspace.slug}/settings/billing`} className={tabClass}>
      Billing
    </NavLink>
    <NavLink to={`/w/${workspace.slug}/settings/api-keys`} className={tabClass}>
      API keys
    </NavLink>
    <NavLink
      to={`/w/${workspace.slug}/settings/connected-apps`}
      className={tabClass}
    >
      Connected apps
    </NavLink>
    <NavLink
      to={`/w/${workspace.slug}/settings/mcp-and-cli`}
      className={tabClass}
    >
      MCP and CLI
    </NavLink>
    <NavLink
      to={`/w/${workspace.slug}/settings/share-links`}
      className={tabClass}
    >
      Share links
    </NavLink>
    {canManageMembers(workspace.role) && (
      <NavLink to={`/w/${workspace.slug}/settings/export`} className={tabClass}>
        Export
      </NavLink>
    )}
    {canManageMembers(workspace.role) && (
      <NavLink to={`/w/${workspace.slug}/settings/import`} className={tabClass}>
        Import
      </NavLink>
    )}
    {canManageMembers(workspace.role) && (
      <NavLink
        to={`/w/${workspace.slug}/settings/audit-log`}
        className={tabClass}
      >
        Audit log
      </NavLink>
    )}
    <NavLink
      to={`/w/${workspace.slug}/settings/notifications`}
      className={tabClass}
    >
      Notifications
    </NavLink>
  </nav>
);

export default SettingsNav;
