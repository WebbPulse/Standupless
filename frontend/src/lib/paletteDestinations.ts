/**
 * The settings pages the command palette can open, with the words each one is
 * found by. They live apart from the palette so the list stays a plain table a
 * test can read whole, and so a settings page added later is one row here.
 *
 * The rows the palette already offers among its places, Edit profile,
 * Preferences, Security & access, Manage teams and the MCP and CLI setup, are not repeated. A row
 * that is admin only on the settings nav is admin only here too, so the
 * palette never opens a page that would only say the caller may not see it.
 */

import { canManageMembers } from './capabilities';
import {
  agentProfilesPath,
  apiKeysPath,
  auditLogSettingsPath,
  billingSettingsPath,
  connectedAppsPath,
  exportSettingsPath,
  importSettingsPath,
  integrationsSettingsPath,
  labelsSettingsPath,
  notificationSettingsPath,
  settingsPath,
  shareLinksSettingsPath,
  teamSettingsSectionPath,
  templatesSettingsPath,
  workflowSettingsPath,
  workspaceSecuritySettingsPath,
} from './paths';
import type { WorkspaceRead } from '../types/Api';

/** One page the palette can go to. */
export interface PaletteDestination {
  /** Stable within its list, so the palette can key its row on it. */
  id: string;
  label: string;
  /** The words the row is found by beyond its label. */
  keywords: string;
  to: string;
}

/** A workspace settings page before it is resolved for one workspace. */
interface SettingsRow {
  id: string;
  label: string;
  keywords: string;
  path: (slug: string) => string;
  adminOnly?: boolean;
}

/** The workspace and personal settings pages, in settings nav order. */
const SETTINGS: readonly SettingsRow[] = [
  {
    id: 'notifications',
    label: 'Notification settings',
    keywords:
      'notifications preferences email digest timezone alerts subscriptions account',
    path: notificationSettingsPath,
  },
  {
    id: 'workspace',
    label: 'Workspace settings',
    keywords: 'general workspace name url members invite people roles seats',
    path: settingsPath,
    adminOnly: true,
  },
  {
    id: 'security',
    label: 'Workspace security',
    keywords:
      'security sso saml single sign-on two-factor 2fa policy approved domains authentication',
    path: workspaceSecuritySettingsPath,
    adminOnly: true,
  },
  {
    id: 'workflow',
    label: 'Workspace workflow',
    keywords: 'workflow statuses states settings inherited',
    path: workflowSettingsPath,
  },
  {
    id: 'labels',
    label: 'Workspace labels',
    keywords: 'labels tags settings inherited',
    path: labelsSettingsPath,
  },
  {
    id: 'templates',
    label: 'Workspace templates',
    keywords: 'templates issue templates settings',
    path: templatesSettingsPath,
  },
  {
    id: 'billing',
    label: 'Billing and plan',
    keywords:
      'billing plan subscription upgrade invoices payment seats pricing',
    path: billingSettingsPath,
  },
  {
    id: 'api-keys',
    label: 'API keys',
    keywords: 'api keys tokens personal access settings',
    path: apiKeysPath,
  },
  {
    id: 'integrations',
    label: 'Integrations',
    keywords: 'integrations slack discord channels connect settings',
    path: integrationsSettingsPath,
    adminOnly: true,
  },
  {
    id: 'connected-apps',
    label: 'Connected apps',
    keywords: 'connected apps oauth authorized clients revoke settings',
    path: connectedAppsPath,
  },
  {
    id: 'agent-profiles',
    label: 'Agent profiles',
    keywords: 'agent profiles claude guidance settings',
    path: agentProfilesPath,
  },
  {
    id: 'share-links',
    label: 'Share links',
    keywords: 'share links public published revoke settings',
    path: shareLinksSettingsPath,
  },
  {
    id: 'export',
    label: 'Export workspace',
    keywords: 'export download backup json data settings',
    path: exportSettingsPath,
    adminOnly: true,
  },
  {
    id: 'import',
    label: 'Import issues',
    keywords: 'import csv linear jira github migrate upload settings',
    path: importSettingsPath,
    adminOnly: true,
  },
  {
    id: 'audit-log',
    label: 'Audit log',
    keywords: 'audit log events history activity security settings',
    path: auditLogSettingsPath,
    adminOnly: true,
  },
];

/** The workspace and personal settings pages the caller may open. */
export const settingsDestinations = (
  workspace: Pick<WorkspaceRead, 'slug' | 'role'>
): PaletteDestination[] => {
  const admin = canManageMembers(workspace.role);
  const rows = SETTINGS.filter((row) => admin || row.adminOnly !== true);
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    keywords: row.keywords,
    to: row.path(workspace.slug),
  }));
};

/** One section of a team's settings page. */
interface TeamSection {
  id: string;
  label: string;
  keywords: string;
}

/**
 * The sections of a team's settings page, by the anchor id the page gives
 * each one. The danger zone is left out, since deleting a team is not
 * something to land on from a search.
 */
const TEAM_SECTIONS: readonly TeamSection[] = [
  {
    id: 'general',
    label: 'General settings',
    keywords: 'team name key prefix icon parent privacy private',
  },
  {
    id: 'members',
    label: 'Members',
    keywords: 'team members people invite roles',
  },
  {
    id: 'workflow',
    label: 'Workflow statuses',
    keywords: 'team workflow statuses states',
  },
  { id: 'labels', label: 'Labels', keywords: 'team labels tags' },
  {
    id: 'templates',
    label: 'Templates',
    keywords: 'team issue templates',
  },
  {
    id: 'recurring',
    label: 'Recurring issues',
    keywords: 'team recurring repeat schedule',
  },
  {
    id: 'cycles',
    label: 'Cycle settings',
    keywords: 'team cycles sprints automatic cooldown',
  },
  {
    id: 'triage',
    label: 'Triage settings',
    keywords: 'team triage intake inbox',
  },
  {
    id: 'sla',
    label: 'SLA settings',
    keywords: 'team sla slas service level agreement breach response time',
  },
  {
    id: 'auto-close',
    label: 'Auto-close settings',
    keywords: 'team auto close autoclose stale',
  },
  {
    id: 'archive',
    label: 'Auto-archive settings',
    keywords: 'team auto archive autoarchive',
  },
  {
    id: 'standup',
    label: 'Standup settings',
    keywords: 'team standup daily async',
  },
  {
    id: 'github',
    label: 'GitHub settings',
    keywords: 'team github repository sync pull requests transitions',
  },
  {
    id: 'releases',
    label: 'Release pipeline',
    keywords: 'team releases pipeline deploy stages',
  },
  {
    id: 'notifications',
    label: 'Notification channels',
    keywords: 'team notifications slack discord channels',
  },
  {
    id: 'webhooks',
    label: 'Webhooks',
    keywords: 'team webhooks outbound http events',
  },
];

/** The sections of one team's settings page, each opening on its anchor. */
export const teamSettingsDestinations = (
  slug: string,
  keyPrefix: string
): PaletteDestination[] =>
  TEAM_SECTIONS.map((section) => ({
    id: section.id,
    label: section.label,
    keywords: `${section.keywords} settings`,
    to: teamSettingsSectionPath(slug, keyPrefix, section.id),
  }));

/**
 * Whether every word of the term appears in one of the texts, case blind, so
 * "team sla" finds a row whose label says SLA and whose keywords say team.
 * Matching is a plain substring per word, deterministic by design.
 */
export const matchesTerm = (
  texts: readonly string[],
  term: string
): boolean => {
  const words = term
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0) return true;
  const haystack = texts.join(' ').toLowerCase();
  return words.every((word) => haystack.includes(word));
};
