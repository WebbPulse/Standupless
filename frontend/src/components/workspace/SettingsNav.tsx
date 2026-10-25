/**
 * The navigation between the settings pages, as a search field and a row of
 * tabs in the page bar's toolbar row. The search finds a page, section or
 * single control by name or synonym, for when the tab that holds it is not
 * obvious. The personal pages come first, Linear's Account group:
 * Profile, Preferences, Notifications and Security & access belong to the person and apply
 * in every workspace, so every member sees them. The workspace pages follow.
 *
 * Workspace administration is admin only, but the team list, the workflow
 * and labels every team inherits (read only below admin), the plan, a person's own
 * API keys, connected apps, MCP and CLI setup and private agent profiles are not, and notification
 * preferences are personal, so the workspace, security, integrations, audit log, export and import links are gated and the
 * others are not. That mirrors what the server allows rather than hiding a page somebody
 * is entitled to open.
 */

import React from 'react';
import { NavLink } from 'react-router-dom';
import { canManageMembers } from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import SettingsSearch from './SettingsSearch';
import type { WorkspaceRead } from '../../types/Api';

/** Props for SettingsNav: the workspace whose settings are being shown. */
export interface SettingsNavProps {
  workspace: WorkspaceRead;
}

/** The classes a tab carries, by whether it is the current page. */
const tabClass = ({ isActive }: { isActive: boolean }): string =>
  cn(
    'inline-flex h-8 items-center rounded-sm px-2.5 text-sm whitespace-nowrap transition-colors duration-100 pointer-coarse:h-10',
    isActive
      ? 'bg-raised font-medium text-text'
      : 'text-text-muted hover:text-text'
  );

/** Renders the settings search, then the links between the personal profile, preference, notification and security pages, then the workspace, security, team, workflow, label, template, billing, API key, integrations, connected app, MCP and CLI, agent profile, share link, export, import and audit log settings. */
export const SettingsNav: React.FC<SettingsNavProps> = ({ workspace }) => (
  <div className="flex flex-wrap items-center gap-2">
    <SettingsSearch
      workspace={workspace}
      className="w-full sm:w-52 sm:shrink-0"
    />
    <nav
      aria-label="Settings sections"
      className="phone-scroll-row flex min-w-0 flex-wrap gap-1"
    >
      <NavLink
        to={`/w/${workspace.slug}/settings/account/profile`}
        className={tabClass}
      >
        Profile
      </NavLink>
      <NavLink
        to={`/w/${workspace.slug}/settings/account/preferences`}
        className={tabClass}
      >
        Preferences
      </NavLink>
      <NavLink
        to={`/w/${workspace.slug}/settings/notifications`}
        className={tabClass}
      >
        Notifications
      </NavLink>
      <NavLink
        to={`/w/${workspace.slug}/settings/account/security`}
        className={tabClass}
      >
        Security & access
      </NavLink>
      <span aria-hidden="true" className="mx-1 my-1.5 w-px bg-line" />
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
      <NavLink
        to={`/w/${workspace.slug}/settings/workflow`}
        className={tabClass}
      >
        Workflow
      </NavLink>
      <NavLink to={`/w/${workspace.slug}/settings/labels`} className={tabClass}>
        Labels
      </NavLink>
      <NavLink
        to={`/w/${workspace.slug}/settings/project-labels`}
        className={tabClass}
      >
        Project labels
      </NavLink>
      <NavLink
        to={`/w/${workspace.slug}/settings/templates`}
        className={tabClass}
      >
        Templates
      </NavLink>
      <NavLink
        to={`/w/${workspace.slug}/settings/billing`}
        className={tabClass}
      >
        Billing
      </NavLink>
      <NavLink
        to={`/w/${workspace.slug}/settings/api-keys`}
        className={tabClass}
      >
        API keys
      </NavLink>
      {canManageMembers(workspace.role) && (
        <NavLink
          to={`/w/${workspace.slug}/settings/integrations`}
          className={tabClass}
        >
          Integrations
        </NavLink>
      )}
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
        to={`/w/${workspace.slug}/settings/agent-profiles`}
        className={tabClass}
      >
        Agent profiles
      </NavLink>
      <NavLink
        to={`/w/${workspace.slug}/settings/share-links`}
        className={tabClass}
      >
        Share links
      </NavLink>
      {canManageMembers(workspace.role) && (
        <NavLink
          to={`/w/${workspace.slug}/settings/export`}
          className={tabClass}
        >
          Export
        </NavLink>
      )}
      {canManageMembers(workspace.role) && (
        <NavLink
          to={`/w/${workspace.slug}/settings/import`}
          className={tabClass}
        >
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
    </nav>
  </div>
);

export default SettingsNav;
